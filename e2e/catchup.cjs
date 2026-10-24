// v1.1.0: the install command and catching up with a cut-off reply. A project with a
// package-lock.json gets `npm install` pre-checked among the suggested commands, and the
// session prompt asks for it after package.json changes. In Full auto, a reply cut off by a
// network error has its whole blocks applied (not the file the cut fell in) and the chat is
// asked to continue once on its own; a second cut in a row pauses with "reply cut off", and
// Resume sends the continuation.
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const {
  step,
  SHELL,
  escapeHtml,
  hosts,
  cardText,
  checkCardButtons,
  waitFor
} = require('./chat-lib.cjs');

const CONV = 'e2e00000-0000-4000-8000-000000000111';

const code = (text) => `<p><code>${escapeHtml(text)}</code></p>`;
const block = (text) => `<pre><code>${escapeHtml(text)}</code></pre>`;
/** An assistant turn cut off by a network error: an error in its turn, no copy button. */
const cutTurn = (id, body) =>
  `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown prose">${body}</div></div><div class="text-token-text-error" role="alert">Network error</div><div><button aria-label="Regenerate response"></button></div></article>`;
const doneTurn = (id) =>
  `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown prose">${code('@@DONE@@')}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'catchup-app');
  const file = (rel) => path.join(project, rel);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  write('package.json', '{ "name": "catchup-app", "scripts": { "test": "node check.js" } }\n');
  write('package-lock.json', '{ "lockfileVersion": 3 }\n');
  write('check.js', "console.log('PASS');\n");
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
  await win.locator('.switcher-name').filter({ hasText: 'catchup-app' }).waitFor();
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
  await nav('Settings').click();

  // 1. `npm install` (from package-lock.json) is suggested and pre-checked, exact.
  const install = win.getByRole('checkbox', { name: 'npm install', exact: true });
  await install.waitFor();
  if (!(await install.isChecked())) throw new Error('npm install is not pre-checked');
  if ((await win.getByRole('checkbox', { name: 'npm install *' }).count()) !== 0) {
    throw new Error('npm install was suggested with *');
  }
  await win.getByRole('button', { name: /^Allow \d+ commands?$/ }).click();
  await win
    .locator('.patterns .mono')
    .filter({ hasText: /^npm install$/ })
    .waitFor();
  const timeout = await win.getByRole('spinbutton', { name: /Install timeout/ }).inputValue();
  if (timeout !== '300') throw new Error('install timeout: ' + timeout);
  const catchUp = win.getByRole('checkbox', { name: 'Catch up automatically after sleep' });
  if (!(await catchUp.isChecked())) throw new Error('catching up is off by default');
  step('npm install pre-checked and allowed exactly; install timeout 300s; catch-up on');

  await nav('Session').click();
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });

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
  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);
  const sends = () => chat.evaluate(() => window.__sends ?? []);

  // 2. The session prompt asks for the install command after package.json changes.
  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  const prompt = await composer();
  if (
    !prompt.includes('After changing package.json, run the install command: `@@RUN npm install@@`')
  ) {
    throw new Error('no install line in the prompt: ' + prompt.slice(0, 900));
  }
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  step('session prompt asks for `@@RUN npm install@@` after package.json changes');

  // The chat's "Ready." reply, with a READ so its card shows the page has been looked at:
  // replies there before that count as history and are never acted on.
  await addTurn(
    `<article data-testid="conversation-turn-r"><div data-message-author-role="assistant" data-message-id="a1b2c3d4-0400-4000-8000-000000000400"><div class="markdown prose"><p>Ready.</p>${code('@@READ check.js@@')}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`
  );
  await waitFor('READ card', async () => (await hosts(cdp, 'read-card')).length === 1);

  // 3. Full auto: a cut-off reply. The whole file is applied, the cut one isn't, and the
  // chat is asked to continue on its own.
  await win.getByRole('radio', { name: 'Full auto' }).click();
  await win.getByRole('radio', { name: 'Full auto', checked: true }).waitFor();
  // The extension hears of the mode over the socket; act only once the page knows.
  await waitFor('Full auto on the page', async () =>
    (await cardText(cdp, 'loop-chip', 0)).includes('Full auto')
  );
  await addTurn(
    cutTurn(
      'a1b2c3d4-0401-4000-8000-000000000401',
      code('@@FILE src/one.ts@@') +
        block('export const one = 1;\n') +
        '<p>And the second:</p>' +
        code('@@FILE src/two.ts@@') +
        block('export const values = [\n  1,\n')
    )
  );
  const first = await waitFor(
    'continuation auto-sent',
    async () => (await sends())[0] ?? null,
    30_000
  );
  for (const expected of [
    'Applied: src/one.ts.',
    'Your last reply was cut off after @@FILE src/one.ts@@.',
    'Resend src/two.ts in full if it was cut off.'
  ]) {
    if (!first.text.includes(expected))
      throw new Error(`follow-up lacks "${expected}": ${first.text}`);
  }
  if (!fs.existsSync(file('src/one.ts')) || fs.existsSync(file('src/two.ts'))) {
    throw new Error('wrong files applied');
  }
  if ((await hosts(cdp, 'interrupt-card')).length !== 1) throw new Error('no interrupted card');
  const card = await cardText(cdp, 'interrupt-card', 0);
  if (!card.includes('src/two.ts was cut off') || /chatgpt|openai/i.test(card)) {
    throw new Error('interrupted card: ' + card);
  }
  step('cut-off reply: src/one.ts applied, src/two.ts not; continuation sent on its own');
  step('card buttons line up: ' + JSON.stringify(await checkCardButtons(cdp)));

  // 4. Cut off again: no second automatic continuation. Pause; Resume sends it.
  await addTurn(
    cutTurn('a1b2c3d4-0402-4000-8000-000000000402', code('@@READ check.js@@') + '<p>Then I will')
  );
  await waitFor('paused', async () =>
    (await cardText(cdp, 'loop-chip', 0)).includes('reply cut off')
  );
  await win
    .getByText('The chat’s reply was interrupted after @@READ check.js@@.')
    .first()
    .waitFor({ timeout: 10000 });
  if ((await sends()).length !== 1) throw new Error('a second continuation went out on its own');
  step('second cut in a row: paused with "reply cut off" on the page and in the app');
  await ask({ type: 'loop-control', action: 'resume' });
  const second = await waitFor('Resume sent it', async () => (await sends())[1] ?? null, 30_000);
  if (!second.text.includes('Your last reply was cut off after @@READ check.js@@.')) {
    throw new Error('Resume sent: ' + second.text);
  }
  if (!second.text.includes('@@CONTEXT check.js@@')) throw new Error('READ not answered');
  step('Resume: the file it asked for and the continuation went out');

  await addTurn(doneTurn('a1b2c3d4-0403-4000-8000-000000000403'));
  await waitFor('run over', async () => / On\b/.test(await cardText(cdp, 'loop-chip', 0)));
  step('a @@DONE@@ reply ends the run');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
