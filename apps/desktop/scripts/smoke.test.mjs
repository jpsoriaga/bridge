import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadTimeoutFor, machOArch, portFree } from './smoke.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(SCRIPTS, '..', 'package.json'), 'utf8')).version;

// A stand-in for the packaged app. It starts a helper that ignores SIGTERM and holds the
// output pipes (like an AppImage's Electron under its runtime), then either answers like
// the app (`ready`) or never gets its window up (`hang`). It never exits on its own. Each
// launch appends a line to FAKE_PIDS: its pids, its userData, and whether an earlier
// launch's processes were still alive when it started. With FAKE_PORT it binds that port
// (and never gets ready if it's taken), like the app's fixed port range.
const FAKE_APP = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const earlier = existsSync(process.env.FAKE_PIDS)
  ? readFileSync(process.env.FAKE_PIDS, 'utf8').trim().split('\\n').flatMap((l) => JSON.parse(l).pids)
  : [];
const overlap = earlier.some(alive);
const userData = process.argv.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
appendFileSync(process.env.FAKE_PIDS, JSON.stringify({ pids: [process.pid, helper.pid], userData, overlap }) + '\\n');
setInterval(() => {}, 1000);
if (process.env.FAKE_MODE === 'ready') {
  const version = process.env.FAKE_VERSION;
  const server = createServer((req, res) => res.end(JSON.stringify({ name: 'bridge', version, protocol: 7 })));
  server.on('error', (error) => console.error('fake app: ' + error.message));
  server.listen(Number(process.env.FAKE_PORT) || 0, '127.0.0.1', () => {
    const { port } = server.address();
    writeFileSync(join(userData, 'smoke.json'), JSON.stringify({ port, version, name: 'Bridge' }));
  });
}
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Runs smoke.mjs on the fake app, `times` times in one run; resolves with its exit code,
 * output, and each launch's line (pids, userData, overlap).
 */
function runSmoke(dir, mode, hardTimeoutMs, { times = 1, port } = {}) {
  const app = join(dir, 'fake-app');
  writeFileSync(app, FAKE_APP);
  chmodSync(app, 0o755);
  const pids = join(dir, 'pids.jsonl');
  const child = spawn(process.execPath, [join(SCRIPTS, 'smoke.mjs'), ...Array(times).fill(app)], {
    env: {
      ...process.env,
      FAKE_MODE: mode,
      FAKE_PIDS: pids,
      FAKE_PORT: port === undefined ? '' : String(port),
      FAKE_VERSION: VERSION,
      BRIDGE_SMOKE_HARD_TIMEOUT_MS: String(hardTimeoutMs)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const started = Date.now();
  return new Promise((resolve) => {
    // Without the fix the script never exits; this ends the test instead of hanging it.
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', (code) => {
      clearTimeout(guard);
      const launches = readFileSync(pids, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      resolve({
        code,
        output,
        ms: Date.now() - started,
        launches,
        pids: launches.flatMap((launch) => launch.pids)
      });
    });
  });
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function expectAllGone(pids) {
  const until = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  expect(pids.filter(alive)).toEqual([]);
}

// The fake app is a script with a shebang, which Windows can't spawn without a shell.
describe.skipIf(process.platform === 'win32')('smoke.mjs', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-smoke-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('exits 0 after passing and kills the whole process tree', async () => {
    const result = await runSmoke(dir, 'ready', 25_000);
    expect(result.output).toContain('SMOKE OK');
    expect(result.code).toBe(0);
    await expectAllGone(result.pids);
  }, 40_000);

  it('gives up at the hard timeout, exits 1 and kills an app that never exits', async () => {
    const result = await runSmoke(dir, 'hang', 3_000);
    expect(result.output).toContain('SMOKE FAILED: still running after 3s');
    expect(result.code).toBe(1);
    expect(result.ms).toBeLessThan(10_000);
    await expectAllGone(result.pids);
  }, 40_000);

  it('runs several apps one at a time: fresh userData, previous one gone, its port free', async () => {
    const port = await freePort();
    const result = await runSmoke(dir, 'ready', 25_000, { times: 2, port });
    expect(result.output.match(/SMOKE OK/g)).toHaveLength(2);
    expect(result.code).toBe(0);
    const [first, second] = result.launches;
    expect(second.overlap).toBe(false);
    expect(second.userData).not.toBe(first.userData);
    await expectAllGone(result.pids);
  }, 40_000);
});

describe('loadTimeoutFor', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-smoke-arch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A file with a thin 64-bit Mach-O header for `cpu`. */
  const machO = (name, cpu) => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpu, 4);
    writeFileSync(join(dir, name), header);
    return join(dir, name);
  };

  it('gives an x64 Mac app 120s on an arm64 Mac (Rosetta), and 90s otherwise', () => {
    const x64 = machO('x64', 0x01000007);
    const arm64 = machO('arm64', 0x0100000c);
    const elf = join(dir, 'elf');
    writeFileSync(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
    expect(machOArch(x64)).toBe('x64');
    expect(machOArch(arm64)).toBe('arm64');
    expect(machOArch(elf)).toBeNull();
    expect(machOArch(join(dir, 'missing'))).toBeNull();

    const armMac = { platform: 'darwin', arch: 'arm64' };
    expect(loadTimeoutFor(x64, armMac)).toBe(120_000);
    expect(loadTimeoutFor(arm64, armMac)).toBe(90_000);
    expect(loadTimeoutFor(x64, { platform: 'darwin', arch: 'x64' })).toBe(90_000);
    expect(loadTimeoutFor(elf, { platform: 'linux', arch: 'x64' })).toBe(90_000);
  });
});

describe('portFree', () => {
  it('is false while something listens on the port, true once it stops', async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    expect(await portFree(port)).toBe(false);
    await new Promise((resolve) => server.close(resolve));
    expect(await portFree(port)).toBe(true);
  });
});
