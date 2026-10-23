// Smoke test for a packaged app: launch it with a temp userData, wait for its window to
// load, check /health answers on 127.0.0.1 with this version, then quit it. Given several
// apps, it tests them one after another, each with its own fresh userData, and starts the
// next only once the previous one's processes are all gone and its port is free again.
//
//   node scripts/smoke.mjs dist/mac-arm64/Bridge.app
//   node scripts/smoke.mjs dist/win-unpacked/Bridge.exe
//   node scripts/smoke.mjs dist/Bridge-1.0.0-linux-x86_64.AppImage   (Linux: under xvfb-run)
//
// The app writes `smoke.json` to userData once its window has loaded, but only when
// BRIDGE_SMOKE_TEST=1 (src/main/index.ts). The fuses forbid --inspect, so nothing can
// attach a debugger; the marker file is how the test sees the window.
//
// The window gets LOAD_TIMEOUT_MS to load, or ROSETTA_LOAD_TIMEOUT_MS for an x64 Mac app on
// an arm64 Mac: Rosetta translates Electron's framework on its first launch, which took
// longer than 90s on the release runner.
//
// Pass or fail, the whole process tree goes when it's done (an AppImage's runtime and
// Electron's helpers outlive a plain kill and hold its output pipes open), and the script
// exits. No app's run lasts longer than HARD_TIMEOUT_MS.
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_TIMEOUT_MS = 90_000;
const ROSETTA_LOAD_TIMEOUT_MS = 120_000;
/** How long the previous app's processes and port get to go before the next app starts. */
const RELEASE_TIMEOUT_MS = 30_000;
// Per app. The tests shorten it with BRIDGE_SMOKE_HARD_TIMEOUT_MS.
const HARD_TIMEOUT_MS = Number(process.env.BRIDGE_SMOKE_HARD_TIMEOUT_MS) || 180_000;
const POSIX = process.platform !== 'win32';

/** The app being tested, for the hard timeout to kill. */
let running = null;

/** The executable inside a packaged app. */
export function executableOf(app) {
  if (app.endsWith('.app')) return join(app, 'Contents', 'MacOS', basename(app, '.app'));
  return app;
}

/** A thin Mach-O executable's architecture ('x64' or 'arm64'), or null for anything else. */
export function machOArch(executable) {
  const header = Buffer.alloc(8);
  let fd;
  try {
    fd = openSync(executable, 'r');
    if (readSync(fd, header, 0, 8, 0) < 8) return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (header.readUInt32LE(0) !== 0xfeedfacf) return null;
  const cpu = header.readUInt32LE(4);
  return cpu === 0x01000007 ? 'x64' : cpu === 0x0100000c ? 'arm64' : null;
}

/** How long `executable`'s window gets to load on `host`: longer when Rosetta runs it. */
export function loadTimeoutFor(executable, host = process) {
  const rosetta =
    host.platform === 'darwin' && host.arch === 'arm64' && machOArch(executable) === 'x64';
  return rosetta ? ROSETTA_LOAD_TIMEOUT_MS : LOAD_TIMEOUT_MS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Whether 127.0.0.1:`port` can be bound right now. */
export function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** Whether any process of the app's group (POSIX) is still alive. */
function groupAlive(child) {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
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

/**
 * SIGTERM, up to 5s to exit, then SIGKILL for whatever is left in the group. Resolves once
 * the app has exited and (POSIX) its group is empty: true, or false if that took too long.
 */
async function stop(child, exited) {
  if (child.pid === undefined) return true;
  killTree(child, 'SIGTERM');
  await Promise.race([exited, sleep(5_000)]);
  if (POSIX) killTree(child, 'SIGKILL');
  const exitedInTime = await Promise.race([exited.then(() => true), sleep(10_000)]);
  if (!exitedInTime) return false;
  if (!POSIX) return true;
  return waitFor('the app to exit', () => !groupAlive(child), 10_000).catch(() => false);
}

/** Exits once stdout and stderr have drained (pipes are asynchronous on macOS). */
function exit(code) {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  setTimeout(() => process.exit(code), 2_000).unref();
}

/** Tests one app; resolves with the port its server bound, once it's fully gone. */
async function smoke(app) {
  const executable = executableOf(resolve(app));
  if (!existsSync(executable)) throw new Error(`No app at ${executable}`);
  const loadTimeoutMs = loadTimeoutFor(executable);
  console.log(`• launching ${app} (${loadTimeoutMs / 1000}s for the window to load)`);
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

  let port;
  let gone;
  try {
    const marker = join(userData, 'smoke.json');
    const ready = await Promise.race([
      waitFor('the window to load', () => existsSync(marker), loadTimeoutMs),
      exited.then(({ code, signal }) => {
        throw new Error(`The app exited (${signal ?? code}) before its window loaded`);
      })
    ]);
    if (!ready) throw new Error('No window');
    let version, name;
    ({ port, version, name } = JSON.parse(readFileSync(marker, 'utf8')));
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
    gone = await stop(child, exited);
    running = null;
    rmSync(userData, { recursive: true, force: true, maxRetries: 5 });
  }
  if (!gone) throw new Error('The app was still running after SIGKILL');
  console.log(`SMOKE OK ${app}`);
  return port;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apps = process.argv.slice(2);
  if (apps.length === 0) {
    console.error('Usage: node scripts/smoke.mjs <Bridge.app | Bridge.exe | Bridge.AppImage>…');
    process.exit(2);
  }
  try {
    let previousPort;
    for (const app of apps) {
      // The next app starts only on a free port, so it can't meet the last one's server.
      if (previousPort !== undefined) {
        const port = previousPort;
        await waitFor(`port ${port} to be free`, () => portFree(port), RELEASE_TIMEOUT_MS);
      }
      const hardTimeout = setTimeout(() => {
        console.error(`SMOKE FAILED: still running after ${HARD_TIMEOUT_MS / 1000}s`);
        if (running) killTree(running, 'SIGKILL');
        exit(1);
      }, HARD_TIMEOUT_MS);
      hardTimeout.unref();
      try {
        previousPort = await smoke(app);
      } finally {
        clearTimeout(hardTimeout);
      }
    }
    exit(0);
  } catch (error) {
    console.error(`SMOKE FAILED: ${error.message}`);
    exit(1);
  }
}
