import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKGROUND_LOG_LINES, MAX_BACKGROUND_PROCESSES } from '@bridge/shared';
import { tempProject } from '../project/test-utils';
import { BackgroundRunner, type BackgroundSpec } from './background';
import { BackgroundLifecycle, LONG_SLEEP_MS } from './lifecycle';

const NODE = process.execPath;
const windows = process.platform === 'win32';

let t: ReturnType<typeof tempProject>;
let runner: BackgroundRunner;
let changes: number;

beforeEach(() => {
  t = tempProject('bridge-background-');
  changes = 0;
  runner = new BackgroundRunner(() => (changes += 1));
});
afterEach(async () => {
  await runner.stopAll();
  t.cleanup();
});

/** `node -e script`, standing in for `npm run dev`. `name` tells processes apart. */
const spec = (script: string, name = 'dev'): BackgroundSpec => ({
  argv: ['node', '-e', script, name],
  file: NODE,
  cwd: t.root,
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' }
});

/** A dev server: prints its URL after a moment, then stays up. */
const SERVER = `setTimeout(() => console.log('  ➜  Local:   http://localhost:5173/'), 100); setInterval(() => {}, 1000);`;

async function waitFor<T>(what: string, fn: () => T | undefined | null | false, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('BackgroundRunner', () => {
  it('starts a process, finds the URL it prints, and stops it', async () => {
    const started = await runner.start(spec(SERVER));
    expect(started).toMatchObject({ restarted: false });
    expect(runner.list()[0]).toMatchObject({
      state: 'running',
      url: null,
      command: expect.stringContaining('node -e')
    });
    const ready = await waitFor('the URL', () => runner.list()[0]?.url);
    expect(ready).toBe('http://localhost:5173/');
    expect(runner.runningCount).toBe(1);
    // A change for starting and one for the URL, not one per line.
    expect(changes).toBe(2);

    expect(await runner.stop({ procId: started!.procId })).toBe(true);
    expect(runner.list()[0]).toMatchObject({ state: 'stopped' });
    expect(runner.runningCount).toBe(0);
    expect(await runner.stop({ procId: started!.procId })).toBe(false);
  });

  it('turns 0.0.0.0 into localhost and keeps the first URL only', async () => {
    await runner.start(
      spec(
        `console.log('Listening on http://0.0.0.0:3000'); console.log('http://localhost:9999'); setInterval(() => {}, 1000);`
      )
    );
    expect(await waitFor('the URL', () => runner.list()[0]?.url)).toBe('http://localhost:3000');
  });

  it('restarts a process that is already running, never starting a second one', async () => {
    const first = await runner.start(spec(SERVER));
    await waitFor('the URL', () => runner.list()[0]?.url);
    const second = await runner.start(spec(SERVER));
    expect(second).toMatchObject({ restarted: true });
    expect(second!.procId).not.toBe(first!.procId);
    expect(runner.runningCount).toBe(1);
    // The old run's record went with it: one entry per command.
    expect(runner.list()).toHaveLength(1);
    expect(runner.find({ argv: spec(SERVER).argv })?.procId).toBe(second!.procId);
  });

  it(`runs at most ${MAX_BACKGROUND_PROCESSES} at once`, async () => {
    for (let i = 0; i < MAX_BACKGROUND_PROCESSES; i += 1) {
      expect(await runner.start(spec(SERVER, `server-${i}`))).not.toBeNull();
    }
    expect(await runner.start(spec(SERVER, 'one-too-many'))).toBeNull();
    expect(runner.runningCount).toBe(MAX_BACKGROUND_PROCESSES);
    // Restarting one of the three is fine: it replaces itself.
    expect(await runner.start(spec(SERVER, 'server-0'))).toMatchObject({ restarted: true });
    await runner.stop({ argv: spec(SERVER, 'server-1').argv });
    expect(await runner.start(spec(SERVER, 'one-too-many'))).not.toBeNull();
  });

  it('notices a process that ends on its own, and keeps its last lines', async () => {
    await runner.start(spec(`console.error('Error: Cannot find module "vite"'); process.exit(1);`));
    const ended = await waitFor('the exit', () => runner.list().find((p) => p.state !== 'running'));
    expect(ended).toMatchObject({ state: 'exited', exitCode: 1 });
    const logs = runner.logs({ procId: ended.procId });
    expect(logs?.lines).toContain('Error: Cannot find module "vite"');
    expect(runner.runningCount).toBe(0);
  });

  it(`keeps the last ${BACKGROUND_LOG_LINES} lines, numbered, and reads them from a line on`, async () => {
    const started = await runner.start(
      spec(`for (let i = 0; i < 2500; i++) console.log('line ' + i); setInterval(() => {}, 1000);`)
    );
    const logs = await waitFor('every line', () => {
      const read = runner.logs({ procId: started!.procId });
      return read && read.next === 2500 ? read : null;
    });
    expect(logs.lines).toHaveLength(BACKGROUND_LOG_LINES);
    expect(logs.first).toBe(500);
    expect(logs.lines[0]).toBe('line 500');
    expect(runner.logs({ procId: started!.procId }, { since: 2498 })?.lines).toEqual([
      'line 2498',
      'line 2499'
    ]);
    expect(runner.logs({ procId: started!.procId }, { tail: 1 })?.lines).toEqual(['line 2499']);
    expect(runner.logs({ procId: started!.procId }, { tail: 0 })).toMatchObject({
      lines: [],
      next: 2500
    });
    // Long gone lines come from the oldest kept one.
    expect(runner.logs({ procId: started!.procId }, { since: 3 })?.first).toBe(500);
  });

  it('redacts likely secrets in what it keeps', async () => {
    const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const started = await runner.start(
      spec(`console.log('token: ${token}'); setInterval(() => {}, 1000);`)
    );
    const logs = await waitFor(
      'the line',
      () => runner.logs({ procId: started!.procId })?.lines[0]
    );
    expect(logs).not.toContain(token);
    expect(logs).toContain('[redacted]');
  });

  it.skipIf(windows)('stops the whole tree a process started', async () => {
    const pidFile = join(t.root, 'child.pid');
    // A dev server that starts a helper (like vite starting esbuild), which ignores SIGTERM.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "console.log('http://localhost:4000');",
      'setInterval(() => {}, 1000);'
    ].join('\n');
    const started = await runner.start(spec(script));
    await waitFor('the helper', () => existsSync(pidFile));
    const helper = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(helper)).toBe(true);
    await runner.stop({ procId: started!.procId });
    await waitFor('the helper to go', () => !alive(helper), 6_000);
  });

  it.skipIf(windows)('stops every process, and each one’s tree, at once', async () => {
    const pids: number[] = [];
    for (const name of ['a', 'b']) {
      const pidFile = join(t.root, `${name}.pid`);
      await runner.start(
        spec(
          [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
            'setInterval(() => {}, 1000);'
          ].join('\n'),
          name
        )
      );
      await waitFor('the helper', () => existsSync(pidFile));
      pids.push(Number(readFileSync(pidFile, 'utf8')));
    }
    await runner.stopAll();
    expect(runner.runningCount).toBe(0);
    await waitFor('the helpers to go', () => pids.every((pid) => !alive(pid)), 6_000);
  });

  it('reports a program that can’t start as ended', async () => {
    const started = await runner.start({ ...spec(SERVER), file: join(t.root, 'missing-program') });
    expect(started).not.toBeNull();
    await waitFor('the failure', () => runner.list()[0]?.state === 'exited');
  });

  it('forgets ended processes on clear, keeping running ones', async () => {
    await runner.start(spec(`process.exit(0)`, 'once'));
    await waitFor('the exit', () => runner.list().some((p) => p.state === 'exited'));
    await runner.start(spec(SERVER));
    runner.clear();
    expect(runner.list().map((p) => p.state)).toEqual(['running']);
  });
});

describe('BackgroundLifecycle', () => {
  const fake = () => {
    const calls: string[] = [];
    const processes = {
      runningCount: 1,
      stopAll: async () => {
        calls.push('stopAll');
        processes.runningCount = 0;
      },
      clear: () => calls.push('clear')
    };
    return { processes, calls };
  };

  it('stops everything when the session ends, saying why', async () => {
    const { processes, calls } = fake();
    const why: string[] = [];
    await new BackgroundLifecycle(processes, (w) => why.push(w)).sessionEnded();
    expect(calls).toEqual(['stopAll']);
    expect(why).toEqual(['the chat session ended']);
  });

  it('stops and forgets everything when the project switches', async () => {
    const { processes, calls } = fake();
    await new BackgroundLifecycle(processes).projectSwitched();
    expect(calls).toEqual(['stopAll', 'clear']);
  });

  it('stops everything after a sleep longer than 30 minutes, not a shorter one', async () => {
    let now = 0;
    const { processes, calls } = fake();
    const lifecycle = new BackgroundLifecycle(
      processes,
      () => {},
      () => now
    );
    lifecycle.suspended();
    now = LONG_SLEEP_MS - 1;
    await lifecycle.resumed();
    expect(calls).toEqual([]);
    lifecycle.suspended();
    now += LONG_SLEEP_MS + 1;
    await lifecycle.resumed();
    expect(calls).toEqual(['stopAll']);
    // A resume without a suspend (or a second one) does nothing.
    await lifecycle.resumed();
    expect(calls).toEqual(['stopAll']);
  });

  it('holds the quit until everything stopped, once', async () => {
    const { processes, calls } = fake();
    const lifecycle = new BackgroundLifecycle(processes);
    const waiting = lifecycle.beforeQuit();
    expect(waiting).not.toBeNull();
    await waiting;
    expect(calls).toEqual(['stopAll']);
    // The quit that follows goes through.
    expect(lifecycle.beforeQuit()).toBeNull();
  });

  it('lets the app quit at once with nothing running', () => {
    const { processes } = fake();
    processes.runningCount = 0;
    expect(new BackgroundLifecycle(processes).beforeQuit()).toBeNull();
  });

  it.skipIf(windows)('takes real process trees down on each of them', async () => {
    const pidFile = join(t.root, 'tree.pid');
    await runner.start(
      spec(
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          'setInterval(() => {}, 1000);'
        ].join('\n')
      )
    );
    await waitFor('the helper', () => existsSync(pidFile));
    const helper = Number(readFileSync(pidFile, 'utf8'));
    await new BackgroundLifecycle(runner).sessionEnded();
    expect(runner.runningCount).toBe(0);
    await waitFor('the helper to go', () => !alive(helper), 6_000);
  });
});
