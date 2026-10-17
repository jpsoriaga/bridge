import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argument as escapeArgument, command as escapeCommand } from 'cross-spawn/lib/util/escape';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunResult } from '@bridge/shared';
import { tempProject } from '../project/test-utils';
import { cleanOutput, CommandRunner, HeadTail, type RunSpec } from './runner';

const NODE = process.execPath;
const windows = process.platform === 'win32';

let t: ReturnType<typeof tempProject>;
let runner: CommandRunner;
let exits: RunResult[];
let chunks: string[];

beforeEach(() => {
  t = tempProject('bridge-runner-');
  exits = [];
  chunks = [];
  runner = new CommandRunner({
    onOutput: (_runId, chunk) => chunks.push(chunk),
    onExit: (result) => exits.push(result)
  });
});
afterEach(() => {
  runner.cancelAll();
  t.cleanup();
});

const spec = (script: string, extra: Partial<RunSpec> = {}, args: string[] = []): RunSpec => ({
  argv: ['node', '-e', script, ...args],
  file: NODE,
  cwd: t.root,
  env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
  timeoutMs: 20_000,
  ...extra
});

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function run(s: RunSpec): Promise<RunResult> {
  const started = runner.start(s);
  if (!started) throw new Error('busy');
  return waitFor('exit', () => exits.find((e) => e.runId === started.runId), 30_000);
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Spawns a grandchild that outlives its parent, writes its pid to a file, then waits. */
const PARENT_WITH_GRANDCHILD = `
  const { spawn } = require('child_process');
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ${'"ignore"'} });
  require('fs').writeFileSync(process.argv[1], String(g.pid));
  console.log('started');
  setInterval(() => {}, 1000);
`;

describe('CommandRunner', () => {
  it('reports the exit code, duration and output', async () => {
    const result = await run(spec('console.log("hello"); console.error("oops"); process.exit(3)'));
    expect(result).toMatchObject({
      status: 'exited',
      exitCode: 3,
      signal: null,
      argv: ['node', '-e', expect.any(String)],
      truncated: false
    });
    expect(result.output).toContain('hello\n');
    expect(result.output).toContain('oops\n');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('streams output live while it runs', async () => {
    await run(spec('console.log("one"); setTimeout(() => console.log("two"), 200)'));
    expect(chunks.join('')).toContain('one\n');
    expect(chunks.join('')).toContain('two\n');
  });

  it('runs in the project root, with exactly the environment it is given', async () => {
    const result = await run(
      spec(
        'console.log(process.cwd()); console.log(process.env.ONLY ?? "unset", process.env.HOME ?? "no-home")',
        {
          env: {
            PATH: process.env.PATH ?? '',
            ONLY: 'yes',
            SystemRoot: process.env.SystemRoot ?? ''
          }
        }
      )
    );
    const [cwd, env] = result.output.trim().split('\n');
    expect(cwd).toBe(t.root);
    expect(env).toBe('yes no-home');
  });

  it('passes arguments as they are, with no shell to interpret them', async () => {
    const tricky = ['a b', '$(id)', '`id`', '; rm -rf /', '*', '"quoted"', "it's"];
    const result = await run(
      spec('console.log(JSON.stringify(process.argv.slice(1)))', {}, tricky)
    );
    expect(JSON.parse(result.output)).toEqual(tricky);
  });

  it('gives the command no stdin', async () => {
    const result = await run(
      spec(
        'process.stdin.on("data", () => console.log("data")); process.stdin.on("end", () => console.log("eof"))'
      )
    );
    expect(result.output.trim()).toBe('eof');
  });

  it('strips ANSI codes and normalises line breaks', async () => {
    const result = await run(
      spec('process.stdout.write("\\x1b[31mred\\x1b[0m\\r\\n\\x1b]0;title\\x07plain\\rbar\\n")')
    );
    expect(result.output).toBe('red\nplain\nbar\n');
  });

  it('runs one command at a time', async () => {
    const first = runner.start(spec('setTimeout(() => {}, 2000)'));
    expect(first).not.toBeNull();
    expect(runner.current?.runId).toBe(first?.runId);
    expect(runner.start(spec('1'))).toBeNull();
    runner.cancelAll();
    await waitFor('exit', () => exits.length === 1);
    expect(runner.current).toBeNull();
    expect(runner.start(spec('1'))).not.toBeNull();
  });

  it('cancels, and says so', async () => {
    const started = runner.start(spec('console.log("x"); setInterval(() => {}, 1000)'))!;
    await waitFor('output', () => chunks.join('').includes('x'));
    expect(runner.cancel('not-this-one')).toBe(false);
    expect(runner.cancel(started.runId)).toBe(true);
    const result = await waitFor('exit', () => exits[0]);
    expect(result.status).toBe('cancelled');
  });

  it('kills the whole process tree on timeout', async () => {
    const pidFile = join(t.base, 'grandchild.pid');
    const result = await run(spec(PARENT_WITH_GRANDCHILD, { timeoutMs: 1_500 }, [pidFile]));
    expect(result.status).toBe('timed-out');
    expect(result.output).toContain('started');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    await waitFor('grandchild gone', () => !alive(pid), 5_000);
  }, 20_000);

  it('kills a grandchild left behind when the command exits on its own', async () => {
    const pidFile = join(t.base, 'leftover.pid');
    const script = `
      const { spawn } = require('child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('fs').writeFileSync(process.argv[1], String(g.pid));
      setTimeout(() => process.exit(0), 200);
    `;
    const result = await run(spec(script, {}, [pidFile]));
    expect(result).toMatchObject({ status: 'exited', exitCode: 0 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await waitFor('leftover gone', () => !alive(pid), 5_000);
  }, 20_000);

  it('caps captured output, keeping the head and the tail', async () => {
    const script = `
      process.stdout.write('HEAD\\n' + 'a'.repeat(150000) + '\\n');
      process.stdout.write('b'.repeat(400000) + '\\n');
      process.stdout.write('c'.repeat(50000) + '\\nTAIL\\n');
    `;
    const result = await run(spec(script));
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith('HEAD\n')).toBe(true);
    expect(result.output.endsWith('TAIL\n')).toBe(true);
    expect(result.output).toMatch(/\[… [\d,]+ bytes of output cut …\]/);
    expect(result.output.length).toBeLessThan(205 * 1024);
    // Live output stops at the cap too; the end comes with the result.
    expect(chunks.join('').length).toBeLessThan(110 * 1024);
  });

  it('reports a program that fails to start', async () => {
    const result = await run({ ...spec('1'), file: join(t.root, 'missing-binary') });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeNull();
  });
});

describe('HeadTail', () => {
  it('keeps everything under the cap', () => {
    const buffer = new HeadTail(100);
    buffer.push(Buffer.from('hello '));
    buffer.push(Buffer.from('world'));
    expect(buffer.text()).toBe('hello world');
    expect(buffer.truncated).toBe(false);
  });

  it('keeps the first and last half of the cap', () => {
    const buffer = new HeadTail(10);
    for (const c of 'abcdefghijklmnopqrstuvwxyz') buffer.push(Buffer.from(c));
    expect(buffer.truncated).toBe(true);
    expect(buffer.text()).toBe('abcde\n[… 16 bytes of output cut …]\nvwxyz');
  });
});

describe('cleanOutput', () => {
  it('removes CSI, OSC and stray escapes', () => {
    expect(cleanOutput('\x1b[1;32m✓\x1b[39m ok\x1b[K\r\n')).toBe('✓ ok\n');
    expect(cleanOutput('\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
    expect(cleanOutput('a\x1bb')).toBe('ab');
  });
});

// cross-spawn wraps a .cmd in `cmd.exe /d /s /c "..."`. These pin the escaping it uses, so
// an upgrade that changes it shows up here. Bridge also refuses cmd metacharacters in
// arguments to batch files outright (resolve.ts, BATCH_UNSAFE).
describe('Windows argument escaping (cross-spawn)', () => {
  it.each([
    ['plain', '^"plain^"'],
    ['a b', '^"a^ b^"'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['C:\\dir\\', '^"C:\\dir\\\\^"'],
    ['back\\"slash', '^"back\\\\\\^"slash^"'],
    ['a&b', '^"a^&b^"'],
    ['%PATH%', '^"^%PATH^%^"'],
    ['semi;colon', '^"semi^;colon^"']
  ])('quotes %j for cmd.exe', (arg, escaped) => {
    expect(escapeArgument(arg, false)).toBe(escaped);
  });

  it('escapes twice for a node_modules/.bin shim, which cmd reads twice', () => {
    expect(escapeArgument('a&b', true)).toBe('^^^"a^^^&b^^^"');
  });

  it('escapes the program path', () => {
    expect(escapeCommand('C:\\Program Files\\nodejs\\pnpm.cmd')).toBe(
      'C:\\Program^ Files\\nodejs\\pnpm.cmd'
    );
  });

  // The real thing, on Windows CI: a .cmd shim like pnpm.cmd, run with shell: false.
  it.runIf(windows)(
    'round-trips arguments through a .cmd shim',
    async () => {
      const shim = join(t.base, 'echo-args.cmd');
      writeFileSync(
        shim,
        `@"${NODE}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`
      );
      expect(existsSync(shim)).toBe(true);
      const args = ['a b', "it's", 'x=y', 'C:\\dir\\file', '--flag', 'semi;colon', 'comma,arg'];
      const result = await run({
        argv: ['echo-args', ...args],
        file: shim,
        cwd: t.root,
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
        timeoutMs: 20_000
      });
      expect(result.status).toBe('exited');
      expect(JSON.parse(result.output.trim())).toEqual(args);
    },
    30_000
  );
});
