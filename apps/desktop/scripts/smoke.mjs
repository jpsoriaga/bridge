// Smoke test for a packaged app: launch it with a temp userData, wait for its window to
// load, check /health answers on 127.0.0.1 with this version, then quit it.
//
//   node scripts/smoke.mjs dist/mac-arm64/Bridge.app
//   node scripts/smoke.mjs dist/win-unpacked/Bridge.exe
//   node scripts/smoke.mjs dist/Bridge-1.0.0-linux-x86_64.AppImage   (Linux: under xvfb-run)
//
// The app writes `smoke.json` to userData once its window has loaded, but only when
// BRIDGE_SMOKE_TEST=1 (src/main/index.ts). The fuses forbid --inspect, so nothing can
// attach a debugger; the marker file is how the test sees the window.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 90_000;

/** The executable inside a packaged app. */
export function executableOf(app) {
  if (app.endsWith('.app')) return join(app, 'Contents', 'MacOS', basename(app, '.app'));
  return app;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn) {
  const until = Date.now() + TIMEOUT_MS;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function smoke(app) {
  const executable = executableOf(resolve(app));
  if (!existsSync(executable)) throw new Error(`No app at ${executable}`);
  const expected = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version;
  const userData = mkdtempSync(join(tmpdir(), 'bridge-smoke-'));
  const env = { ...process.env, BRIDGE_SMOKE_TEST: '1', APPIMAGE_EXTRACT_AND_RUN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));

  try {
    const marker = join(userData, 'smoke.json');
    const ready = await Promise.race([
      waitFor('the window to load', () => existsSync(marker)),
      exited.then(({ code, signal }) => {
        throw new Error(`The app exited (${signal ?? code}) before its window loaded`);
      })
    ]);
    if (!ready) throw new Error('No window');
    const { port, version, name } = JSON.parse(readFileSync(marker, 'utf8'));
    console.log(`• window loaded, ${name} ${version}, server on 127.0.0.1:${port}`);
    if (version !== expected) throw new Error(`Version ${version}, expected ${expected}`);
    // The app's name is its userData folder's: "Bridge", never the dev package name.
    if (name !== 'Bridge') throw new Error(`App name ${name}, expected Bridge`);
    if (!Number.isInteger(port)) throw new Error('The server did not bind a port');

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const health = await response.json();
    if (!response.ok || health.name !== 'bridge' || health.version !== expected) {
      throw new Error(`/health answered ${response.status} ${JSON.stringify(health)}`);
    }
    if (!Number.isInteger(health.protocol)) throw new Error('/health has no protocol');
    console.log(`• /health: ${JSON.stringify(health)}`);
  } catch (error) {
    if (output.trim()) console.error(output.trim().split('\n').slice(-40).join('\n'));
    throw error;
  } finally {
    stop(child);
    await Promise.race([exited, sleep(10_000)]);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(`SMOKE OK ${app}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apps = process.argv.slice(2);
  if (apps.length === 0) {
    console.error('Usage: node scripts/smoke.mjs <Bridge.app | Bridge.exe | Bridge.AppImage>…');
    process.exit(2);
  }
  try {
    for (const app of apps) await smoke(app);
  } catch (error) {
    console.error(`SMOKE FAILED: ${error.message}`);
    process.exit(1);
  }
}
