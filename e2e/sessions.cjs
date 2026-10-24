// Sessions across client-side navigation, on the stand-in chatgpt.com: a session in chat A,
// then New chat (`/`) and Start session again, then another chat, each time inserting the
// prompt; leaving a chat ends the session it had. Then New chat as the real page does it,
// three times: a new composer, the old one kept but hidden, and Start session after End.
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const { step, SHELL, waitFor, panelChat } = require('./chat-lib.cjs');

const A = 'e2e00000-0000-4000-8000-00000000000a';
const B = 'e2e00000-0000-4000-8000-00000000000b';
const C = 'e2e00000-0000-4000-8000-00000000000c';
const chatId = (n) => `e2e00000-0000-4000-8000-00000000010${n}`;

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'nav-app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'a.ts'), 'export const a = 1;\n');
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
  const { ctx, extId } = await launchChrome(EXT);
  await ctx.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: SHELL })
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

  const chat = await ctx.newPage();
  await chat.goto(`https://chatgpt.com/c/${A}`);
  await chat.bringToFront();
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage({ ...m, windowId: id });
    }, message);
  // The composer the user sees: after a New chat the page may keep the old one, hidden.
  const composer = () => chat.locator('#prompt-textarea:visible').innerText();
  const clearComposer = () =>
    chat.evaluate(() => {
      for (const el of document.querySelectorAll('#prompt-textarea')) el.textContent = '';
    });
  /** Client-side navigation, as the chat page does it. */
  const navigate = (url) => chat.evaluate((u) => history.pushState({}, '', u), url);
  const start = async (where) => {
    const started = await ask({ type: 'session-start' });
    if (!started.ok) throw new Error(`session-start in ${where}: ${JSON.stringify(started)}`);
    if (!(await composer()).includes('@@FILE')) throw new Error(`no prompt inserted in ${where}`);
    await clearComposer();
  };

  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  await start('chat A');
  step('session started in chat A');

  // New chat, and Start session at once: no waiting for the poll.
  await navigate('/');
  await start('a new chat');
  let state = await panelChat(panel);
  if (state.session.state !== 'active' || state.session.conversationId !== null) {
    throw new Error('new chat session: ' + JSON.stringify(state.session));
  }
  step('New chat: Start session inserted the prompt; the session waits for the first message');

  // The first message gives the chat its id: the waiting session binds to it.
  await navigate(`/c/${B}`);
  await waitFor('bound to B', async () => (await panelChat(panel)).session.conversationId === B);
  step('the new chat got its id and the session bound to it');

  // Chat A's session ended when the tab left it.
  await navigate(`/c/${A}`);
  await waitFor('A ended', async () => {
    const s = await panelChat(panel);
    return s.session.conversationId === A && s.session.state === 'ended' ? s : null;
  });
  step('back in chat A: its session is ended');

  // Another existing chat: Start session there inserts the prompt too.
  await navigate(`/c/${C}`);
  await start('chat C');
  await waitFor('C active', async () => {
    const s = await panelChat(panel);
    return s.session.conversationId === C && s.session.state === 'active';
  });
  await navigate(`/c/${B}`);
  await waitFor('B ended', async () => (await panelChat(panel)).session.state === 'ended');
  step('chat A → chat C: Start session inserted the prompt; B had ended when the tab left it');

  // New chat as the real page does it: the composer is replaced, the old one stays mounted
  // but hidden (its paste handler still takes text), and the URL goes to `/` with no reload.
  const newChat = () =>
    chat.evaluate(() => {
      for (const form of document.querySelectorAll('form')) form.style.display = 'none';
      const form = document.createElement('form');
      const editor = document.createElement('div');
      editor.id = 'prompt-textarea';
      editor.contentEditable = 'true';
      editor.className = 'ProseMirror';
      editor.addEventListener('paste', (event) => {
        event.preventDefault();
        editor.textContent += event.clipboardData.getData('text/plain');
      });
      form.append(editor);
      document.body.append(form);
      history.pushState({}, '', '/');
    });
  const hiddenText = () =>
    chat.evaluate(() =>
      [...document.querySelectorAll('#prompt-textarea')]
        .filter((el) => !el.checkVisibility())
        .map((el) => el.textContent)
        .join('')
    );
  for (let n = 1; n <= 3; n += 1) {
    await navigate(`/c/${chatId(n)}`);
    await waitFor(
      `chat ${n}`,
      async () => (await panelChat(panel, true)).tab?.conversationId === chatId(n)
    );
    await newChat();
    if (await hiddenText()) throw new Error('the hidden composer had text before Start');
    await start(`New chat #${n}`);
    if (await hiddenText())
      throw new Error(`New chat #${n}: the prompt went into the hidden composer`);
    state = await panelChat(panel);
    if (state.session.state !== 'active' || state.session.conversationId !== null) {
      throw new Error(`New chat #${n}: ` + JSON.stringify(state.session));
    }
    await ask({ type: 'session-end' });
    await waitFor(`ended #${n}`, async () => (await panelChat(panel, true)).session === null);
  }
  step('New chat with a replaced composer, 3 times with End session between: inserted every time');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
