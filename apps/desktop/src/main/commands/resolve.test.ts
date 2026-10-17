import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canSymlink, tempProject } from '../project/test-utils';
import { BATCH_UNSAFE, isBatchFile, resolveExecutable } from './resolve';

const posix = process.platform !== 'win32';
const symlinks = canSymlink();

let t: ReturnType<typeof tempProject>;
let bin: string;

/** An executable file. On Windows a `.cmd` so PATHEXT finds it. */
function tool(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, posix ? name : `${name}.cmd`);
  writeFileSync(file, posix ? '#!/bin/sh\necho hi\n' : '@echo hi\r\n');
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  t = tempProject('bridge-resolve-');
  bin = join(t.base, 'bin');
  tool(bin, 'pnpm');
});
afterEach(() => t.cleanup());

const env = (...dirs: string[]) => ({ PATH: dirs.join(delimiter), PATHEXT: '.EXE;.CMD' });

describe('resolveExecutable', () => {
  it('finds a bare name on the PATH, as an absolute path', async () => {
    const resolved = await resolveExecutable('pnpm', { root: t.root, env: env(bin) });
    expect(resolved).toEqual({ ok: true, file: join(bin, posix ? 'pnpm' : 'pnpm.cmd') });
  });

  it('says so when the program is nowhere on the PATH', async () => {
    expect(await resolveExecutable('nope', { root: t.root, env: env(bin) })).toEqual({
      ok: false,
      code: 'command-not-found'
    });
  });

  it('refuses a name that resolves into the project (node_modules/.bin on the PATH)', async () => {
    const local = join(t.root, 'node_modules', '.bin');
    tool(local, 'vitest');
    tool(local, 'pnpm');
    expect(await resolveExecutable('vitest', { root: t.root, env: env(local, bin) })).toEqual({
      ok: false,
      code: 'project-binary'
    });
    // First match wins, and it's the project's.
    expect(await resolveExecutable('pnpm', { root: t.root, env: env(local, bin) })).toEqual({
      ok: false,
      code: 'project-binary'
    });
  });

  it('skips relative PATH entries, which would resolve inside the project', async () => {
    tool(t.root, 'evil');
    tool(join(t.root, 'scripts'), 'evil2');
    for (const word of ['evil', 'evil2']) {
      const resolved = await resolveExecutable(word, {
        root: t.root,
        env: env('.', '', 'scripts', bin)
      });
      expect(resolved).toEqual({ ok: false, code: 'command-not-found' });
    }
  });

  it.runIf(symlinks)('refuses a PATH entry that is a symlink into the project', async () => {
    tool(join(t.root, 'tools'), 'sneaky');
    const linked = join(t.base, 'linked-bin');
    symlinkSync(join(t.root, 'tools'), linked, 'junction');
    expect(await resolveExecutable('sneaky', { root: t.root, env: env(linked) })).toEqual({
      ok: false,
      code: 'project-binary'
    });
  });

  it('runs an explicitly allowlisted project path from the project root', async () => {
    const script = tool(join(t.root, 'scripts'), 'check');
    const word = posix ? './scripts/check' : 'scripts/check.cmd';
    const resolved = await resolveExecutable(word, { root: t.root, env: env(bin) });
    expect(resolved).toEqual({ ok: true, file: script });
  });

  it('keeps a project path inside the project', async () => {
    expect(await resolveExecutable('../bin/pnpm', { root: t.root, env: env(bin) })).toEqual({
      ok: false,
      code: 'invalid-command'
    });
    expect(await resolveExecutable('scripts/missing', { root: t.root, env: env(bin) })).toEqual({
      ok: false,
      code: 'command-not-found'
    });
  });

  it.runIf(posix)('needs the execute bit on POSIX', async () => {
    const file = join(bin, 'notexec');
    writeFileSync(file, 'x');
    chmodSync(file, 0o644);
    expect(await resolveExecutable('notexec', { root: t.root, env: env(bin) })).toEqual({
      ok: false,
      code: 'command-not-found'
    });
  });
});

describe('batch files on Windows', () => {
  it('knows .cmd and .bat', () => {
    expect(isBatchFile('C:\\nodejs\\pnpm.cmd')).toBe(true);
    expect(isBatchFile('C:\\x\\RUN.BAT')).toBe(true);
    expect(isBatchFile('C:\\nodejs\\node.exe')).toBe(false);
  });

  it.each(['a&b', 'a|b', 'a"b', '%PATH%', '!x!', 'a^b', '(a)', 'a<b', 'a>b'])(
    'refuses %j as an argument to one',
    (arg) => {
      expect(BATCH_UNSAFE.test(arg)).toBe(true);
    }
  );

  it.each(['--run', 'src/a b.test.ts', "it's", 'a=b', 'C:\\x\\y'])('allows %j', (arg) => {
    expect(BATCH_UNSAFE.test(arg)).toBe(false);
  });
});
