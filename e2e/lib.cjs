// Shared launch helpers for the e2e scripts.
const { _electron, chromium } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
const EXT = path.join(ROOT, 'apps/extension/dist');

/** Electron's binary, as the desktop app's own `electron` package reports it. */
const ELECTRON = require(path.join(ROOT, 'apps/desktop/node_modules/electron'));

/** Chrome for Testing from `npx playwright-core install chromium`, or CHROMIUM_PATH. */
const CHROMIUM = process.env.CHROMIUM_PATH || chromium.executablePath();

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `bridge-e2e-${prefix}-`));

async function launchApp(userData) {
  const env = { ...process.env };
  // Some editor terminals set this, which starts Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`],
    env
  });
  const win = await app.firstWindow();
  await win.waitForSelector('.status');
  return { app, win };
}

async function launchChrome(extensionDir = EXT) {
  const ctx = await chromium.launchPersistentContext(tempDir('chrome'), {
    executablePath: CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

module.exports = { ROOT, EXT, tempDir, launchApp, launchChrome };
