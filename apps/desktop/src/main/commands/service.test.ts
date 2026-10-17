import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileErrorCode, Mode, RunResult } from '@bridge/shared';
import { tempProject } from '../project/test-utils';
import { CommandRunner } from './runner';
import { CommandService } from './service';

const posix = process.platform !== 'win32';

let t: ReturnType<typeof tempProject>;
let mode: Mode;
let allowlist: string[];
let exits: RunResult[];
let refused: { argv: readonly string[]; code: FileErrorCode }[];
let runner: CommandRunner;
let service: CommandService;
let pathEnv: string;

beforeEach(() => {
  t = tempProject('bridge-commands-');
  mode = 'manual';
  allowlist = ['node -e', 'git status'];
  exits = [];
  refused = [];
  pathEnv = dirname(process.execPath);
  runner = new CommandRunner({ onOutput: () => {}, onExit: (r) => exits.push(r) });
  service = new CommandService({
    runner,
    root: () => t.root,
    mode: () => mode,
    allowlist: () => allowlist,
    envPatterns: () => [],
    timeoutMs: () => 10_000,
    env: () => ({ PATH: pathEnv, PATHEXT: '.EXE;.CMD', SECRET_TOKEN: 'x' }),
    onRefused: (argv, code) => refused.push({ argv, code })
  });
});
afterEach(() => {
  runner.cancelAll();
  t.cleanup();
});

async function finished(): Promise<RunResult> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (exits[0]) return exits[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('no exit');
}

const code = async (argv: string[], trigger: 'click' | 'auto' = 'click') => {
  const outcome = await service.run({ argv, trigger });
  return outcome.ok ? 'ok' : outcome.error.code;
};

describe('CommandService', () => {
  it('runs an allowlisted command on a click, in the project, with a filtered env', async () => {
    const outcome = await service.run({
      argv: [
        'node',
        '-e',
        'console.log(process.cwd(), process.env.SECRET_TOKEN || "-", process.env.CI)'
      ],
      trigger: 'click'
    });
    expect(outcome.ok).toBe(true);
    const result = await finished();
    expect(result.output.trim()).toBe(`${t.root} - 1`);
  });

  it('refuses a command that isn’t allowlisted, even on a click', async () => {
    expect(await code(['node', '--version'])).toBe('not-allowlisted');
    expect(await code(['git', 'push'])).toBe('not-allowlisted');
    expect(await code(['git', 'statusx'])).toBe('not-allowlisted');
    expect(await code(['rm', '-rf', '/'])).toBe('not-allowlisted');
    expect(refused.map((r) => r.code)).toEqual(Array(4).fill('not-allowlisted'));
  });

  it('refuses an automatic run unless the mode is Full auto', async () => {
    const argv = ['node', '-e', '1'];
    mode = 'manual';
    expect(await code(argv, 'auto')).toBe('mode');
    mode = 'auto-apply';
    expect(await code(argv, 'auto')).toBe('mode');
    mode = 'full-auto';
    expect(await code(argv, 'auto')).toBe('ok');
    await finished();
  });

  it('re-checks every word, whatever the extension sent', async () => {
    allowlist = ['node'];
    expect(await code(['node', '-e', '$(id)'])).toBe('invalid-command');
    expect(await code(['node', 'a\nb'])).toBe('invalid-command');
    expect(await code(['node', '*.js'])).toBe('invalid-command');
    expect(await code(['FOO=1', 'node'])).toBe('invalid-command');
    expect(await code([''])).toBe('invalid-command');
  });

  it('runs one command at a time', async () => {
    expect(await code(['node', '-e', 'setTimeout(() => {}, 3000)'])).toBe('ok');
    expect(await code(['node', '-e', '1'])).toBe('busy');
    runner.cancelAll();
    expect((await finished()).status).toBe('cancelled');
  });

  it('cancels by run id', async () => {
    const outcome = await service.run({
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      trigger: 'click'
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(service.cancel('other')).toMatchObject({ ok: false, error: { code: 'unknown-run' } });
    expect(service.cancel(outcome.result.runId)).toEqual({ ok: true, result: { cancelled: true } });
    expect((await finished()).status).toBe('cancelled');
  });

  it('refuses a program that resolves into the project', async () => {
    const local = join(t.root, 'node_modules', '.bin');
    mkdirSync(local, { recursive: true });
    const fake = join(local, posix ? 'git' : 'git.cmd');
    writeFileSync(fake, posix ? '#!/bin/sh\necho pwned\n' : '@echo pwned\r\n');
    chmodSync(fake, 0o755);
    pathEnv = [local, dirname(process.execPath)].join(posix ? ':' : ';');
    expect(await code(['git', 'status'])).toBe('project-binary');
  });

  it('refuses project paths unless that exact path is allowlisted', async () => {
    const script = join(t.root, 'scripts', posix ? 'check.sh' : 'check.cmd');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, posix ? '#!/bin/sh\necho checked\n' : '@echo checked\r\n');
    chmodSync(script, 0o755);
    const word = posix ? './scripts/check.sh' : 'scripts/check.cmd';
    expect(await code([word])).toBe('not-allowlisted');
    expect(await code(['node_modules/.bin/vitest'])).toBe('not-allowlisted');
    allowlist = [word];
    expect(await code([word])).toBe('ok');
    expect((await finished()).output.trim()).toBe('checked');
  });

  it('says no-project when no folder is open', async () => {
    const closed = new CommandService({
      runner,
      root: () => null,
      mode: () => 'full-auto',
      allowlist: () => ['node'],
      envPatterns: () => [],
      timeoutMs: () => 1000
    });
    const outcome = await closed.run({ argv: ['node'], trigger: 'click' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'no-project' } });
  });

  it.runIf(!posix)('refuses cmd metacharacters in arguments to a batch file', async () => {
    const bin = join(t.base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'tool.cmd'), '@echo hi\r\n');
    allowlist = ['tool'];
    pathEnv = bin;
    for (const arg of ['a&calc', '"x"', '%PATH%', 'a|b']) {
      expect(await code(['tool', arg])).toBe('invalid-command');
    }
    expect(await code(['tool', 'plain arg'])).toBe('ok');
    await finished();
  });
});
