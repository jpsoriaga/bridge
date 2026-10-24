// 1.3.0 live-test fixes, round 2, on a stand-in chatgpt.com: Full auto waits for a "Pasted
// text" chip the page is still processing, presses send again once when a send silently
// fails, and pauses on a message limit with when it resets; the side panel's tip while the
// chat tab is hidden; `@@START` of a task run as a task; a clean exit shown neutral (card,
// side panel, app, Activity) with "Start again" / "Run again"; and closing the chat tab
// mid-run pausing with "The chat tab was closed or unloaded".
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const { step, escapeHtml, cardText, badges, clickInCard, waitFor } = require('./chat-lib.cjs');

const CONV = 'e2e00000-0000-4000-8000-000000000201';
/** Pastes longer than this become a "Pasted text" chip, as the real page does with long ones. */
const CHIP_OVER = 200;
/** How long the stand-in page takes over a chip, keeping send off. */
const CHIP_MS = 3_000;

// The stand-in page, with what the real one does to Bridge's sends: a long paste becomes a
// chip that blocks send while it's processed, a click can be swallowed (`__swallow`), and
// a banner says the message limit is reached.
const PAGE = `<!doctype html><html class="light"><head><meta charset="utf-8"><title>Chat</title>
<style>main { max-width: 760px; margin: 0 auto; }</style></head>
<body><main class="relative h-full w-full flex-1"></main>
<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p><br></p></div>
<button id="send" data-testid="send-button" type="button" aria-label="Send prompt">Send</button></form>
<script>
  const form = document.querySelector('form');
  const composer = document.getElementById('prompt-textarea');
  const send = document.getElementById('send');
  window.__clicks = 0;
  window.__swallow = 0;
  composer.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text.length <= ${CHIP_OVER}) {
      composer.textContent += text;
      return;
    }
    window.__chipAt = Date.now();
    window.__chipText = text;
    form.insertAdjacentHTML('afterbegin', '<div data-testid="file-tile"><span>Pasted text</span><div role="progressbar"></div><button type="button" aria-label="Remove file 1: Pasted text">×</button></div>');
    send.disabled = true;
    setTimeout(() => {
      form.querySelector('[role="progressbar"]')?.remove();
      send.disabled = false;
    }, ${CHIP_MS});
  });
  send.addEventListener('click', () => {
    window.__clicks += 1;
    if (send.disabled) return;
    if (window.__swallow > 0) {
      window.__swallow -= 1;
      return;
    }
    const chip = form.querySelector('[data-testid="file-tile"]');
    const text = chip ? window.__chipText : composer.textContent;
    if (!text.trim()) return;
    window.__sends = (window.__sends || []).concat([{ text, at: Date.now(), chip: !!chip }]);
    composer.textContent = '';
    chip?.remove();
    const main = document.querySelector('main');
    const n = main.querySelectorAll('[data-message-author-role="user"]').length;
    main.insertAdjacentHTML('beforeend', '<article data-testid="conversation-turn-u' + n + '"><div data-message-author-role="user" data-message-id="u-' + n + '"><div class="whitespace-pre-wrap"></div></div></article>');
    main.lastElementChild.querySelector('.whitespace-pre-wrap').textContent = text;
  });
</script></body></html>`;

const rawTurn = (id, body) =>
  `<article data-testid="conversation-turn-${id}"><div data-message-author-role="assistant" data-message-id="${id}"><div class="markdown prose">${body}</div></div><div><button data-testid="copy-turn-action-button" aria-label="Copy"></button></div></article>`;
const code = (text) => `<p><code>${escapeHtml(text)}</code></p>`;

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'send-app');
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  };
  write('package.json', '{ "name": "send-app" }\n');
  // A task that prints enough for a long follow-up, and a "watcher" that ends on its own.
  write('check.js', "for (let i = 0; i < 20; i++) console.log('PASS line ' + i);\n");
  write('once.js', "console.log('built'); setTimeout(() => process.exit(0), 500);\n");
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
      onboardingDismissed: true,
      allowlists: { [id]: ['node check.js', 'node once.js'] },
      backgroundAllowlists: { [id]: ['node once.js'] }
    })
  );

  const { app, win } = await launchApp(appData);
  await win.locator('.switcher-name').filter({ hasText: 'send-app' }).waitFor();
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
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
  const pairing = (await win.locator('.pairing-code').innerText()).replace(/\D/g, '');
  await enterCode(win, panel, pairing);
  await panel
    .locator('header .status')
    .filter({ hasText: 'Connected' })
    .waitFor({ timeout: 10000 });
  step('paired');

  let chat = await ctx.newPage();
  let cdp = await ctx.newCDPSession(chat);
  await chat.goto(`https://chatgpt.com/c/${CONV}`);
  await chat.bringToFront();
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage({ ...m, windowId: id });
    }, message);
  const clearComposer = () =>
    chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);
  const sends = () => chat.evaluate(() => window.__sends ?? []);
  const chip = () => cardText(cdp, 'loop-chip', 0);

  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  await clearComposer();
  step('session started');

  // 1. A background command that exits 0: neutral everywhere, and "Start again".
  await addTurn(rawTurn('a1b2c3d4-0401-4000-8000-000000000401', code('@@START node once.js@@')));
  await waitFor('START card', async () =>
    (await cardText(cdp, 'process-card', 0)).includes('Start')
  );
  await clickInCard(chat, cdp, 'process-card', 0, 'Start');
  await waitFor('exit 0 on the card', async () =>
    (await cardText(cdp, 'process-card', 0)).includes('exit 0')
  );
  const exitBadge = (await badges(cdp, 'process-card', 0)).find((b) => b.text === 'exit 0');
  if (!exitBadge || exitBadge.tone === 'danger') {
    throw new Error('exit 0 badge: ' + JSON.stringify(exitBadge));
  }
  const card = await cardText(cdp, 'process-card', 0);
  if (!card.includes('Start again')) throw new Error('no Start again: ' + card);
  step(`START card after exit 0: badge ${JSON.stringify(exitBadge)}, "Start again"`);
  const panelRow = panel.locator('.process-row').filter({ hasText: 'node once.js' });
  await panelRow.getByText(/Exited/).waitFor();
  const panelTone = await panelRow.locator('.dot').first().getAttribute('data-tone');
  const appRow = win.locator('.process-row').filter({ hasText: 'node once.js' });
  await appRow.getByText('Exited').waitFor();
  const appTone = await appRow.locator('.dot').first().getAttribute('data-tone');
  if (panelTone === 'danger' || appTone === 'danger') {
    throw new Error(`exit 0 dots: panel ${panelTone}, app ${appTone}`);
  }
  await nav('Activity').click();
  const activity = win
    .locator('button, li')
    .filter({ hasText: 'Background · exited (exit 0)' })
    .first();
  await activity.waitFor();
  const activityTone = await activity.locator('.dot').first().getAttribute('data-tone');
  if (activityTone === 'danger') throw new Error('exit 0 red in Activity');
  await nav('Session').click();
  step(`exit 0 neutral: side panel ${panelTone}, app ${appTone}, Activity ${activityTone}`);

  // 2. Full auto. `@@START` of a task runs it as a task; its long follow-up becomes a chip
  // the page processes for 3s, and Bridge sends once it's ready.
  await win.getByRole('radio', { name: 'Full auto' }).click();
  await win.getByRole('radio', { name: 'Full auto', checked: true }).waitFor();
  await addTurn(rawTurn('a1b2c3d4-0402-4000-8000-000000000402', code('@@START node check.js@@')));
  const first = await waitFor('follow-up sent', async () => (await sends())[0], 30_000);
  const chipAt = await chat.evaluate(() => window.__chipAt);
  const clicks = await chat.evaluate(() => window.__clicks);
  if (!first.chip || !first.text.includes('Output of `node check.js` (exit 0')) {
    throw new Error('first send: ' + JSON.stringify(first).slice(0, 300));
  }
  if (first.at - chipAt < 3_000 - 50) throw new Error(`sent ${first.at - chipAt}ms after the chip`);
  const run = await cardText(cdp, 'run-card', 0);
  if (
    !run.includes('node check.js') ||
    !run.includes('format fixed') ||
    !run.includes('Run again')
  ) {
    throw new Error('RUN card: ' + run);
  }
  const runBadge = (await badges(cdp, 'run-card', 0)).find((b) => b.text === 'exit 0');
  if (runBadge?.tone === 'danger') throw new Error('exit 0 red on the RUN card');
  step(
    `@@START node check.js → RUN card (format fixed, exit 0 ${runBadge?.tone}, Run again); chip sent ${first.at - chipAt}ms after it appeared, ${clicks} click(s)`
  );

  // 3. A send the page swallows once: pressed again, sent once.
  await chat.evaluate(() => (window.__swallow = 1));
  const before = await chat.evaluate(() => window.__clicks);
  await addTurn(rawTurn('a1b2c3d4-0403-4000-8000-000000000403', code('@@RUN node check.js@@')));
  const second = await waitFor('retried send', async () => (await sends())[1], 40_000);
  const retries = (await chat.evaluate(() => window.__clicks)) - before;
  if ((await sends()).length !== 2 || retries < 2) {
    throw new Error(`after a swallowed send: ${(await sends()).length} sends, ${retries} clicks`);
  }
  step(`swallowed send pressed again: sent once, ${retries} clicks (${second.text.length} chars)`);

  // 4. The tab hidden while Full auto runs: the side panel's one-time tip.
  // Minimizing the window hides its tabs, as switching away from the tab does.
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await chat
    .waitForFunction(() => document.visibilityState === 'hidden', null, { timeout: 5_000 })
    .catch(() => undefined);
  const hidden = await chat.evaluate(() => document.visibilityState);
  if (hidden === 'hidden') {
    await panel.getByText('Full auto in a background tab').waitFor({ timeout: 10_000 });
    await panel.getByText(/chrome:\/\/settings\/performance/).waitFor();
    await panel.getByRole('button', { name: 'Got it' }).click();
    await panel.getByText('Full auto in a background tab').waitFor({ state: 'detached' });
    step('chat tab hidden: the side panel showed the Memory Saver tip; Got it dismissed it');
  } else {
    step(
      `chat tab reports "${hidden}" with its window minimized (headless Chrome never hides a tab): tip not checked here`
    );
  }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await chat.bringToFront();

  // 5. The message limit: paused with the reason and the reset time, nothing sent.
  await chat.evaluate(() =>
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="alert" id="limit">You’ve reached your message limit. It resets at 4:30 PM.</div>'
    )
  );
  await addTurn(rawTurn('a1b2c3d4-0404-4000-8000-000000000404', code('@@RUN node check.js@@')));
  await waitFor(
    'paused on the limit',
    async () => (await chip()).includes('message limit'),
    30_000
  );
  await win
    .getByText('Message limit reached; resets at 4:30 PM.')
    .first()
    .waitFor({ timeout: 10_000 });
  await panel.getByText('Message limit reached; resets at 4:30 PM.').waitFor({ timeout: 10_000 });
  if ((await sends()).length !== 2) throw new Error('sent past the limit');
  step(
    'limit banner: paused "Message limit reached; resets at 4:30 PM." on the page, the app and the panel'
  );
  // The limit resets: Resume sends.
  await chat.evaluate(() => document.getElementById('limit').remove());
  await panel.getByRole('button', { name: 'Resume' }).click();
  await waitFor('sent after Resume', async () => (await sends()).length === 3, 30_000);
  step('limit gone, Resume: sent');

  // 6. The chat tab closed mid-run: paused, not silently stopped.
  await chat.close();
  await win.getByText('The chat tab was closed or unloaded.').first().waitFor({ timeout: 10_000 });
  step(
    'chat tab closed while waiting for a reply: the app says "The chat tab was closed or unloaded."'
  );
  await win.getByRole('button', { name: 'Stop' }).first().click();
  await win
    .getByText('The chat tab was closed or unloaded.')
    .first()
    .waitFor({ state: 'detached', timeout: 10_000 });
  step('Stop in the app ends it');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
