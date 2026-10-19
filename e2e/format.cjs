// v1.0.1: keeping the chat in Bridge's format. Markers missing their closing @@ still get
// cards (marked "format fixed"); a reply Bridge can't read gets a format card whose button
// inserts the reminder; everything Bridge inserts ends with the format line; Full auto
// sends the reminder itself twice, then pauses with "format issues". Junk files stay out
// of the session prompt.
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

const CONV = 'e2e00000-0000-4000-8000-000000000101';
const FOOTER =
  'Bridge format: @@FILE path@@ + full code block · @@READ path@@ · @@RUN cmd@@ · @@DONE@@. Markers start and end with @@, in backticks.';
const REMINDER =
  "Please redo your last reply using Bridge's exact format: @@FILE path@@ followed by one complete code block, @@READ path@@, @@RUN cmd@@, @@DONE@@. Every marker starts and ends with @@ and is wrapped in backticks.";

/** A finished assistant turn from raw markup (the parts the chat-lib helper can't write). */
const rawTurn = (id, body) =>
  `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown prose">${body}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;
const code = (text) => `<p><code>${escapeHtml(text)}</code></p>`;
const block = (text) => `<pre><code>${escapeHtml(text)}</code></pre>`;
/** A reply that misses the format: a typo'd marker and an unmarked file block. */
const broken = (id) =>
  rawTurn(
    id,
    code('@@RUNS node check.js@@') +
      code('src/greet.ts') +
      block('export const greet = () => "hello";\nexport default greet;\n')
  );

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'format-app');
  const file = (rel) => path.join(project, rel);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  write('src/greet.ts', 'export const greet = () => "hi";\n');
  write('package.json', '{ "name": "format-app", "scripts": { "test": "node check.js" } }\n');
  write('check.js', "console.log('PASS');\n");
  write('.DS_Store', 'junk');
  write('src/Thumbs.db', 'junk');
  write('desktop.ini', 'junk');
  const appData = tempDir('app-data');
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({
      project,
      recentProjects: [project],
      denyPatterns: [],
      onboardingDismissed: true
    })
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.switcher-name').filter({ hasText: 'format-app' }).waitFor();
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
  await nav('Settings').click();
  await win.getByRole('button', { name: /^Allow \d+ commands?$/ }).click();
  await win.getByLabel('Add an allowed command').fill('node check.js');
  await win.getByLabel('Add an allowed command').press('Enter');
  await win.locator('.patterns .mono').filter({ hasText: 'node check.js' }).waitFor();
  await nav('Session').click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  step('allowlist confirmed in the app');

  const { ctx, extId } = await launchChrome(EXT);
  await ctx.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: SHELL })
  );
  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/src/sidepanel/index.html`);
  await win.getByRole('button', { name: 'Pair extension' }).click();
  const pairing = (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  await enterCode(win, panel, pairing);
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
      return chrome.runtime.sendMessage({ ...m, windowId: id });
    }, message);
  const composer = () => chat.locator('#prompt-textarea').innerText();
  const clearComposer = () =>
    chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);
  const sends = () => chat.evaluate(() => window.__sends ?? []);

  // 1. The session prompt: rules first, no junk files in the tree.
  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  const prompt = await composer();
  if (!prompt.includes('Bridge only understands the exact markers below')) {
    throw new Error('not the new session prompt: ' + prompt.slice(0, 200));
  }
  if (prompt.indexOf('RULES') > prompt.indexOf('PROJECT FILES')) throw new Error('tree first');
  if (!prompt.includes('greet.ts') || /DS_Store|Thumbs\.db|desktop\.ini/i.test(prompt)) {
    throw new Error('tree wrong: ' + prompt.slice(prompt.indexOf('PROJECT FILES')));
  }
  if (!prompt.trim().endsWith('Reply with only "Ready." to this message.')) {
    throw new Error('prompt ending: ' + prompt.slice(-80));
  }
  await clearComposer();
  step('session prompt: rules before the tree, no .DS_Store / Thumbs.db / desktop.ini');

  // 2. Markers missing their closing @@ still get cards, marked "format fixed".
  await addTurn(
    rawTurn(
      'a1b2c3d4-0301-4000-8000-000000000301',
      code('@@FILE src/new.ts') + block('export const x = 1;\n') + code('@@RUN node check.js')
    )
  );
  await waitFor('diff card', async () => (await cardText(cdp, 'diff-card', 0)).includes('Apply'));
  const diff = await cardText(cdp, 'diff-card', 0);
  const run = await waitFor('run card', () => cardText(cdp, 'run-card', 0));
  if (!diff.includes('format fixed') || !run.includes('format fixed')) {
    throw new Error(`no "format fixed": ${diff} | ${run}`);
  }
  if ((await hosts(cdp, 'format-card')).length !== 0)
    throw new Error('fixed reply got a format card');
  await clickInCard(chat, cdp, 'diff-card', 0, 'Apply');
  await waitFor('new.ts written', () => fs.existsSync(file('src/new.ts')));
  step(
    '`@@FILE src/new.ts` and `@@RUN node check.js` got cards marked "format fixed"; Apply wrote it'
  );

  // 3. Send output ends with the format line.
  await clickInCard(chat, cdp, 'run-card', 0, 'Run');
  await waitFor('exit 0', async () => (await cardText(cdp, 'run-card', 0)).includes('exit 0'));
  await clickInCard(chat, cdp, 'run-card', 0, 'Send output');
  const output = await waitFor('output inserted', composer);
  if (!output.includes('PASS') || !output.trim().endsWith(FOOTER)) {
    throw new Error('Send output: ' + output);
  }
  await clearComposer();
  step('Send output ends with the format line');

  // 4. A reply Bridge can't read: a format card, and its button inserts the reminder.
  await addTurn(broken('a1b2c3d4-0302-4000-8000-000000000302'));
  await waitFor('format card', async () => (await hosts(cdp, 'format-card')).length === 1);
  const card = await cardText(cdp, 'format-card', 0);
  if (!card.includes('The chat didn’t use Bridge’s format') || /chatgpt|openai/i.test(card)) {
    throw new Error('format card: ' + card);
  }
  if ((await hosts(cdp, 'run-card')).length !== 1) throw new Error('@@RUNS got a RUN card');
  const sentBefore = (await sends()).length;
  await clickInCard(chat, cdp, 'format-card', 0, 'Send format reminder');
  await waitFor('reminder inserted', async () => (await composer()).trim() === REMINDER);
  if ((await sends()).length !== sentBefore) throw new Error('the reminder was sent');
  await clearComposer();
  step('format card: ' + card.split(' Not a')[0] + ' → reminder inserted, not sent');

  // 5. Full auto: two reminders sent on its own, then a pause with "format issues".
  await win.getByRole('radio', { name: 'Full auto' }).click();
  await win.getByRole('radio', { name: 'Full auto', checked: true }).waitFor();
  const base = (await sends()).length;
  for (let i = 0; i < 2; i += 1) {
    await addTurn(broken(`a1b2c3d4-031${i}-4000-8000-00000000031${i}`));
    const sent = await waitFor(
      `reminder ${i + 1} auto-sent`,
      async () => {
        const all = await sends();
        return all.length > base + i ? all[base + i] : null;
      },
      30_000
    );
    if (sent.text.trim() !== REMINDER) throw new Error('auto-sent: ' + sent.text);
    step(`Full auto sent format reminder ${i + 1}`);
  }
  await addTurn(broken('a1b2c3d4-0319-4000-8000-000000000319'));
  await waitFor('paused', async () =>
    (await cardText(cdp, 'loop-chip', 0)).includes('format issues')
  );
  await win.getByText('The chat kept missing Bridge’s format').first().waitFor({ timeout: 10000 });
  await new Promise((r) => setTimeout(r, 4000));
  if ((await sends()).length !== base + 2) throw new Error('a third reminder went out');
  step('third miss: paused with "format issues" on the page and in the app, nothing more sent');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
