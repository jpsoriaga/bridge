// Screenshots for the README: the app and the chat cards, in light and dark, from the real
// app and a production build of the extension on the stand-in chat page. Also the Chrome
// Web Store images: 1280×800 screenshots in both themes and the 440×280 promo tile.
//   node e2e/screenshots.cjs .   → docs/screenshots/*.png, store/screenshots/*.png,
//                                   store/promo-tile-440x280.png
const fs = require('node:fs');
const path = require('node:path');
// The real port range (47821…), since Settings shows the port: quit `pnpm dev` first.
const { ROOT, tempDir, buildExtension, launchApp, launchChrome, enterCode } = require('./lib.cjs');
const EXT = buildExtension({ e2ePorts: false });
const { step, SHELL, assistantTurn, cardText, clickInCard, waitFor } = require('./chat-lib.cjs');

const OUT = path.join(ROOT, 'docs/screenshots');
const STORE = path.join(ROOT, 'store');
const TOKENS = fs.readFileSync(path.join(ROOT, 'packages/shared/src/tokens.css'), 'utf8');
const CONV = 'e2e00000-0000-4000-8000-0000000000ss';

// The stand-in page with a dark variant, so cards can be shown on both.
const PAGE = SHELL.replace(
  '<style>',
  `<style>
  html.dark body { background: #212121; color: #ececec; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 24px 0 120px; }
  form { display: none; }
`
);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const project = path.join(fs.realpathSync(tempDir('project')), 'acme-web');
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), content);
  };
  write('src/greet.ts', 'export function greet(name: string) {\n  return "Hi " + name;\n}\n');
  write('src/legacy.ts', 'export const legacy = true;\n');
  write('src/Header.tsx', 'export const Header = () => null;\n');
  write('package.json', '{ "name": "acme-web", "scripts": { "test": "node -e 0" } }\n');
  const appData = tempDir('app-data');
  fs.writeFileSync(
    path.join(appData, 'settings.json'),
    JSON.stringify({
      project,
      recentProjects: [project],
      denyPatterns: [],
      theme: 'light',
      windowBounds: { x: 80, y: 80, width: 1180, height: 760, maximized: false }
    })
  );

  const { app, win } = await launchApp(appData, { e2ePorts: false });
  const nav = (name) => win.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });
  await win.locator('.switcher-name').filter({ hasText: 'acme-web' }).waitFor();
  await nav('Settings').click();
  await win.getByRole('button', { name: /^Allow \d+ commands?$/ }).click();
  await nav('Session').click();

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

  const chat = await ctx.newPage();
  await chat.setViewportSize({ width: 1000, height: 1100 });
  const cdp = await ctx.newCDPSession(chat);
  await chat.goto(`https://chatgpt.com/c/${CONV}`);
  await chat.bringToFront();
  const ask = (message) =>
    panel.evaluate(async (m) => {
      const { id } = await chrome.windows.getCurrent();
      return chrome.runtime.sendMessage({ ...m, windowId: id });
    }, message);
  await waitFor('chat tab', async () => (await ask({ type: 'session-preview' })).ok);
  await ask({ type: 'session-start' });
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));

  const addTurn = (html) =>
    chat.evaluate((h) => document.querySelector('main').insertAdjacentHTML('beforeend', h), html);
  await addTurn(
    assistantTurn('a1b2c3d4-0901-4000-8000-000000000901', [
      { text: 'I updated the greeting, removed the old module and fixed the file name.' },
      {
        file: 'src/greet.ts',
        content: 'export function greet(name: string) {\n  return `Hello, ${name}!`;\n}\n'
      },
      { delete: 'src/legacy.ts' },
      { rename: 'src/Header.tsx -> src/header.tsx' },
      { run: 'npm test' }
    ])
  );
  await waitFor('cards', async () => (await cardText(cdp, 'diff-card', 0)).includes('Apply'));
  await waitFor('change cards', async () =>
    (await cardText(cdp, 'change-card', 0)).includes('Delete file')
  );
  // Apply the rename so one card shows its applied state.
  await clickInCard(chat, cdp, 'change-card', 1, 'Rename');
  await waitFor('renamed', async () => (await cardText(cdp, 'change-card', 1)).includes('Renamed'));
  await ask({ type: 'send-files', paths: ['src/greet.ts'] });
  await chat.evaluate(() => (document.getElementById('prompt-textarea').textContent = ''));

  for (const theme of ['light', 'dark']) {
    await chat.evaluate((t) => {
      document.documentElement.className = t;
      window.scrollTo(0, 0);
    }, theme);
    await new Promise((r) => setTimeout(r, 300));
    await chat.screenshot({ path: path.join(OUT, `cards-${theme}.png`), fullPage: true });

    await win.evaluate((t) => window.bridge.setTheme(t), theme);
    await new Promise((r) => setTimeout(r, 300));
    await nav('Session').click();
    await win.screenshot({ path: path.join(OUT, `app-session-${theme}.png`) });
    await nav('Activity').click();
    await win.screenshot({ path: path.join(OUT, `app-activity-${theme}.png`) });
    await nav('Settings').click();
    await win.screenshot({ path: path.join(OUT, `app-settings-${theme}.png`) });
    step(`${theme}: app and cards`);
  }

  await panel.setViewportSize({ width: 360, height: 1000 });
  await panel.emulateMedia({ colorScheme: 'light' });
  await panel.reload();
  await panel.locator('header .status').filter({ hasText: 'Connected' }).waitFor();
  await new Promise((r) => setTimeout(r, 800));
  await panel.screenshot({ path: path.join(OUT, 'panel-light.png'), fullPage: true });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.reload();
  await panel.locator('header .status').filter({ hasText: 'Connected' }).waitFor();
  await new Promise((r) => setTimeout(r, 800));
  await panel.screenshot({ path: path.join(OUT, 'panel-dark.png'), fullPage: true });
  step('side panel');

  // Chrome Web Store: 1280×800. The chat with its cards beside the side panel, then the app.
  fs.mkdirSync(path.join(STORE, 'screenshots'), { recursive: true });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
  );
  await chat.setViewportSize({ width: 879, height: 800 });
  await panel.setViewportSize({ width: 400, height: 800 });
  const frame = await ctx.newPage();
  await frame.setViewportSize({ width: 1280, height: 800 });
  const png = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
  for (const theme of ['light', 'dark']) {
    await chat.evaluate((t) => {
      document.documentElement.className = t;
      document.querySelector('pre')?.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -96);
    }, theme);
    await panel.emulateMedia({ colorScheme: theme });
    await panel.reload();
    // The panel follows its window's active tab: the chat, with its session.
    await chat.bringToFront();
    await panel.getByRole('button', { name: 'End session' }).waitFor();
    await new Promise((r) => setTimeout(r, 800));
    const [left, right] = [await chat.screenshot(), await panel.screenshot()];
    await frame.setContent(
      `<style>${TOKENS} :root { color-scheme: ${theme}; } body { margin: 0; display: flex; background: var(--bg); }
        i { width: 1px; background: var(--border); }</style>
       <img src="${png(left)}"><i></i><img src="${png(right)}">`
    );
    await frame.screenshot({ path: path.join(STORE, 'screenshots', `1-chat-${theme}.png`) });

    await win.evaluate((t) => window.bridge.setTheme(t), theme);
    await new Promise((r) => setTimeout(r, 300));
    await nav('Session').click();
    const shot = (name) =>
      win.screenshot({ path: path.join(STORE, 'screenshots', name), scale: 'css' });
    await shot(`2-app-session-${theme}.png`);
    await nav('Activity').click();
    await shot(`3-app-activity-${theme}.png`);
    step(`${theme}: store screenshots`);
  }

  // The promo tile, with the tokens and the Geist fonts from the extension build.
  const font = (file) => fs.readFileSync(path.join(EXT, 'fonts', file)).toString('base64');
  const fonts = `@font-face { font-family: 'Geist Variable'; font-weight: 100 900; src: url(data:font/woff2;base64,${font('geist.woff2')}) format('woff2'); }
    @font-face { font-family: 'Geist Mono Variable'; font-weight: 100 900; src: url(data:font/woff2;base64,${font('geist-mono.woff2')}) format('woff2'); }`;
  const tile = fs
    .readFileSync(path.join(STORE, 'promo-tile.html'), 'utf8')
    .replace('/*FONTS*/', fonts)
    .replace('/*TOKENS*/', TOKENS);
  await frame.setViewportSize({ width: 440, height: 280 });
  await frame.setContent(tile);
  await frame.evaluate(() => document.fonts.ready);
  await frame.screenshot({ path: path.join(STORE, 'promo-tile-440x280.png') });
  step('store promo tile');

  await ctx.close();
  await app.close();
  console.log('E2E OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
