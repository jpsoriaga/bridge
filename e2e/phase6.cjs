// Phase 6 against the real app and a production build of the extension, on the stand-in
// chatgpt.com from chat-lib.cjs: the first-run checklist, delete and rename with undo (never
// automatic), stale files in context with Resend changed, a session moving between tabs,
// and the extension reloading under an open chat.
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome } = require('./lib.cjs');
const {
  step,
  SHELL,
  assistantTurn,
  hosts,
  cardText,
  clickInCard,
  waitFor,
  panelChat
} = require('./chat-lib.cjs');

const CONV = 'e2e00000-0000-4000-8000-000000000006';

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'phase6-app');
  const file = (rel) => path.join(project, rel);
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
    fs.writeFileSync(file(rel), content);
  };
  write('src/old.ts', 'export const old = true;\n');
  write('src/App.tsx', 'export const App = () => null;\n');
  write('src/greet.ts', 'export const greet = () => "hi";\n');
  write('package.json', '{ "name": "phase6-app", "scripts": { "test": "node -e 0" } }\n');
  const appData = tempDir('app-data');
  // A fresh userData apart from the open project: the checklist shows.
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({ project, recentProjects: [project], denyPatterns: [] })
  );

  const { app, win } = await launchApp(appData);
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
  await win.locator('.switcher-name').filter({ hasText: 'phase6-app' }).waitFor();
  await win.getByRole('heading', { name: 'Get started' }).waitFor();
  await win.getByText('1 of 4 done').waitFor();
  step('first run: the checklist shows, with the open project ticked (1 of 4)');

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
  await win.getByText('2 of 4 done').waitFor();
  step('paired: 2 of 4');

  await win.getByRole('button', { name: 'Commands', exact: true }).click();
  await win.getByRole('button', { name: /^Allow \d+ commands?$/ }).click();
  await nav('Session').click();
  await win.getByText('3 of 4 done').waitFor();
  step('commands confirmed from the checklist: 3 of 4');

  const chat = await ctx.newPage();
  const cdp = await ctx.newCDPSession(chat);
  await chat.goto(`https://chatgpt.com/c/${CONV}`);
  await chat.bringToFront();
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage({ ...m, windowId: id });
    }, message);
  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  const prompt = await chat.locator('#prompt-textarea').innerText();
  if (
    !prompt.includes('`@@DELETE src/old.ts@@`') ||
    !prompt.includes('`@@RENAME src/a.ts -> src/b.ts@@`')
  ) {
    throw new Error('session prompt lacks delete/rename: ' + prompt.slice(0, 300));
  }
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  await win.getByRole('heading', { name: 'You’re set up' }).waitFor();
  step('session started: the checklist says you’re set up; the prompt teaches DELETE and RENAME');
  await win.getByRole('button', { name: 'Done' }).click();
  await win
    .getByRole('heading', { name: 'Get started' })
    .waitFor({ state: 'detached' })
    .catch(() => undefined);

  const addTurn = (html, page = chat) =>
    page.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);

  // 1. Delete and rename: never automatic, even in Auto-apply; a click does it; undo reverts.
  await win.getByRole('radio', { name: 'Auto-apply' }).click();
  await win.getByRole('radio', { name: 'Auto-apply', checked: true }).waitFor();
  await addTurn(
    assistantTurn('a1b2c3d4-0601-4000-8000-000000000601', [
      { text: 'Cleaning up:' },
      { delete: 'src/old.ts' },
      { rename: 'src/App.tsx -> src/app.tsx' }
    ])
  );
  await waitFor('change cards', async () => (await hosts(cdp, 'change-card')).length === 2);
  await waitFor('delete card checked', async () =>
    (await cardText(cdp, 'change-card', 0)).includes('Delete file')
  );
  await new Promise((r) => setTimeout(r, 1500));
  if (!fs.existsSync(file('src/old.ts'))) throw new Error('Auto-apply deleted a file');
  step('DELETE card: ' + (await cardText(cdp, 'change-card', 0)).slice(0, 110));
  step('RENAME card: ' + (await cardText(cdp, 'change-card', 1)).slice(0, 110));

  await clickInCard(chat, cdp, 'change-card', 0, 'Delete file');
  await waitFor('deleted', () => !fs.existsSync(file('src/old.ts')));
  await waitFor('deleted row', async () =>
    (await cardText(cdp, 'change-card', 0)).includes('Deleted')
  );
  await win
    .getByText(/Deleted · via chat/)
    .first()
    .waitFor();
  step('Delete file removed src/old.ts; the app logs it');
  await clickInCard(chat, cdp, 'change-card', 0, 'Undo');
  await waitFor('restored', () => fs.existsSync(file('src/old.ts')));
  step('Undo put src/old.ts back: ' + fs.readFileSync(file('src/old.ts'), 'utf8').trim());

  await clickInCard(chat, cdp, 'change-card', 1, 'Rename');
  await waitFor('renamed', () => fs.readdirSync(file('src')).includes('app.tsx'));
  if (fs.readdirSync(file('src')).includes('App.tsx')) throw new Error('old name left behind');
  step('case-only rename App.tsx → app.tsx: ' + fs.readdirSync(file('src')).join(', '));
  await clickInCard(chat, cdp, 'change-card', 1, 'Undo');
  await waitFor('rename undone', () => fs.readdirSync(file('src')).includes('App.tsx'));
  step('Undo moved it back: ' + fs.readdirSync(file('src')).join(', '));

  await nav('Activity').click();
  await win.getByRole('button', { name: 'Deletes', exact: true }).click();
  await win.getByRole('button', { name: /^src\/old\.ts, Deleted/ }).click();
  await win.getByRole('region', { name: 'Changes' }).waitFor();
  step('Activity filters to deletes and shows the deleted file as a diff');
  await win.getByRole('button', { name: 'Back to activity' }).click();
  await nav('Session').click();
  await win.getByRole('radio', { name: 'Manual' }).click();

  // 2. Stale files in context, and Resend changed.
  const sent = await ask({ type: 'send-files', paths: ['src/greet.ts'] });
  if (!sent.ok || sent.sent.length !== 1) throw new Error('send-files: ' + JSON.stringify(sent));
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  const state = await panelChat(panel);
  step('in context: ' + JSON.stringify(state.session.context));
  write('src/greet.ts', 'export const greet = () => "changed on disk";\n');
  await waitFor('stale', async () => {
    const s = await panelChat(panel);
    return s.session.context.find((f) => f.path === 'src/greet.ts')?.stale ? s : null;
  });
  step('the watcher noticed: src/greet.ts is stale');
  const resent = await ask({ type: 'context-resend' });
  if (!resent.ok || resent.sent[0] !== 'src/greet.ts')
    throw new Error('resend: ' + JSON.stringify(resent));
  const composer = await chat.locator('#prompt-textarea').innerText();
  if (!composer.includes('changed on disk')) throw new Error('resend inserted the old file');
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));
  await waitFor('fresh again', async () => {
    const s = await panelChat(panel);
    return s.session.context.find((f) => f.path === 'src/greet.ts')?.stale === false;
  });
  step('Resend changed put the new version in the message box; it’s fresh again');

  // 3. A second tab on the same conversation: the session stays in the first.
  const other = await ctx.newPage();
  const otherCdp = await ctx.newCDPSession(other);
  await other.goto(`https://chatgpt.com/c/${CONV}`);
  await other.bringToFront();
  await waitFor('notice in the second tab', async () =>
    ((await hosts(otherCdp, 'page-notice'))[0]
      ? await cardText(otherCdp, 'page-notice', 0)
      : ''
    ).includes('active in another tab')
  );
  step('second tab: ' + (await cardText(otherCdp, 'page-notice', 0)));
  await addTurn(
    assistantTurn('a1b2c3d4-0602-4000-8000-000000000602', [
      { file: 'src/greet.ts', content: 'export const greet = () => "from tab 2";\n' }
    ]),
    other
  );
  await new Promise((r) => setTimeout(r, 1000));
  if ((await hosts(otherCdp, 'diff-card')).length !== 0) throw new Error('second tab got cards');
  await clickInCard(other, otherCdp, 'page-notice', 0, 'Move here');
  await waitFor(
    'cards in the second tab',
    async () => (await hosts(otherCdp, 'diff-card')).length === 1
  );
  await waitFor('notice moved to the first tab', async () =>
    ((await hosts(cdp, 'page-notice'))[0] ? await cardText(cdp, 'page-notice', 0) : '').includes(
      'active in another tab'
    )
  );
  step('Move here: the second tab has the session and its cards; the first tab says so');

  // 4. The extension reloads mid-session: the page drops Bridge's UI and asks for a reload.
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
  await waitFor(
    'reload notice',
    async () => {
      const notice = (await hosts(otherCdp, 'page-notice'))[0];
      const text = notice ? await cardText(otherCdp, 'page-notice', 0) : '';
      return text.includes('Reload the page') && (await hosts(otherCdp, 'diff-card')).length === 0;
    },
    15_000
  );
  step('extension reloaded: cards gone, notice: ' + (await cardText(otherCdp, 'page-notice', 0)));

  if (process.env.E2E_SCREENSHOTS) {
    await win.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, 'app-phase6.png') });
  }
  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
