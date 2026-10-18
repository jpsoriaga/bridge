import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BACKUP_BYTES } from '@bridge/shared';
import { History } from './history';
import {
  deleteFile,
  FileOpError,
  listDir,
  readFile,
  renameFile,
  sha256,
  statFile,
  undo,
  writeFile
} from './operations';
import { Sandbox } from './sandbox';
import { canSymlink, tempProject } from './test-utils';

// Delete and rename, their undo, and the file-content edge cases: encodings, BOMs,
// trailing newlines and empty files. Real temp folders, no fs mocks.

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
let history: History;

const hashOf = (rel: string) => sha256(readFileSync(join(project.root, rel)));
const bytes = (rel: string) => readFileSync(join(project.root, rel));
const there = (rel: string) => existsSync(join(project.root, rel));

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileOpError) return error.code;
    throw error;
  }
  throw new Error('expected a FileOpError');
}

beforeEach(async () => {
  project = tempProject('bridge-changes-');
  sandbox = await Sandbox.create(project.root);
  history = await History.open(join(project.base, 'userData/backups/p1'));
});
afterEach(() => project.cleanup());

describe('stat', () => {
  it('sizes and hashes any file, binary included', async () => {
    project.write('img.png', Buffer.from([0x89, 0x50, 0, 1, 2]));
    expect(await statFile(sandbox, 'img.png')).toEqual({ size: 5, hash: hashOf('img.png') });
  });

  it('refuses folders, missing files and the sandbox’s refusals', async () => {
    project.write('src/a.ts', 'a');
    expect(await codeOf(statFile(sandbox, 'src'))).toBe('not-a-file');
    expect(await codeOf(statFile(sandbox, 'nope.ts'))).toBe('not-found');
    expect(await codeOf(statFile(sandbox, '.env'))).toBe('denied');
    expect(await codeOf(statFile(sandbox, '../x'))).toBe('traversal');
  });
});

describe('delete', () => {
  it('backs the file up, removes it, and undo puts it back with its mode', async () => {
    const abs = project.write('src/old.ts', 'old\n');
    if (process.platform !== 'win32') chmodSync(abs, 0o750);
    const result = await deleteFile(sandbox, history, {
      path: 'src/old.ts',
      baseHash: hashOf('src/old.ts'),
      source: 'chat'
    });
    expect(there('src/old.ts')).toBe(false);
    expect(history.get(result.opId)).toMatchObject({
      kind: 'delete',
      path: 'src/old.ts',
      afterHash: null,
      source: 'chat'
    });
    await undo(sandbox, history, result.opId);
    expect(bytes('src/old.ts').toString()).toBe('old\n');
    if (process.platform !== 'win32') expect(statSync(abs).mode & 0o777).toBe(0o750);
    expect(await codeOf(undo(sandbox, history, result.opId))).toBe('already-undone');
  });

  it('deletes binary files too, and restores them byte for byte', async () => {
    const data = Buffer.from([0, 1, 2, 255, 0]);
    project.write('bin.dat', data);
    const { opId } = await deleteFile(sandbox, history, {
      path: 'bin.dat',
      baseHash: sha256(data)
    });
    await undo(sandbox, history, opId);
    expect(bytes('bin.dat').equals(data)).toBe(true);
  });

  it('refuses a stale hash, a missing file and a folder', async () => {
    project.write('a.ts', 'a');
    project.write('dir/b.ts', 'b');
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'a.ts', baseHash: '0'.repeat(64) }))
    ).toBe('conflict');
    expect(there('a.ts')).toBe(true);
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'gone.ts', baseHash: '0'.repeat(64) }))
    ).toBe('not-found');
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'dir', baseHash: '0'.repeat(64) }))
    ).toBe('not-a-file');
  });

  it.each([
    ['.env', 'denied'],
    ['.git/config', 'denied'],
    ['secrets/id_rsa', 'denied'],
    ['../outside.txt', 'traversal'],
    ['/etc/hosts', 'absolute-path']
  ])('refuses %s through the sandbox (%s)', async (path, code) => {
    expect(await codeOf(deleteFile(sandbox, history, { path, baseHash: '0'.repeat(64) }))).toBe(
      code
    );
  });

  it.runIf(canSymlink())('refuses a path through a symlink that leads outside', async () => {
    project.write('outside.txt', 'x', project.base);
    symlinkSync(join(project.base, 'outside.txt'), join(project.root, 'link.txt'));
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'link.txt', baseHash: '0'.repeat(64) }))
    ).toBe('outside-root');
    expect(existsSync(join(project.base, 'outside.txt'))).toBe(true);
  });

  it('won’t undo over a new file at the path unless forced', async () => {
    project.write('a.ts', 'mine\n');
    const { opId } = await deleteFile(sandbox, history, { path: 'a.ts', baseHash: hashOf('a.ts') });
    project.write('a.ts', 'someone else’s\n');
    expect(await codeOf(undo(sandbox, history, opId))).toBe('conflict');
    expect(bytes('a.ts').toString()).toBe('someone else’s\n');
    await undo(sandbox, history, opId, { force: true });
    expect(bytes('a.ts').toString()).toBe('mine\n');
  });

  it('refuses files over the backup cap', async () => {
    const abs = project.write('huge.bin', '');
    truncateSync(abs, MAX_BACKUP_BYTES + 1);
    expect(await codeOf(statFile(sandbox, 'huge.bin'))).toBe('too-large');
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'huge.bin', baseHash: '0'.repeat(64) }))
    ).toBe('too-large');
  });
});

describe('rename', () => {
  it('moves the file, creating folders inside the project, and undo moves it back', async () => {
    project.write('src/a.ts', 'a\n');
    const hash = hashOf('src/a.ts');
    const result = await renameFile(sandbox, history, {
      from: 'src/a.ts',
      to: 'lib/deep/b.ts',
      baseHash: hash
    });
    expect(result.hash).toBe(hash);
    expect(there('src/a.ts')).toBe(false);
    expect(bytes('lib/deep/b.ts').toString()).toBe('a\n');
    expect(history.get(result.opId)).toMatchObject({
      kind: 'rename',
      from: 'src/a.ts',
      path: 'lib/deep/b.ts'
    });
    await undo(sandbox, history, result.opId);
    expect(bytes('src/a.ts').toString()).toBe('a\n');
    expect(there('lib/deep/b.ts')).toBe(false);
  });

  it('refuses with `exists` when the target is taken, and leaves both alone', async () => {
    project.write('a.ts', 'a');
    project.write('b.ts', 'b');
    project.write('dir/x', 'x');
    const baseHash = hashOf('a.ts');
    expect(await codeOf(renameFile(sandbox, history, { from: 'a.ts', to: 'b.ts', baseHash }))).toBe(
      'exists'
    );
    expect(await codeOf(renameFile(sandbox, history, { from: 'a.ts', to: 'dir', baseHash }))).toBe(
      'exists'
    );
    expect(await codeOf(renameFile(sandbox, history, { from: 'a.ts', to: 'a.ts', baseHash }))).toBe(
      'exists'
    );
    expect(bytes('a.ts').toString()).toBe('a');
    expect(bytes('b.ts').toString()).toBe('b');
  });

  it.each([
    ['.env', 'denied'],
    ['.git/hooks/pre-commit', 'denied'],
    ['node_modules/x.js', 'denied'],
    ['../escape.ts', 'traversal'],
    ['C:/x.ts', 'absolute-path'],
    ['a/./b.ts', 'traversal']
  ])('refuses a target of %s through the sandbox (%s)', async (to, code) => {
    project.write('a.ts', 'a');
    expect(
      await codeOf(renameFile(sandbox, history, { from: 'a.ts', to, baseHash: hashOf('a.ts') }))
    ).toBe(code);
    expect(there('a.ts')).toBe(true);
  });

  it('refuses a protected source, a stale hash and a missing source', async () => {
    project.write('.env.local', 'SECRET=1');
    project.write('a.ts', 'a');
    expect(
      await codeOf(
        renameFile(sandbox, history, {
          from: '.env.local',
          to: 'env.txt',
          baseHash: '0'.repeat(64)
        })
      )
    ).toBe('denied');
    expect(
      await codeOf(
        renameFile(sandbox, history, { from: 'a.ts', to: 'b.ts', baseHash: '0'.repeat(64) })
      )
    ).toBe('conflict');
    expect(
      await codeOf(
        renameFile(sandbox, history, { from: 'gone.ts', to: 'b.ts', baseHash: '0'.repeat(64) })
      )
    ).toBe('not-found');
  });

  it('won’t undo over a changed file or a taken old path unless forced', async () => {
    project.write('a.ts', 'a\n');
    const { opId } = await renameFile(sandbox, history, {
      from: 'a.ts',
      to: 'b.ts',
      baseHash: hashOf('a.ts')
    });
    project.write('b.ts', 'edited\n');
    expect(await codeOf(undo(sandbox, history, opId))).toBe('conflict');
    await undo(sandbox, history, opId, { force: true });
    expect(bytes('a.ts').toString()).toBe('a\n');
    expect(there('b.ts')).toBe(false);
  });

  it('a case-only rename works on a case-insensitive disk, and undoes', async () => {
    // On a case-sensitive disk this is an ordinary rename; both must work.
    project.write('src/App.tsx', 'app\n');
    const result = await renameFile(sandbox, history, {
      from: 'src/App.tsx',
      to: 'src/app.tsx',
      baseHash: hashOf('src/App.tsx')
    });
    expect(readdirSync(join(project.root, 'src'))).toEqual(['app.tsx']);
    await undo(sandbox, history, result.opId);
    expect(readdirSync(join(project.root, 'src'))).toEqual(['App.tsx']);
  });
});

describe('file contents', () => {
  it('refuses non-UTF-8 files with `encoding`, and writes over them', async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
    project.write('legacy.txt', latin1);
    expect(await codeOf(readFile(sandbox, 'legacy.txt'))).toBe('encoding');
    expect(
      await codeOf(
        writeFile(sandbox, history, {
          path: 'legacy.txt',
          content: 'cafe\n',
          baseHash: sha256(latin1)
        })
      )
    ).toBe('encoding');
    expect(bytes('legacy.txt').equals(latin1)).toBe(true);
  });

  it('keeps a UTF-8 BOM: read strips it, write puts it back', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\nb\n')]);
    project.write('bom.cs', withBom);
    const read = await readFile(sandbox, 'bom.cs');
    expect(read).toMatchObject({ content: 'a\nb\n', bom: true, hash: sha256(withBom) });
    await writeFile(sandbox, history, { path: 'bom.cs', content: 'a\nc\n', baseHash: read.hash });
    expect(bytes('bom.cs').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes('bom.cs').subarray(3).toString()).toBe('a\nc\n');
    // Content that brings its own BOM doesn't get a second one.
    const again = await readFile(sandbox, 'bom.cs');
    await writeFile(sandbox, history, {
      path: 'bom.cs',
      content: '\uFEFFz\n',
      baseHash: again.hash
    });
    expect(bytes('bom.cs').toString('hex').startsWith('efbbbf7a')).toBe(true);
  });

  it('keeps a missing trailing newline missing, and a present one present', async () => {
    project.write('none.txt', 'one\ntwo');
    project.write('crlf.txt', 'one\r\ntwo');
    project.write('has.txt', 'one\n');
    await writeFile(sandbox, history, {
      path: 'none.txt',
      content: 'one\nthree\n',
      baseHash: hashOf('none.txt')
    });
    await writeFile(sandbox, history, {
      path: 'crlf.txt',
      content: 'one\nthree\n',
      baseHash: hashOf('crlf.txt')
    });
    await writeFile(sandbox, history, {
      path: 'has.txt',
      content: 'two',
      baseHash: hashOf('has.txt')
    });
    expect(bytes('none.txt').toString()).toBe('one\nthree');
    expect(bytes('crlf.txt').toString()).toBe('one\r\nthree');
    expect(bytes('has.txt').toString()).toBe('two\n');
  });

  it('reads, writes and undoes an empty file', async () => {
    project.write('empty.ts', '');
    const read = await readFile(sandbox, 'empty.ts');
    expect(read).toMatchObject({ content: '', eol: 'lf', bom: false });
    const { opId } = await writeFile(sandbox, history, {
      path: 'empty.ts',
      content: 'x\n',
      baseHash: read.hash
    });
    expect(bytes('empty.ts').toString()).toBe('x\n');
    await undo(sandbox, history, opId);
    expect(bytes('empty.ts').length).toBe(0);
    const created = await writeFile(sandbox, history, { path: 'new-empty.ts', content: '' });
    expect(created.kind).toBe('create');
    expect(bytes('new-empty.ts').length).toBe(0);
  });

  it('refuses content with a NUL as binary, before touching the disk', async () => {
    expect(await codeOf(writeFile(sandbox, history, { path: 'x.bin', content: 'a\u0000b' }))).toBe(
      'binary'
    );
    expect(there('x.bin')).toBe(false);
  });
});

describe('list', () => {
  it('lists one folder at a time with the tree’s rules', async () => {
    project.write('.gitignore', 'ignored/\n*.log\n');
    project.write('src/a.ts', 'a');
    project.write('src/.gitignore', 'secret.ts\n');
    project.write('src/secret.ts', 's');
    project.write('src/deep/b.ts', 'b');
    project.write('ignored/x.ts', 'x');
    project.write('debug.log', 'x');
    project.write('.env', 'x');
    project.write('node_modules/pkg/index.js', 'x');
    project.write('dist/out.js', 'x');
    const root = await listDir(sandbox, '');
    expect(root.entries.map((e) => e.path)).toEqual(['.gitignore', 'node_modules', 'src']);
    expect(root.entries.find((e) => e.path === 'node_modules')?.collapsed).toBe(true);
    const src = await listDir(sandbox, 'src');
    expect(src.entries.map((e) => e.path)).toEqual(['src/.gitignore', 'src/a.ts', 'src/deep']);
    expect(await codeOf(listDir(sandbox, 'ignored'))).toBe('denied');
    expect(await codeOf(listDir(sandbox, 'node_modules'))).toBe('denied');
    expect(await codeOf(listDir(sandbox, '.git'))).toBe('denied');
    expect(await codeOf(listDir(sandbox, 'src/a.ts'))).toBe('not-a-file');
    expect(await codeOf(listDir(sandbox, '../'))).toBe('traversal');
  });

  it('caps a huge folder', async () => {
    for (let i = 0; i < 30; i += 1) project.write(`many/f${String(i).padStart(2, '0')}.txt`, '');
    const result = await listDir(sandbox, 'many', 10);
    expect(result.entries).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });
});
