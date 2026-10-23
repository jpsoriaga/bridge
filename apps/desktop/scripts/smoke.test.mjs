import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(SCRIPTS, '..', 'package.json'), 'utf8')).version;

// A stand-in for the packaged app. It starts a helper that ignores SIGTERM and holds the
// output pipes (like an AppImage's Electron under its runtime), then either answers like
// the app (`ready`) or never gets its window up (`hang`). It never exits on its own.
const FAKE_APP = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
writeFileSync(process.env.FAKE_PIDS, JSON.stringify([process.pid, helper.pid]));
setInterval(() => {}, 1000);
if (process.env.FAKE_MODE === 'ready') {
  const userData = process.argv.find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
  const version = process.env.FAKE_VERSION;
  const server = createServer((req, res) => res.end(JSON.stringify({ name: 'bridge', version, protocol: 7 })));
  server.listen(0, '127.0.0.1', () => {
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

/** Runs smoke.mjs on the fake app; resolves with its exit code, output and the fake's pids. */
function runSmoke(dir, mode, hardTimeoutMs) {
  const app = join(dir, 'fake-app');
  writeFileSync(app, FAKE_APP);
  chmodSync(app, 0o755);
  const pids = join(dir, 'pids.json');
  const child = spawn(process.execPath, [join(SCRIPTS, 'smoke.mjs'), app], {
    env: {
      ...process.env,
      FAKE_MODE: mode,
      FAKE_PIDS: pids,
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
      resolve({
        code,
        output,
        ms: Date.now() - started,
        pids: JSON.parse(readFileSync(pids, 'utf8'))
      });
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
});
