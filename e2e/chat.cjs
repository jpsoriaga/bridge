// Phase 4: chat integration against the real app and a production build of the extension.
// chatgpt.com needs a login, so this serves a stand-in page at https://chatgpt.com/ built
// from the saved fixtures (apps/extension/fixtures/chatgpt). The content script runs on it
// as it would on the real site. See e2e/README.md for the manual run on chatgpt.com.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, EXT, tempDir, launchApp, launchChrome } = require('./lib.cjs');

const step = (m) => console.log('•', m);
const FIXTURES = path.join(ROOT, 'apps/extension/fixtures/chatgpt');
const CONV = 'e2e00000-0000-4000-8000-000000000001';

/** The `<article>` turn from a fixture, with its message id replaced if asked. */
function turn(name, messageId) {
  const html = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const article = html.slice(html.indexOf('<article'), html.lastIndexOf('</article>') + 10);
  return messageId
    ? article.replace(/data-message-id="[^"]+"/, `data-message-id="${messageId}"`)
    : article;
}

// A stand-in for the chat page: <main>, and a contenteditable composer whose paste handler
// behaves like ProseMirror's (takes text/plain, prevents the default).
const SHELL = `<!doctype html><html class="light"><head><meta charset="utf-8"><title>Chat</title></head>
<body><main class="relative h-full w-full flex-1"></main>
<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div></form>
<script>
  const composer = document.getElementById('prompt-textarea');
  composer.addEventListener('paste', (event) => {
    event.preventDefault();
    composer.textContent += event.clipboardData.getData('text/plain');
  });
  document.querySelector('form').addEventListener('submit', () => { window.__submitted = true; });
</script></body></html>`;

/** Every node under the page, closed shadow roots included, from CDP. */
async function piercedTree(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return root;
}

function* walk(node) {
  yield node;
  for (const child of node.children ?? []) yield* walk(child);
  for (const shadow of node.shadowRoots ?? []) yield* walk(shadow);
  if (node.contentDocument) yield* walk(node.contentDocument);
}

const attr = (node, name) => {
  const a = node.attributes ?? [];
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
};
function* textNodes(node) {
  if (node.nodeName === 'STYLE') return;
  if (node.nodeType === 3) yield node.nodeValue;
  for (const child of node.children ?? []) yield* textNodes(child);
  for (const shadow of node.shadowRoots ?? []) yield* textNodes(shadow);
}
const textOf = (node) => [...textNodes(node)].join(' ');

/** Card hosts of one kind, in page order. */
async function hosts(cdp, kind) {
  const root = await piercedTree(cdp);
  return [...walk(root)].filter(
    (n) => n.nodeName === 'DIV' && attr(n, 'data-bridge-host') === kind
  );
}

async function cardText(cdp, kind, index) {
  const host = (await hosts(cdp, kind))[index];
  if (!host) throw new Error(`no ${kind} #${index}`);
  return textOf(host).replace(/\s+/g, ' ').trim();
}

/** Clicks a button inside a card (closed shadow root) with a trusted mouse click. */
async function clickInCard(page, cdp, kind, index, label) {
  const host = (await hosts(cdp, kind))[index];
  if (!host) throw new Error(`no ${kind} #${index}`);
  const button = [...walk(host)].find((n) => n.nodeName === 'BUTTON' && textOf(n).trim() === label);
  if (!button) throw new Error(`no "${label}" in ${kind} #${index}: ${textOf(host)}`);
  await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: button.backendNodeId });
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: button.backendNodeId });
  const [x1, y1, , , x3, y3] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

async function waitFor(what, fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : last}`);
}

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'chat-app');
  const file = (rel) => path.join(project, rel);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  write('src/greet.ts', 'export const greet = () => "hi";\n');
  write('pyproject.toml', '[project]\nname = "demo"\n');
  write('.env', 'SECRET=1\n');
  const appData = tempDir('app-data');
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({ project, recentProjects: [project], denyPatterns: [] })
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.project-name').filter({ hasText: 'chat-app' }).waitFor();
  const { ctx, sw, extId } = await launchChrome(EXT);
  await ctx.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: SHELL })
  );

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  await win.getByRole('button', { name: 'Pair extension' }).click();
  const code = (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  await panel.fill('#pair-code', code);
  await panel.getByRole('button', { name: 'Pair' }).click();
  await panel
    .locator('header .status')
    .filter({ hasText: 'Connected' })
    .waitFor({ timeout: 10000 });
  step('paired');

  const chat = await ctx.newPage();
  const cdp = await ctx.newCDPSession(chat);
  await chat.goto('https://chatgpt.com/');
  await chat.bringToFront();
  // Like the real panel, session requests name the panel's window; its active tab is the chat.
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      const withWindow = m.type.startsWith('session-') || m.type === 'send-files';
      return chrome.runtime.sendMessage(withWindow ? { ...m, windowId: id } : m);
    }, message);
  const composerText = () => chat.locator('#prompt-textarea').innerText();
  const clearComposer = () =>
    chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));

  // Start session in a new chat (no id yet).
  const preview = await waitFor('session preview', async () => {
    const p = await ask({ type: 'session-preview' });
    return p.ok ? p : null;
  });
  step(`preview: ${preview.chars} chars, ${preview.shown}/${preview.total} files`);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  const prompt = await composerText();
  if (!prompt.includes('`@@FILE src/app.ts@@`') || !prompt.includes('greet.ts')) {
    throw new Error('session prompt not inserted: ' + prompt.slice(0, 200));
  }
  if (/openai|chatgpt|codex/i.test(prompt)) throw new Error('vendor name in prompt');
  if (await chat.evaluate(() => window.__submitted === true)) throw new Error('form submitted');
  step(`session prompt inserted (${started.chars} chars), not sent`);
  await clearComposer();

  // The new chat gets its id after the first message: the session binds to it.
  await chat.evaluate((id) => history.pushState({}, '', `/c/${id}`), CONV);
  await waitFor('session bound', async () => {
    const { sessions } = await sw.evaluate(() => chrome.storage.local.get('sessions'));
    return sessions?.[CONV] && !sessions[CONV].endedAt;
  });
  step('session bound to /c/' + CONV.slice(0, 8));

  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);

  // A user message with @@FILE in it never gets a card.
  await addTurn(turn('user-message.html'));
  // 1. One edit: apply, then undo.
  await addTurn(turn('single-edit.html'));
  await waitFor('diff card', async () => (await cardText(cdp, 'diff-card', 0)).includes('Apply'));
  const first = await cardText(cdp, 'diff-card', 0);
  step('card: ' + first.slice(0, 90));
  if (!/src\/greet\.ts.*modified/.test(first)) throw new Error('unexpected card: ' + first);
  if ((await hosts(cdp, 'diff-card')).length !== 1) throw new Error('user message got a card');

  // The card fonts come from web_accessible_resources with use_dynamic_url.
  const fonts = await waitFor('card fonts', () =>
    chat.evaluate(async () => {
      await document.fonts.ready;
      const faces = [...document.fonts].filter((f) => f.family.includes('Geist'));
      return faces.length === 2 && faces.every((f) => f.status === 'loaded')
        ? faces.map((f) => f.family).join(', ')
        : null;
    })
  );
  const probe = await chat.evaluate(
    (id) =>
      fetch(`chrome-extension://${id}/fonts/geist.woff2`).then(
        () => 'reachable',
        () => 'blocked'
      ),
    extId
  );
  if (probe !== 'blocked') throw new Error('static font URL is reachable from the page');
  step(`fonts loaded from dynamic URLs: ${fonts}; the static URL is ${probe}`);

  await clickInCard(chat, cdp, 'diff-card', 0, 'Apply');
  await waitFor('applied', () =>
    fs.readFileSync(file('src/greet.ts'), 'utf8').includes('Hello, ${name}')
  );
  await waitFor('applied row', async () =>
    (await cardText(cdp, 'diff-card', 0)).includes('Applied')
  );
  await win
    .getByText(/Modified · via chat/)
    .first()
    .waitFor();
  step('Apply wrote src/greet.ts; desktop activity says "via chat"');

  await clickInCard(chat, cdp, 'diff-card', 0, 'Undo');
  await waitFor('undone', () => fs.readFileSync(file('src/greet.ts'), 'utf8').includes('"hi"'));
  await waitFor('undone row', async () => (await cardText(cdp, 'diff-card', 0)).includes('Undone'));
  step('Undo restored src/greet.ts');

  // 2. Two edits plus a READ request: Apply all, then Send these files.
  await addTurn(turn('multiple-edits.html'));
  await waitFor('apply all', async () =>
    (await cardText(cdp, 'apply-all', 0)).includes('Apply all (2)')
  );
  await clickInCard(chat, cdp, 'apply-all', 0, 'Apply all (2)');
  await waitFor(
    'both written',
    () => fs.existsSync(file('pkg/__init__.py')) && fs.existsSync(file('pkg/client.py'))
  );
  step('Apply all wrote pkg/__init__.py and pkg/client.py');

  await waitFor(
    'read card',
    async () => !(await cardText(cdp, 'read-card', 0)).includes('Reading')
  );
  const read = await cardText(cdp, 'read-card', 0);
  step('READ card: ' + read.slice(0, 120));
  if (!read.includes('blocked · not found')) throw new Error('missing file not marked: ' + read);
  await clickInCard(chat, cdp, 'read-card', 0, 'Send these files');
  const context = await composerText();
  if (!context.includes('`@@CONTEXT pyproject.toml@@`')) throw new Error('context not inserted');
  if (!context.includes('Bridge could not send: tests/test_client.py (not found)')) {
    throw new Error('refused file not listed: ' + context);
  }
  step('Send these files inserted pyproject.toml in @@CONTEXT format, not sent');
  await clearComposer();

  const shots = process.env.E2E_SCREENSHOTS;
  if (shots) {
    await chat.setViewportSize({ width: 900, height: 1400 });
    await chat.screenshot({ path: path.join(shots, 'chat.png'), fullPage: true });
    // The panel shows the active tab's session, so keep the chat tab in front.
    await panel.setViewportSize({ width: 360, height: 1100 });
    await panel.screenshot({ path: path.join(shots, 'panel.png'), fullPage: true });
  }

  // 3. Conflict: the file changes on disk after the card read it.
  await addTurn(turn('single-edit.html', 'a1b2c3d4-0009-4000-8000-000000000009'));
  await waitFor('second card', async () => (await hosts(cdp, 'diff-card')).length === 4);
  await waitFor('second card read', async () =>
    (await cardText(cdp, 'diff-card', 3)).includes('modified')
  );
  write('src/greet.ts', 'export const greet = () => "edited locally";\n');
  await clickInCard(chat, cdp, 'diff-card', 3, 'Apply');
  await waitFor('conflict', async () => (await cardText(cdp, 'diff-card', 3)).includes('conflict'));
  step(
    'conflict: ' + (await cardText(cdp, 'diff-card', 3)).match(/The file was updated[^.]*\./)?.[0]
  );
  if (shots) {
    const [host] = (await hosts(cdp, 'diff-card')).slice(3);
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: host.backendNodeId });
    await chat.screenshot({ path: path.join(shots, 'conflict.png') });
  }
  await clickInCard(chat, cdp, 'diff-card', 3, 'Apply');
  await waitFor('applied over the new base', () =>
    fs.readFileSync(file('src/greet.ts'), 'utf8').includes('Hello, ${name}')
  );
  step('second Apply wrote over the updated file');

  // 4. Reload: the same messages come back with their saved states.
  await chat.reload();
  await addTurn(turn('single-edit.html'));
  await addTurn(turn('multiple-edits.html'));
  await waitFor('restored', async () => {
    const cards = await hosts(cdp, 'diff-card');
    if (cards.length !== 3) return false;
    const texts = await Promise.all([0, 1, 2].map((i) => cardText(cdp, 'diff-card', i)));
    return (
      texts[0].includes('Undone') && texts[1].includes('Applied') && texts[2].includes('Applied')
    );
  });
  step('reload kept Undone / Applied / Applied');
  await waitFor('read card restored', async () =>
    (await cardText(cdp, 'read-card', 0)).includes('Send again')
  );
  step('reload kept the READ card as sent ("Send again")');

  // 5. Regenerate: same message element, new text → cards rebuilt for the new content.
  await chat.evaluate(() => {
    const code = document.querySelector(
      '[data-message-id="a1b2c3d4-0001-4000-8000-000000000001"] pre code'
    );
    code.textContent = 'export const regenerated = true;\n';
  });
  await waitFor('regenerated card', async () =>
    (await cardText(cdp, 'diff-card', 0)).includes('Apply')
  );
  step('regenerated reply got a fresh pending card');

  // 6. End session: cards stay but are disabled, and the worker refuses chat writes.
  await ask({ type: 'session-end' });
  await waitFor('disabled', async () =>
    (await cardText(cdp, 'diff-card', 0)).includes('Session ended')
  );
  step('End session disabled the cards');

  const panelState = await panel.evaluate(
    () =>
      new Promise((resolve) => {
        const port = chrome.runtime.connect({ name: 'sidepanel' });
        port.onMessage.addListener((m) => {
          if (!m.chat.session) return;
          port.disconnect();
          resolve(m.chat);
        });
        void chrome.windows
          .getCurrent()
          .then(({ id }) => port.postMessage({ type: 'panel-window', windowId: id }));
      })
  );
  step('panel state: ' + JSON.stringify(panelState.session));

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
