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

// A stand-in for the chat page: <main>, a contenteditable composer whose paste handler
// behaves like ProseMirror's (takes text/plain, prevents the default), and a send button
// that turns the composer's text into a user turn, as the page does.
const SHELL = `<!doctype html><html class="light"><head><meta charset="utf-8"><title>Chat</title></head>
<body><main class="relative h-full w-full flex-1"></main>
<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div>
<button id="send" data-testid="send-button" type="button" aria-label="Send prompt">Send</button></form>
<script>
  const composer = document.getElementById('prompt-textarea');
  composer.addEventListener('paste', (event) => {
    event.preventDefault();
    composer.textContent += event.clipboardData.getData('text/plain');
  });
  document.querySelector('form').addEventListener('submit', () => { window.__submitted = true; });
  document.getElementById('send').addEventListener('click', () => {
    const text = composer.textContent;
    if (!text.trim()) return;
    window.__sends = (window.__sends || []).concat([{ text, at: Date.now() }]);
    composer.textContent = '';
    const main = document.querySelector('main');
    const n = main.querySelectorAll('[data-message-author-role="user"]').length;
    main.insertAdjacentHTML('beforeend', '<article data-testid="conversation-turn-u' + n + '"><div data-message-author-role="user" data-message-id="u-' + n + '"><div class="whitespace-pre-wrap"></div></div></article>');
    main.lastElementChild.querySelector('.whitespace-pre-wrap').textContent = text;
  });
</script></body></html>`;

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A finished assistant turn in the page's markup, built from markdown-ish parts. */
function assistantTurn(messageId, parts) {
  const body = parts
    .map((part) =>
      part.file
        ? `<p><code>@@FILE ${part.file}@@</code></p><pre><code>${escapeHtml(part.content)}</code></pre>`
        : part.run
          ? `<p><code>@@RUN ${part.run}@@</code></p>`
          : `<p>${escapeHtml(part.text)}</p>`
    )
    .join('');
  return `<article data-testid="conversation-turn-${messageId}"><div data-message-author-role="assistant" data-message-id="${messageId}"><div class="markdown prose">${body}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;
}

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
  write('package.json', '{ "name": "chat-app", "scripts": { "test": "node check.js" } }\n');
  write('src/value.ts', 'export const value = "broken";\n');
  // The "test suite" for Full auto: passes once src/value.ts says fixed.
  write(
    'check.js',
    "const v = require('fs').readFileSync('src/value.ts', 'utf8');\n" +
      "if (v.includes('fixed')) { console.log('PASS'); process.exit(0); }\n" +
      "console.log('FAIL: value is ' + v.trim()); process.exit(1);\n"
  );
  const appData = tempDir('app-data');
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({ project, recentProjects: [project], denyPatterns: [] })
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.project-name').filter({ hasText: 'chat-app' }).waitFor();

  // First open: the app suggests commands from package.json; nothing runs until confirmed.
  await win.getByRole('button', { name: 'Allow 3 commands' }).click();
  await win.getByLabel('Add an allowed command').fill('node check.js');
  await win.getByLabel('Add an allowed command').press('Enter');
  await win.locator('.patterns .mono').filter({ hasText: 'node check.js' }).waitFor();
  const allowed = await win.locator('.patterns .mono').allInnerTexts();
  step(`allowlist confirmed in the app: ${allowed.join(', ')}`);
  // Full auto's confirmation is a native dialog; answer "Turn on Full auto" for the test.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
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
  if (!prompt.includes('`@@RUN pnpm test@@`') || !prompt.includes('- `node check.js`')) {
    throw new Error('allowlist not in prompt: ' + prompt.slice(-600));
  }
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
    (await cardText(cdp, 'message-bar', 0)).includes('Apply all (2)')
  );
  await clickInCard(chat, cdp, 'message-bar', 0, 'Apply all (2)');
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

  // 6. Auto-apply: a new reply's edits are written on their own; a gated file waits.
  await win.getByRole('radio', { name: 'Auto-apply' }).click();
  await win.getByRole('radio', { name: 'Auto-apply', checked: true }).waitFor();
  const cardsBefore = (await hosts(cdp, 'diff-card')).length;
  await addTurn(
    assistantTurn('a1b2c3d4-0101-4000-8000-000000000101', [
      { text: 'Two helpers and a dependency:' },
      { file: 'src/one.ts', content: 'export const one = 1;\n' },
      { file: 'src/two.ts', content: 'export const two = 2;\n' },
      { file: 'package.json', content: '{ "name": "chat-app", "dependencies": { "x": "1" } }\n' }
    ])
  );
  await waitFor(
    'auto-applied',
    () => fs.existsSync(file('src/one.ts')) && fs.existsSync(file('src/two.ts'))
  );
  await waitFor('cards say Auto-applied', async () => {
    const texts = await Promise.all([0, 1].map((i) => cardText(cdp, 'diff-card', cardsBefore + i)));
    return texts.every((t) => t.includes('Auto-applied'));
  });
  const gatedCard = await waitFor('gated card held', async () => {
    const t = await cardText(cdp, 'diff-card', cardsBefore + 2);
    return t.includes('needs your click') ? t : null;
  });
  if (fs.readFileSync(file('package.json'), 'utf8').includes('dependencies')) {
    throw new Error('gated file was auto-applied');
  }
  step(
    'Auto-apply wrote src/one.ts and src/two.ts; package.json waits: ' +
      gatedCard.match(/This file[^.]*\./)?.[0]
  );
  await win
    .getByText(/Created · auto/)
    .first()
    .waitFor();
  step('desktop activity labels them "auto"');
  const bars = await hosts(cdp, 'message-bar');
  await clickInCard(chat, cdp, 'message-bar', bars.length - 1, 'Undo all (2)');
  await waitFor(
    'undone all',
    () => !fs.existsSync(file('src/one.ts')) && !fs.existsSync(file('src/two.ts'))
  );
  step('Undo all removed both auto-applied files');

  // 7. Full auto: turned on in the app (confirmed), then a 2-step run to @@DONE@@.
  await win.getByRole('radio', { name: 'Full auto' }).click();
  await win.getByRole('radio', { name: 'Full auto', checked: true }).waitFor();
  step('Full auto on after the confirmation');
  const sends = () => chat.evaluate(() => window.__sends ?? []);
  const sentBefore = (await sends()).length;
  await addTurn(
    assistantTurn('a1b2c3d4-0201-4000-8000-000000000201', [
      { text: 'Let me check the tests first.' },
      { run: 'node check.js' }
    ])
  );
  const sendOne = await waitFor(
    'first auto-send',
    async () => {
      const all = await sends();
      return all.length > sentBefore ? all[sentBefore] : null;
    },
    30_000
  );
  if (
    !sendOne.text.includes('Output of `node check.js` (exit 1') ||
    !sendOne.text.includes('FAIL: value is')
  ) {
    throw new Error('unexpected first follow-up: ' + sendOne.text);
  }
  step('step 1 sent the failing output: ' + sendOne.text.split('\n')[0]);
  // The chip shows the step counter on the page.
  await waitFor('chip', async () => (await cardText(cdp, 'loop-chip', 0)).includes('1 / 10'));
  step('page chip: ' + (await cardText(cdp, 'loop-chip', 0)));

  // The next reply comes back at once; the loop still waits 3s before its next send.
  await addTurn(
    assistantTurn('a1b2c3d4-0202-4000-8000-000000000202', [
      { text: 'Fixing the value.' },
      { file: 'src/value.ts', content: 'export const value = "fixed";\n' },
      { run: 'node check.js' }
    ])
  );
  const sendTwo = await waitFor(
    'second auto-send (diagnostics on failure)',
    async () => {
      const all = await sends();
      return all.length > sentBefore + 1 ? all[sentBefore + 1] : null;
    },
    30_000
  ).catch(async (error) => {
    const chip = await cardText(cdp, 'loop-chip', 0).catch(() => '(no chip)');
    const runs = await Promise.all(
      (await hosts(cdp, 'run-card')).map((_, i) => cardText(cdp, 'run-card', i))
    );
    console.error('chip:', chip);
    console.error('run cards:', runs.slice(-2));
    console.error('value.ts:', fs.readFileSync(file('src/value.ts'), 'utf8'));
    throw error;
  });
  if (!fs.readFileSync(file('src/value.ts'), 'utf8').includes('fixed')) {
    throw new Error('Full auto did not apply the edit');
  }
  if (!sendTwo.text.includes('Applied: src/value.ts.') || !sendTwo.text.includes('(exit 0')) {
    throw new Error('unexpected second follow-up: ' + sendTwo.text);
  }
  const gap = sendTwo.at - sendOne.at;
  if (gap < 3000) throw new Error(`auto-sends only ${gap}ms apart`);
  step(`step 2 applied the fix and sent the passing output, ${gap}ms after step 1`);

  await addTurn(
    assistantTurn('a1b2c3d4-0203-4000-8000-000000000203', [
      { text: 'The tests pass.' },
      { text: '@@DONE@@' }
    ])
  );
  await win.getByText('The chat said it’s done.').first().waitFor({ timeout: 10_000 });
  if ((await sends()).length !== sentBefore + 2) throw new Error('sent after @@DONE@@');
  const loopRows = await win.locator('.activity-group').first().innerText();
  step(
    '@@DONE@@ ended the run; app activity groups it: ' +
      loopRows.split('\n').slice(0, 2).join(' | ')
  );

  if (shots) {
    await chat.screenshot({ path: path.join(shots, 'full-auto.png'), fullPage: true });
    await panel.setViewportSize({ width: 360, height: 1100 });
    await panel.screenshot({ path: path.join(shots, 'panel-full-auto.png'), fullPage: true });
    await win.screenshot({ path: path.join(shots, 'app.png'), fullPage: true });
  }

  // 8. End session: cards stay but are disabled, and the worker refuses chat writes.
  await ask({ type: 'session-end' });
  await waitFor('disabled', async () =>
    (await cardText(cdp, 'diff-card', 0)).includes('Session ended')
  );
  step('End session disabled the cards');
  await win.getByRole('radio', { name: 'Manual', checked: true }).waitFor();
  step('End session turned Full auto back to Manual in the app');

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
