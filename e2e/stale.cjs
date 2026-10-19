// Stale files in context, through the side panel's own UI: send a file to the chat, edit it
// on disk, see the panel mark it `changed`, click **Resend changed** and find the new
// content in the message box, then see the mark clear.
const fs = require('node:fs');
const path = require('node:path');
const { EXT, tempDir, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const { step, SHELL, waitFor } = require('./chat-lib.cjs');

const CONV = 'e2e00000-0000-4000-8000-000000000007';

(async () => {
  const project = path.join(fs.realpathSync(tempDir('project')), 'stale-app');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const greet = path.join(project, 'src/greet.ts');
  fs.writeFileSync(greet, 'export const greet = () => "hi";\n');
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
  step('paired');

  const chat = await ctx.newPage();
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

  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  const started = await ask({ type: 'session-start' });
  if (!started.ok) throw new Error('session-start: ' + JSON.stringify(started));
  await clearComposer();
  step('session started');

  const sent = await ask({ type: 'send-files', paths: ['src/greet.ts'] });
  if (!sent.ok || sent.sent[0] !== 'src/greet.ts') {
    throw new Error('send-files: ' + JSON.stringify(sent));
  }
  if (!(await composer()).includes('"hi"')) throw new Error('the first send lacks the file');
  await clearComposer();
  const list = panel.getByRole('list', { name: 'Files sent to the chat' });
  const row = list.locator('li').filter({ hasText: 'src/greet.ts' });
  await row.waitFor();
  if ((await row.locator('.tag').count()) !== 0) throw new Error('fresh file already marked');
  step('the panel lists src/greet.ts in context, unmarked');

  fs.writeFileSync(greet, 'export const greet = () => "edited on disk";\n');
  await row.locator('.tag', { hasText: 'changed' }).waitFor({ timeout: 10000 });
  step('edited on disk: the panel marks it `changed`');

  await panel.getByRole('button', { name: 'Resend changed (1)' }).click();
  await waitFor('new content in the composer', async () =>
    (await composer()).includes('edited on disk')
  );
  const text = await composer();
  if (text.includes('"hi"')) throw new Error('Resend changed inserted the old content too');
  if (!text.includes('@@CONTEXT src/greet.ts@@')) throw new Error('not a context block: ' + text);
  step('Resend changed inserted the new content as a context block');

  await row.locator('.tag').waitFor({ state: 'detached', timeout: 10000 });
  if (await panel.getByRole('button', { name: /Resend changed/ }).count()) {
    throw new Error('Resend changed still offered');
  }
  step('the mark cleared and Resend changed is gone');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
