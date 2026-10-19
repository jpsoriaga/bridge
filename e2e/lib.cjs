// Shared launch helpers for the e2e scripts.
//
// The scripts keep clear of a `pnpm dev` app running at the same time: the app gets a temp
// userData and BRIDGE_E2E=1 (a dev build then listens on E2E_PORT.., not 47821..), and the
// extension is built for that range into a temp folder.
const { execFileSync } = require('node:child_process');
const { _electron, chromium } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] ?? path.join(__dirname, '..'));
/** First port of the e2e range (E2E_PORT in packages/shared/src/protocol.ts). */
const E2E_PORT = 47921;

/** Electron's binary, as the desktop app's own `electron` package reports it. */
const ELECTRON = require(path.join(ROOT, 'apps/desktop/node_modules/electron'));

/** Chrome for Testing from `npx playwright-core install chromium`, or CHROMIUM_PATH. */
const CHROMIUM = process.env.CHROMIUM_PATH || chromium.executablePath();

const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `bridge-e2e-${prefix}-`));

/**
 * Builds the extension for the e2e port range into a temp folder and returns it. `dev`:
 * a development build (the side panel's file tester). Production otherwise, like the release.
 */
function buildExtension({ dev = false } = {}) {
  const outDir = tempDir(dev ? 'ext-dev' : 'ext');
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@bridge/extension',
      'exec',
      'vite',
      'build',
      ...(dev ? ['--mode', 'development'] : []),
      '--outDir',
      outDir,
      '--emptyOutDir'
    ],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, BRIDGE_E2E: '1' },
      shell: process.platform === 'win32'
    }
  );
  return outDir;
}

let builtExtension = null;
/** The production extension for the e2e range, built once per script. */
function extension() {
  builtExtension ??= buildExtension();
  return builtExtension;
}

async function launchApp(userData) {
  const env = { ...process.env, BRIDGE_E2E: '1' };
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

async function launchChrome(extensionDir = extension()) {
  const ctx = await chromium.launchPersistentContext(tempDir('chrome'), {
    executablePath: CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

/**
 * Types `code` into the side panel and, once both sides show a fingerprint, checks they're
 * the same and confirms it in the app, then in the panel. Returns the fingerprint.
 */
async function enterCode(win, panel, code) {
  await panel.fill('#pair-code', code);
  await panel.getByRole('button', { name: 'Pair' }).click();
  const fingerprint = (await panel.locator('.pairing-fingerprint').innerText()).trim();
  const app = (await win.locator('.pairing-code').innerText()).trim();
  if (fingerprint !== app) throw new Error(`fingerprints differ: panel ${fingerprint}, app ${app}`);
  await win.getByRole('button', { name: 'They match' }).click();
  await win.getByText(/Now confirm it in the side panel/).waitFor();
  await panel.getByRole('button', { name: 'They match' }).click();
  return fingerprint;
}

module.exports = {
  ROOT,
  E2E_PORT,
  tempDir,
  buildExtension,
  launchApp,
  launchChrome,
  enterCode
};
// `EXT` builds on first use, so a script that doesn't need it doesn't wait for a build.
Object.defineProperty(module.exports, 'EXT', { enumerable: true, get: extension });
