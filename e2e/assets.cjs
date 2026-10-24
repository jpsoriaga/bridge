// 1.3.0 against the stand-in chatgpt.com: background processes (START, LOGS, restart, the
// app's panel, errors after an edit in Full auto, stopped with the session and their
// helpers with them), images the chat makes (Save to project, Undo), attaching project
// images (Send files → Attach, and a READ card), downloads (https only, always a click),
// requested files auto-sent in Full auto, Unlimited, the loop guard, and auto-approved
// deletes. See e2e/README.md.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const {
  step,
  SHELL,
  escapeHtml,
  hosts,
  cardText,
  clickInCard,
  waitFor
} = require('./chat-lib.cjs');

const CONV = 'e2e00000-0000-4000-8000-000000000013';
/** One transparent pixel. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// The stand-in page, plus the composer's file input (behind its attach button), which
// records what was attached.
const PAGE = SHELL.replace(
  '</form>',
  '<input type="file" id="upload" accept="image/*" multiple hidden></form>'
).replace(
  '</script>',
  `document.getElementById('upload').addEventListener('change', (e) => {
    window.__attached = (window.__attached || []).concat([...e.target.files].map((f) => f.name + ':' + f.type + ':' + f.size));
  });
</script>`
);

/** An assistant turn: markers as plain lines, optional code blocks and images. */
function reply(id, parts) {
  const body = parts
    .map((part) =>
      part.image
        ? `<img alt="Generated image" width="512" height="512" src="data:image/png;base64,${part.image}">`
        : part.file
          ? `<p><code>@@FILE ${part.file}@@</code></p><pre><code>${escapeHtml(part.content)}</code></pre>`
          : `<p>${escapeHtml(part)}</p>`
    )
    .join('');
  return `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown prose">${body}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

(async () => {
  const base = fs.realpathSync(tempDir('project'));
  const project = path.join(base, 'assets-app');
  const file = (rel) => path.join(project, rel);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  const helperPid = path.join(base, 'helper.pid');
  // A dev server: starts a helper (like vite starting esbuild), serves on a free port, says
  // where, and reports a compile error whenever src/app.ts says "broken".
  write(
    'dev.js',
    [
      "const http = require('node:http');",
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `fs.writeFileSync(${JSON.stringify(helperPid)}, String(helper.pid));`,
      "const server = http.createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () =>",
      "  console.log('  ➜  Local:   http://localhost:' + server.address().port + '/'));",
      'let last = null;',
      'setInterval(() => {',
      "  const s = fs.existsSync('src/app.ts') ? fs.readFileSync('src/app.ts', 'utf8') : '';",
      '  if (s === last) return;',
      '  last = s;',
      "  if (s.includes('broken')) console.error('[dev] Error: Unexpected token in src/app.ts:1:7');",
      "  else console.log('[dev] rebuilt');",
      '}, 100);'
    ].join('\n')
  );
  // A test that fails the same way every time, with a different timing each run.
  write(
    'check.js',
    "console.log('FAIL: expected 2, got 1 (' + Date.now() % 1000 + 'ms)'); process.exit(1);\n"
  );
  write('package.json', '{ "name": "assets-app", "scripts": { "dev": "node dev.js" } }\n');
  write('src/app.ts', 'export const app = 1;\n');
  write('shot.png', Buffer.from(PNG_B64, 'base64'));
  write('old.txt', 'old\n');
  write('.env', 'SECRET=1\n');

  const appData = tempDir('app-data');
  const id = createHash('sha256').update(project).digest('hex').slice(0, 16);
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({
      project,
      recentProjects: [project],
      denyPatterns: [],
      allowlistFormat: 2,
      stepLimitFormat: 2,
      allowlists: { [id]: ['node dev.js', 'node check.js'] },
      backgroundAllowlists: { [id]: ['node dev.js'] }
    })
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.switcher-name').filter({ hasText: 'assets-app' }).waitFor();
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
  await nav('Settings').click();
  const background = win.getByRole('checkbox', { name: 'Run node dev.js in the background' });
  if (!(await background.isChecked())) throw new Error('node dev.js not marked as background');
  if (
    await win.getByRole('checkbox', { name: 'Run node check.js in the background' }).isChecked()
  ) {
    throw new Error('node check.js marked as background');
  }
  step('Settings → Commands: node dev.js runs in the background, node check.js to completion');
  await nav('Session').click();
  // Native dialogs (Full auto, Also approve automatically): answer yes for the test.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });

  const { ctx, extId } = await launchChrome(EXT);
  await ctx.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
  );
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  await win.getByRole('button', { name: 'Pair extension' }).click();
  const code = (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  await enterCode(win, panel, code);
  await panel
    .locator('header .status')
    .filter({ hasText: 'Connected' })
    .waitFor({ timeout: 10000 });
  step('paired');

  const chat = await ctx.newPage();
  const cdp = await ctx.newCDPSession(chat);
  await chat.goto(`https://chatgpt.com/c/${CONV}`);
  await chat.bringToFront();
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage('windowId' in m ? { ...m, windowId: id } : m);
    }, message);
  const composerText = () => chat.locator('#prompt-textarea').innerText();
  const clearComposer = () =>
    chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);
  const sends = () => chat.evaluate(() => window.__sends || []);
  const attached = () => chat.evaluate(() => window.__attached || []);

  await waitFor(
    'session preview',
    async () => (await ask({ type: 'session-preview', windowId: 0 })).ok
  );
  const started = await ask({ type: 'session-start', windowId: 0 });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  const prompt = await composerText();
  if (!prompt.includes('`@@START node dev.js@@`') || !prompt.includes('@@ASSET')) {
    throw new Error('session prompt misses the 1.3.0 rules: ' + prompt.slice(0, 1600));
  }
  if (prompt.includes('Only these are allowed: `node dev.js`')) {
    throw new Error('the dev server is listed as a one-off command');
  }
  step('session prompt: dev servers with START/STOP/LOGS, assets and downloads');
  await clearComposer();

  // 1. START on a click: the card, the app and the side panel show it running at its URL.
  await addTurn(reply('m-start', ['Starting the dev server.', '@@START node dev.js@@']));
  await waitFor('process card', async () =>
    (await cardText(cdp, 'process-card', 0)).includes('Start')
  );
  await clickInCard(chat, cdp, 'process-card', 0, 'Start');
  const url = await waitFor(
    'running at a URL',
    async () => /http:\/\/localhost:\d+\//.exec(await cardText(cdp, 'process-card', 0))?.[0],
    20_000
  );
  step(`START: running at ${url}`);
  const appSection = win
    .locator('section')
    .filter({ has: win.getByRole('heading', { name: 'Background processes' }) });
  await appSection.getByText('node dev.js').waitFor();
  await appSection.getByRole('button', { name: url }).waitFor();
  await panel.getByText('Background processes').waitFor();
  await panel.getByRole('button', { name: url }).waitFor();
  const helper = await waitFor(
    'the helper',
    () => fs.existsSync(helperPid) && Number(fs.readFileSync(helperPid, 'utf8'))
  );
  if (!alive(helper)) throw new Error('helper not running');
  step('the app and the side panel list it, with its URL; its helper runs');

  // 2. LOGS: Send logs puts its last lines in the composer.
  await addTurn(reply('m-logs', ['@@LOGS node dev.js@@']));
  await waitFor('logs card', async () =>
    (await cardText(cdp, 'process-card', 1)).includes('Send logs')
  );
  await clickInCard(chat, cdp, 'process-card', 1, 'Send logs');
  const logs = await waitFor('logs in the composer', async () => {
    const text = await composerText();
    return text.includes('of `node dev.js`') ? text : null;
  });
  if (!logs.includes('Local:')) throw new Error('logs miss the URL line: ' + logs);
  step('LOGS: ' + logs.split('\n')[0]);
  await clearComposer();

  // 3. START again restarts it: still one process.
  await addTurn(reply('m-restart', ['@@START node dev.js@@']));
  await waitFor('restart button', async () =>
    (await cardText(cdp, 'process-card', 2)).includes('Restart')
  );
  await clickInCard(chat, cdp, 'process-card', 2, 'Restart');
  await waitFor('old helper gone', () => !alive(helper), 10_000);
  const running = await waitFor(
    'one running',
    async () => {
      const rows = await appSection.locator('.process-row').count();
      const text = await appSection.innerText();
      return rows === 1 && /Running/.test(text) ? rows : null;
    },
    20_000
  );
  step(`a second START restarted it (${running} process, the old helper is gone)`);

  // 4. An image the chat made: Save to project, prefilled from @@ASSET, then Undo.
  await addTurn(reply('m-image', ['@@ASSET public/hero.png@@', { image: PNG_B64 }]));
  await waitFor('asset card', async () => (await cardText(cdp, 'asset-card', 0)).includes('Save'));
  await clickInCard(chat, cdp, 'asset-card', 0, 'Save');
  await waitFor('saved', () => fs.existsSync(file('public/hero.png')));
  if (!fs.readFileSync(file('public/hero.png')).equals(Buffer.from(PNG_B64, 'base64'))) {
    throw new Error('saved image differs');
  }
  step('Save to project wrote public/hero.png byte for byte');
  await clickInCard(chat, cdp, 'asset-card', 0, 'Undo');
  await waitFor('undone', () => !fs.existsSync(file('public/hero.png')));
  step('Undo removed it');

  // 5. Attach: Send files → Attach, and a READ card for an image.
  const attach = await ask({ type: 'attach-files', windowId: 0, paths: ['shot.png'] });
  if (!attach.ok || attach.attached[0] !== 'shot.png')
    throw new Error('attach: ' + JSON.stringify(attach));
  await waitFor('attached', async () =>
    (await attached()).includes('shot.png:image/png:' + Buffer.from(PNG_B64, 'base64').length)
  );
  step('Send files → Attach put shot.png on the message as a file');
  const refusedAttach = await ask({ type: 'attach-files', windowId: 0, paths: ['src/app.ts'] });
  if (refusedAttach.refused[0]?.code !== 'not-an-image') throw new Error('attached a text file');
  await addTurn(reply('m-read', ['@@READ shot.png@@', '@@READ src/app.ts@@']));
  await waitFor('read card', async () =>
    (await cardText(cdp, 'read-card', 0)).includes('attached')
  );
  await clickInCard(chat, cdp, 'read-card', 0, 'Send these files');
  await waitFor('second attachment', async () => (await attached()).length === 2);
  const readText = await composerText();
  if (
    !readText.includes('Attached image: shot.png.') ||
    !readText.includes('@@CONTEXT src/app.ts@@')
  ) {
    throw new Error('READ text: ' + readText);
  }
  step('a READ card attached the image and inserted the text file');
  await clearComposer();

  // 6. Downloads: https only, never local, always a click.
  await addTurn(
    reply('m-dl', [
      '@@DOWNLOAD http://example.com/logo.png -> public/logo.png@@',
      '@@DOWNLOAD https://127.0.0.1/logo.png -> public/local.png@@'
    ])
  );
  await waitFor('download cards', async () => (await hosts(cdp, 'download-card')).length === 2);
  const http = await cardText(cdp, 'download-card', 0);
  if (!http.includes('blocked') || !http.includes('https://'))
    throw new Error('http download: ' + http);
  await waitFor('local download ready', async () =>
    (await cardText(cdp, 'download-card', 1)).includes('Download')
  );
  await clickInCard(chat, cdp, 'download-card', 1, 'Download');
  await waitFor('refused', async () =>
    (await cardText(cdp, 'download-card', 1)).includes('local network')
  );
  if (fs.existsSync(file('public/local.png'))) throw new Error('downloaded from 127.0.0.1');
  step('downloads: http blocked on the card, 127.0.0.1 refused by the app');

  // 7. Full auto, Unlimited, and deletes approved automatically.
  await nav('Settings').click();
  await win.getByRole('checkbox', { name: 'Unlimited' }).click();
  await win.getByText(/each step uses one of your messages/).waitFor();
  await win.getByRole('checkbox', { name: 'Deletes and renames' }).click();
  await win.getByText(/deletes and moves files the chat names/).waitFor();
  await nav('Session').click();
  await win.getByRole('radio', { name: 'Full auto' }).click();
  await win.getByRole('radio', { name: 'Full auto', checked: true }).waitFor();
  step('Full auto on, Unlimited, deletes and renames approved automatically');

  const sentBefore = (await sends()).length;
  const nextSend = (n, what, timeout = 30_000) =>
    waitFor(
      what,
      async () => {
        const all = await sends();
        return all.length > sentBefore + n ? all[sentBefore + n] : null;
      },
      timeout
    );

  // A reply that only asks for files: they go out on their own; a protected one is refused.
  await addTurn(reply('m-fa1', ['@@READ src/app.ts@@', '@@READ .env@@', '@@READ shot.png@@']));
  const one = await nextSend(0, 'requested files sent on their own');
  if (!one.text.includes('@@CONTEXT src/app.ts@@') || !one.text.includes('.env (protected file)')) {
    throw new Error('first follow-up: ' + one.text);
  }
  if (!one.text.includes('Attached image: shot.png.'))
    throw new Error('image not attached: ' + one.text);
  await waitFor('third attachment', async () => (await attached()).length === 3);
  step('Full auto sent the requested files, attached the image, and said .env was refused');

  // A reply that breaks the build and deletes a file: the dev server's error comes back.
  await addTurn(
    reply('m-fa2', [
      { file: 'src/app.ts', content: 'export const app = broken;\n' },
      '@@DELETE old.txt@@'
    ])
  );
  const two = await nextSend(1, 'errors after the edit');
  if (!two.text.includes('`node dev.js` printed errors after these edits:')) {
    throw new Error('no dev server errors in: ' + two.text);
  }
  if (!two.text.includes('Unexpected token in src/app.ts') || fs.existsSync(file('old.txt'))) {
    throw new Error('second follow-up: ' + two.text);
  }
  step('Full auto applied the edit, deleted old.txt on its own, and sent the dev server’s error');
  await nav('Activity').click();
  await win
    .getByText(/auto-approved/)
    .first()
    .waitFor();
  step('Activity marks the delete auto-approved');
  await nav('Session').click();
  const strip = await win.locator('.loop-strip').innerText();
  if (/Step \d+ of/.test(strip)) throw new Error('Unlimited still shows a limit: ' + strip);

  // The loop guard: the same failure three times pauses the run, Unlimited or not.
  for (let i = 0; i < 3; i += 1) {
    await addTurn(reply(`m-guard-${i}`, ['Trying again.', '@@RUN node check.js@@']));
    if (i < 2) await nextSend(2 + i, `guard step ${i + 1}`);
  }
  await waitFor(
    'paused stuck',
    async () => (await win.locator('.loop-strip').innerText()).includes('Looks stuck'),
    30_000
  );
  step('the same failure three times in a row paused it: "Looks stuck"');
  await ask({ type: 'loop-control', windowId: 0, action: 'stop' });

  // A download pauses Full auto for the user's click, whatever the settings.
  await ask({ type: 'loop-control', windowId: 0, action: 'resume' });
  await addTurn(reply('m-fa-dl', ['@@DOWNLOAD https://example.com/icon.png -> public/icon.png@@']));
  await waitFor(
    'paused for the download',
    async () =>
      (await win.locator('.loop-strip').innerText()).includes('Downloads always need your click'),
    20_000
  );
  step('a download paused Full auto for a click');

  // 8. End session: background processes stop, helpers too.
  await ask({ type: 'session-end', windowId: 0 });
  await waitFor(
    'processes stopped',
    async () => !(await appSection.innerText().catch(() => '')).includes('Running'),
    15_000
  );
  const restartedHelper = Number(fs.readFileSync(helperPid, 'utf8'));
  await waitFor('helper stopped', () => !alive(restartedHelper), 10_000);
  step('End session stopped the dev server and its helper');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
