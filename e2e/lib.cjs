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

// Every script runs under a hard timeout: when it fires, the app and Chrome are killed and
// the script fails with its name, so a hang never eats the CI job's whole budget. Seconds,
// 8× or more what a run takes; E2E_TIMEOUT (seconds) overrides it. The e2e job's
// `timeout-minutes` in ci.yml stays above their sum plus install and build.
const HARD_TIMEOUT_S = { 'assets.cjs': 300, 'send.cjs': 240, 'chat.cjs': 180 };
const DEFAULT_TIMEOUT_S = 120;
const SCRIPT = `e2e/${path.basename(require.main?.filename ?? 'unknown')}`;
const started = Date.now();
/** What the scripts launched: Electron child processes and Chrome profile folders. */
const launched = { apps: new Set(), profiles: new Set() };

function killLaunched() {
  for (const child of launched.apps) {
    try {
      // Playwright starts it as a process group leader (not on Windows): take its helpers too.
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  // A persistent context has no `browser()` to kill; its profile folder names it.
  // On Windows, Playwright's own exit handler kills it.
  if (process.platform !== 'win32') {
    for (const profile of launched.profiles) {
      try {
        execFileSync('pkill', ['-KILL', '-f', profile], { stdio: 'ignore' });
      } catch {
        // None left.
      }
    }
  }
}

const timeoutS =
  Number(process.env.E2E_TIMEOUT) || (HARD_TIMEOUT_S[path.basename(SCRIPT)] ?? DEFAULT_TIMEOUT_S);
console.log(`▶ ${SCRIPT} started ${new Date(started).toISOString()} (hard timeout ${timeoutS}s)`);
setTimeout(() => {
  console.error(`✗ ${SCRIPT} timed out after ${timeoutS}s; killing the app and Chrome`);
  killLaunched();
  process.exit(1);
}, timeoutS * 1000).unref();
process.on('exit', (code) => {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `■ ${SCRIPT} ${code === 0 ? 'passed' : 'failed'}: started ${new Date(started).toISOString()}, ended ${new Date().toISOString()}, ${seconds}s`
  );
});

/**
 * Builds the extension for the e2e port range into a temp folder and returns it. `dev`:
 * a development build (the side panel's file tester). Production otherwise, like the release.
 */
function buildExtension({ dev = false, e2ePorts = true } = {}) {
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
      env: { ...process.env, BRIDGE_E2E: e2ePorts ? '1' : '' },
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

/** `e2ePorts: false` uses the real range (47821…), e.g. for screenshots that show the port. */
async function launchApp(userData, { e2ePorts = true } = {}) {
  const env = { ...process.env, BRIDGE_E2E: e2ePorts ? '1' : '' };
  // Some editor terminals set this, which starts Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [path.join(ROOT, 'apps/desktop'), `--user-data-dir=${userData}`],
    env
  });
  launched.apps.add(app.process());
  const win = await app.firstWindow();
  await win.waitForSelector('.status');
  return { app, win };
}

async function launchChrome(extensionDir = extension()) {
  const profile = tempDir('chrome');
  launched.profiles.add(profile);
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  return { ctx, sw, extId: new URL(sw.url()).host };
}

/**
 * Types `code` into the side panel and, once both sides show a fingerprint, checks they're
 * the same and confirms it in the app, then in the panel. `atFingerprint` runs while both
 * show it. Returns the fingerprint.
 */
async function enterCode(win, panel, code, atFingerprint) {
  await panel.fill('#pair-code', code);
  await panel.getByRole('button', { name: 'Pair' }).click();
  const fingerprint = (await panel.locator('.pairing-fingerprint').innerText()).trim();
  const app = (await win.locator('.pairing-code').innerText()).trim();
  if (fingerprint !== app) throw new Error(`fingerprints differ: panel ${fingerprint}, app ${app}`);
  if (atFingerprint) await atFingerprint();
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
