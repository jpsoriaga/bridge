import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPath, DEFAULT_DENYLIST, Denylist, Sandbox, type SandboxCode } from './sandbox';
import { canSymlink } from './test-utils';

/** Every case the lexical check plus the denylist must refuse, with the code it must give. */
const ATTACKS: [string, unknown, SandboxCode][] = [
  // Traversal
  ['parent', '../x', 'traversal'],
  ['parent after a segment', 'a/../../x', 'traversal'],
  ['bare ..', '..', 'traversal'],
  ['bare .', '.', 'traversal'],
  ['leading ./', './x', 'traversal'],
  ['inner .', 'a/./b', 'traversal'],
  ['trailing ..', 'a/b/..', 'traversal'],
  // Absolute
  ['POSIX absolute', '/etc/passwd', 'absolute-path'],
  ['root', '/', 'absolute-path'],
  ['drive letter, backslash', 'C:\\x', 'absolute-path'],
  ['drive letter, slash', 'c:/x', 'absolute-path'],
  ['drive-relative', 'C:x', 'absolute-path'],
  ['UNC, backslashes', '\\\\srv\\x', 'absolute-path'],
  ['UNC, slashes', '//srv/share/x', 'absolute-path'],
  ['leading backslash', '\\x', 'absolute-path'],
  // Malformed
  ['backslash traversal', 'a\\..\\x', 'invalid-path'],
  ['backslash separator', 'a\\b', 'invalid-path'],
  ['NUL byte', 'a\0b', 'invalid-path'],
  ['only NUL', '\0', 'invalid-path'],
  ['newline', 'a\nb', 'invalid-path'],
  ['DEL character', 'a\x7fb', 'invalid-path'],
  ['empty', '', 'invalid-path'],
  ['empty segment', 'a//b', 'invalid-path'],
  ['trailing slash', 'a/', 'invalid-path'],
  ['too long', 'x'.repeat(1025), 'invalid-path'],
  ['NTFS stream', 'file.txt:secret', 'invalid-path'],
  ['trailing dot (Windows drops it)', '.git.', 'invalid-path'],
  ['trailing space (Windows drops it)', '.env ', 'invalid-path'],
  ['not a string', 42, 'invalid-path'],
  ['null', null, 'invalid-path'],
  // Denylist: .git anywhere, any case
  ['.git itself', '.git', 'denied'],
  ['.git/config', '.git/config', 'denied'],
  ['upper-case .GIT', '.GIT/config', 'denied'],
  ['mixed-case .Git', '.Git/HEAD', 'denied'],
  ['nested .git', 'sub/.git/HEAD', 'denied'],
  ['nested .GIT dir', 'a/b/.GIT', 'denied'],
  // .env and .env.*
  ['.env', '.env', 'denied'],
  ['.ENV', '.ENV', 'denied'],
  ['.env.local', '.env.local', 'denied'],
  ['nested .env.production', 'config/.env.production', 'denied'],
  // Keys
  ['*.pem', 'certs/server.pem', 'denied'],
  ['*.KEY', 'keys/private.KEY', 'denied'],
  ['id_rsa', 'id_rsa', 'denied'],
  ['id_rsa.pub', '.ssh/id_rsa.pub', 'denied'],
  // node_modules
  ['node_modules file', 'node_modules/react/index.js', 'denied'],
  ['nested node_modules', 'packages/a/node_modules/x/y.js', 'denied'],
  ['NODE_MODULES', 'Node_Modules/x.js', 'denied'],
  // Unicode: U+212A KELVIN SIGN is canonically "K", so NFC turns ".\u212Aey" into ".Key".
  ['Kelvin-sign .key', 'secret.\u212Aey', 'denied'],
  ['Kelvin-sign in a folder', 'k/\u212Aeys/id_rsa', 'denied']
];

const VALID: [string, string][] = [
  ['src/index.ts', 'src/index.ts'],
  ['README.md', 'README.md'],
  ['a/b/c/d.txt', 'a/b/c/d.txt'],
  ['with space/file name.txt', 'with space/file name.txt'],
  ['.gitignore', '.gitignore'],
  ['.github/workflows/ci.yml', '.github/workflows/ci.yml'],
  ['.envrc', '.envrc'],
  ['environment.ts', 'environment.ts'],
  ['keys/notes.md', 'keys/notes.md'],
  ['a.keys', 'a.keys'],
  ['%2e%2e/x', '%2e%2e/x'],
  ['docs/.gitkeep', 'docs/.gitkeep'],
  // NFD input comes back NFC.
  ['cafe\u0301.txt', 'caf\u00e9.txt'],
  ['x'.repeat(1024), 'x'.repeat(1024)]
];

describe('checkPath + denylist', () => {
  const denylist = new Denylist();
  const refuse = (input: unknown) => {
    const checked = checkPath(input, 'linux');
    if (!checked.ok) return checked.code;
    return denylist.matches(checked.rel) ? 'denied' : null;
  };

  it('has at least 40 attack cases', () => {
    expect(ATTACKS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(ATTACKS)('rejects %s', (_label, input, code) => {
    expect(refuse(input)).toBe(code);
  });

  it.each(VALID)('accepts %j', (input, rel) => {
    expect(checkPath(input, 'linux')).toMatchObject({ ok: true, rel });
    expect(denylist.matches(rel)).toBe(false);
  });

  it('rejects Windows device names on Windows only', () => {
    expect(checkPath('src/con.txt', 'win32')).toEqual({ ok: false, code: 'invalid-path' });
    expect(checkPath('NUL', 'win32')).toEqual({ ok: false, code: 'invalid-path' });
    expect(checkPath('src/con.txt', 'linux').ok).toBe(true);
  });

  it('keeps the defaults in one list', () => {
    expect(DEFAULT_DENYLIST).toEqual([
      '.git/',
      '.env',
      '.env.*',
      '*.pem',
      '*.key',
      'id_rsa*',
      'node_modules/'
    ]);
  });

  it('adds user patterns but never lets them undo a default', () => {
    const custom = new Denylist(['secrets/', '*.sqlite', '!.env', '!*.pem']);
    expect(custom.matches('secrets/a.txt')).toBe(true);
    expect(custom.matches('data/app.SQLITE')).toBe(true);
    expect(custom.matches('.env')).toBe(true);
    expect(custom.matches('a.pem')).toBe(true);
    expect(custom.matches('src/app.ts')).toBe(false);
  });
});

describe('Sandbox.resolve', () => {
  let base: string;
  let root: string;
  let outside: string;
  let sandbox: Sandbox;

  const link = (target: string, at: string, dir = false) =>
    symlinkSync(target, join(root, at), dir ? 'junction' : 'file');

  beforeEach(async () => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'bridge-sandbox-')));
    root = join(base, 'project');
    outside = join(base, 'outside');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'src/app.ts'), 'app');
    writeFileSync(join(root, '.git/config'), '[core]');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    sandbox = await Sandbox.create(root);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('resolves an existing file to its real path', async () => {
    expect(await sandbox.resolve('src/app.ts')).toEqual({
      ok: true,
      rel: 'src/app.ts',
      abs: join(root, 'src/app.ts'),
      kind: 'file'
    });
  });

  it('resolves a new file under missing folders to the nearest real parent', async () => {
    expect(await sandbox.resolve('src/new/deep/file.ts')).toEqual({
      ok: true,
      rel: 'src/new/deep/file.ts',
      abs: join(root, 'src/new/deep/file.ts'),
      kind: 'missing'
    });
  });

  it('reports folders as dir', async () => {
    expect(await sandbox.resolve('src')).toMatchObject({ ok: true, kind: 'dir' });
  });

  it('refuses a path through a file', async () => {
    expect(await sandbox.resolve('src/app.ts/x')).toEqual({ ok: false, code: 'not-a-file' });
  });

  it('applies the lexical checks first', async () => {
    expect(await sandbox.resolve('../outside/secret.txt')).toEqual({
      ok: false,
      code: 'traversal'
    });
    expect(await sandbox.resolve(join(outside, 'secret.txt'))).toMatchObject({ ok: false });
    expect(await sandbox.resolve('.git/config')).toEqual({ ok: false, code: 'denied' });
    expect(await sandbox.resolve('.env')).toEqual({ ok: false, code: 'denied' });
  });

  it('works when the project folder itself is reached through a symlink', async () => {
    if (!canSymlink()) return;
    const alias = join(base, 'alias');
    symlinkSync(root, alias, 'junction');
    const viaAlias = await Sandbox.create(alias);
    expect(viaAlias.root).toBe(root);
    expect(await viaAlias.resolve('src/app.ts')).toMatchObject({ ok: true, kind: 'file' });
  });

  describe.runIf(canSymlink())('symlinks', () => {
    it('refuses a symlinked folder that points outside', async () => {
      link(outside, 'escape', true);
      expect(await sandbox.resolve('escape')).toEqual({ ok: false, code: 'outside-root' });
      expect(await sandbox.resolve('escape/secret.txt')).toEqual({
        ok: false,
        code: 'outside-root'
      });
    });

    it('refuses a new file under a symlinked folder that points outside', async () => {
      link(outside, 'escape', true);
      expect(await sandbox.resolve('escape/new.txt')).toEqual({ ok: false, code: 'outside-root' });
      expect(await sandbox.resolve('escape/a/b/new.txt')).toEqual({
        ok: false,
        code: 'outside-root'
      });
    });

    it('refuses a symlinked file that points outside', async () => {
      link(join(outside, 'secret.txt'), 'leak.txt');
      expect(await sandbox.resolve('leak.txt')).toEqual({ ok: false, code: 'outside-root' });
    });

    it('refuses a symlink to .git', async () => {
      link(join(root, '.git'), 'gitlink', true);
      expect(await sandbox.resolve('gitlink')).toEqual({ ok: false, code: 'denied' });
      expect(await sandbox.resolve('gitlink/config')).toEqual({ ok: false, code: 'denied' });
      expect(await sandbox.resolve('gitlink/new')).toEqual({ ok: false, code: 'denied' });
    });

    it('refuses a symlink to .env', async () => {
      link(join(root, '.env'), 'settings.txt');
      expect(await sandbox.resolve('settings.txt')).toEqual({ ok: false, code: 'denied' });
    });

    it('refuses a dangling symlink, since a write would land who knows where', async () => {
      link(join(outside, 'not-yet.txt'), 'dangling.txt');
      expect(await sandbox.resolve('dangling.txt')).toEqual({ ok: false, code: 'outside-root' });
    });

    it('refuses a symlink loop', async () => {
      link(join(root, 'loop-b'), 'loop-a');
      link(join(root, 'loop-a'), 'loop-b');
      expect(await sandbox.resolve('loop-a')).toEqual({ ok: false, code: 'outside-root' });
    });

    it('refuses a symlink to the project root', async () => {
      link(root, 'self', true);
      expect(await sandbox.resolve('self/src/app.ts')).toEqual({
        ok: false,
        code: 'outside-root'
      });
    });

    it('follows a symlink that stays inside', async () => {
      link(join(root, 'src'), 'source', true);
      link(join(root, 'src/app.ts'), 'entry.ts');
      expect(await sandbox.resolve('source/app.ts')).toMatchObject({
        ok: true,
        abs: join(root, 'src/app.ts'),
        kind: 'file'
      });
      expect(await sandbox.resolve('entry.ts')).toMatchObject({
        ok: true,
        rel: 'entry.ts',
        abs: join(root, 'src/app.ts')
      });
      expect(await sandbox.resolve('source/new.ts')).toMatchObject({
        ok: true,
        abs: join(root, 'src/new.ts'),
        kind: 'missing'
      });
    });

    it('refuses a symlink into a sibling folder whose name starts like the root', async () => {
      const sibling = `${root}-other`;
      mkdirSync(sibling);
      link(sibling, 'sib', true);
      expect(await sandbox.resolve('sib/x')).toEqual({ ok: false, code: 'outside-root' });
    });
  });
});
