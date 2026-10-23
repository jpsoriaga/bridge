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
//
// Pass or fail, the whole process tree goes when it's done (an AppImage's runtime and
// Electron's helpers outlive a plain kill and hold its output pipes open), and the script
// exits. Nothing runs longer than HARD_TIMEOUT_MS.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 90_000;
// The tests shorten it with BRIDGE_SMOKE_HARD_TIMEOUT_MS.
const HARD_TIMEOUT_MS = Number(process.env.BRIDGE_SMOKE_HARD_TIMEOUT_MS) || 180_000;
const POSIX = process.platform !== 'win32';

/** The app being tested, for the hard timeout to kill. */
let running = null;

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

/** Signals the app's process group (POSIX: it was spawned detached) or tree (Windows). */
function killTree(child, signal) {
  if (child.pid === undefined) return;
  if (POSIX) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // The group is already gone.
    }
  } else {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  }
}

/** SIGTERM, up to 5s to exit, then SIGKILL for whatever is left in the group. */
async function stop(child, exited) {
  killTree(child, 'SIGTERM');
  await Promise.race([exited, sleep(5_000)]);
  if (POSIX) killTree(child, 'SIGKILL');
}

/** Exits once stdout and stderr have drained (pipes are asynchronous on macOS). */
function exit(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  setTimeout(() => process.exit(code), 2_000).unref();
}

async function smoke(app) {
  const executable = executableOf(resolve(app));
  if (!existsSync(executable)) throw new Error(`No app at ${executable}`);
  const expected = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version;
  const userData = mkdtempSync(join(tmpdir(), 'bridge-smoke-'));
  const env = { ...process.env, BRIDGE_SMOKE_TEST: '1', APPIMAGE_EXTRACT_AND_RUN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  // Its own process group on POSIX, so stop() reaches everything it starts.
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    env,
    detached: POSIX,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  running = child;
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
    await stop(child, exited);
    running = null;
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
  setTimeout(() => {
    console.error(`SMOKE FAILED: still running after ${HARD_TIMEOUT_MS / 1000}s`);
    if (running) killTree(running, 'SIGKILL');
    exit(1);
  }, HARD_TIMEOUT_MS).unref();
  try {
    for (const app of apps) await smoke(app);
    exit(0);
  } catch (error) {
    console.error(`SMOKE FAILED: ${error.message}`);
    exit(1);
  }
}
