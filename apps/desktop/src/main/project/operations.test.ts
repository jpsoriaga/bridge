import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES } from '@bridge/shared';
import { BACKUP_MAX_AGE_MS, BACKUP_MAX_OPS, History } from './history';
import {
  FileOpError,
  listDir,
  listTree,
  readFile,
  sha256,
  undo,
  writeFile,
  type WriteFs
} from './operations';
import { Sandbox } from './sandbox';
import { canSymlink, tempProject } from './test-utils';

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
let history: History;
let backups: string;

const hashOf = (rel: string) => sha256(readFileSync(join(project.root, rel)));
const onDisk = (rel: string) => readFileSync(join(project.root, rel), 'utf8');

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileOpError) return error.code;
    throw error;
  }
  throw new Error('expected a FileOpError');
}

/** Files in a folder other than the ones a test put there: temp files left behind. */
const strays = (dir: string) => readdirSync(dir).filter((name) => name.includes('.bridge-'));

beforeEach(async () => {
  project = tempProject();
  backups = join(project.base, 'userData/backups/p1');
  sandbox = await Sandbox.create(project.root);
  history = await History.open(backups);
});
afterEach(() => project.cleanup());

describe('read', () => {
  it('returns content, sha256 and EOL', async () => {
    project.write('a.txt', 'one\ntwo\n');
    project.write('b.txt', 'one\r\ntwo\r\n');
    expect(await readFile(sandbox, 'a.txt')).toEqual({
      content: 'one\ntwo\n',
      hash: hashOf('a.txt'),
      eol: 'lf',
      bom: false
    });
    expect(await readFile(sandbox, 'b.txt')).toMatchObject({
      content: 'one\r\ntwo\r\n',
      eol: 'crlf'
    });
  });

  it('refuses binary files by a NUL in the first 8KB', async () => {
    project.write('img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    expect(await codeOf(readFile(sandbox, 'img.png'))).toBe('binary');
    project.write('late.txt', Buffer.concat([Buffer.alloc(9000, 'a'), Buffer.from([0])]));
    expect((await readFile(sandbox, 'late.txt')).content).toHaveLength(9001);
  });

  it('refuses files over 1MB', async () => {
    project.write('big.txt', 'x'.repeat(MAX_FILE_BYTES + 1));
    expect(await codeOf(readFile(sandbox, 'big.txt'))).toBe('too-large');
    project.write('max.txt', 'x'.repeat(MAX_FILE_BYTES));
    expect((await readFile(sandbox, 'max.txt')).content).toHaveLength(MAX_FILE_BYTES);
  });

  it('gives not-found, not-a-file and sandbox codes', async () => {
    project.write('src/a.ts', '');
    project.write('.env', 'SECRET=1');
    expect(await codeOf(readFile(sandbox, 'missing.txt'))).toBe('not-found');
    expect(await codeOf(readFile(sandbox, 'src'))).toBe('not-a-file');
    expect(await codeOf(readFile(sandbox, '.env'))).toBe('denied');
    expect(await codeOf(readFile(sandbox, '../x'))).toBe('traversal');
  });
});

describe('write', () => {
  it('creates a new file and its parent folders, and logs it', async () => {
    const result = await writeFile(sandbox, history, { path: 'src/new/a.ts', content: 'hi\n' });
    expect(result).toMatchObject({ kind: 'create', hash: hashOf('src/new/a.ts') });
    expect(onDisk('src/new/a.ts')).toBe('hi\n');
    expect(history.get(result.opId)).toMatchObject({
      path: 'src/new/a.ts',
      kind: 'create',
      beforeHash: null,
      afterHash: result.hash
    });
    // A create records "didn't exist": a folder with no `before` file.
    // A create has nothing before it; only what it wrote is kept, for the app's diff view.
    expect(readdirSync(join(backups, result.opId))).toEqual(['after']);
  });

  it('modifies a file read with the same hash, backing up the old bytes first', async () => {
    project.write('a.txt', 'old\n');
    const { hash } = await readFile(sandbox, 'a.txt');
    const result = await writeFile(sandbox, history, {
      path: 'a.txt',
      content: 'new\n',
      baseHash: hash
    });
    expect(result.kind).toBe('modify');
    expect(onDisk('a.txt')).toBe('new\n');
    expect(readFileSync(join(backups, result.opId, 'before'), 'utf8')).toBe('old\n');
    expect(history.get(result.opId)).toMatchObject({ beforeHash: hash, afterHash: result.hash });
  });

  it('gives conflict for a stale baseHash', async () => {
    project.write('a.txt', 'v1');
    const { hash } = await readFile(sandbox, 'a.txt');
    writeFileSync(join(project.root, 'a.txt'), 'v2 from an editor');
    expect(
      await codeOf(writeFile(sandbox, history, { path: 'a.txt', content: 'v3', baseHash: hash }))
    ).toBe('conflict');
    expect(onDisk('a.txt')).toBe('v2 from an editor');
  });

  it('gives conflict for a baseHash on a file that is gone', async () => {
    expect(
      await codeOf(
        writeFile(sandbox, history, { path: 'gone.txt', content: 'x', baseHash: 'a'.repeat(64) })
      )
    ).toBe('conflict');
    expect(existsSync(join(project.root, 'gone.txt'))).toBe(false);
  });

  it('gives exists when creating over an existing file (no baseHash)', async () => {
    project.write('a.txt', 'mine');
    expect(await codeOf(writeFile(sandbox, history, { path: 'a.txt', content: 'x' }))).toBe(
      'exists'
    );
    expect(onDisk('a.txt')).toBe('mine');
  });

  it('gives exists if the file appears between the check and the write', async () => {
    const racing: WriteFs = {
      rename: fs.rename,
      realpath: (path) => fs.realpath(path),
      link: async (from, to) => {
        writeFileSync(to, 'appeared');
        return fs.link(from, to);
      }
    };
    expect(
      await codeOf(writeFile(sandbox, history, { path: 'race.txt', content: 'mine' }, racing))
    ).toBe('exists');
    expect(onDisk('race.txt')).toBe('appeared');
    expect(strays(project.root)).toEqual([]);
  });

  it('leaves no partial file when the final rename fails', async () => {
    project.write('a.txt', 'intact\n');
    const crash: WriteFs = {
      link: fs.link,
      realpath: (path) => fs.realpath(path),
      rename: async () => {
        throw Object.assign(new Error('simulated power cut'), { code: 'EIO' });
      }
    };
    await expect(
      writeFile(
        sandbox,
        history,
        { path: 'a.txt', content: 'x'.repeat(100_000), baseHash: hashOf('a.txt') },
        crash
      )
    ).rejects.toThrow('simulated power cut');
    expect(onDisk('a.txt')).toBe('intact\n');
    expect(strays(project.root)).toEqual([]);
    expect(history.list()).toEqual([]);
  });

  it('leaves no file when a create fails before landing', async () => {
    const crash: WriteFs = {
      rename: fs.rename,
      realpath: (path) => fs.realpath(path),
      link: async () => {
        throw Object.assign(new Error('simulated'), { code: 'EIO' });
      }
    };
    await expect(
      writeFile(sandbox, history, { path: 'new.txt', content: 'x' }, crash)
    ).rejects.toThrow('simulated');
    expect(readdirSync(project.root)).toEqual([]);
  });

  it('keeps CRLF files CRLF and LF files LF', async () => {
    project.write('win.txt', 'a\r\nb\r\n');
    project.write('unix.txt', 'a\nb\n');
    await writeFile(sandbox, history, {
      path: 'win.txt',
      content: 'x\ny\nz\n',
      baseHash: hashOf('win.txt')
    });
    await writeFile(sandbox, history, {
      path: 'unix.txt',
      content: 'x\r\ny\r\n',
      baseHash: hashOf('unix.txt')
    });
    expect(onDisk('win.txt')).toBe('x\r\ny\r\nz\r\n');
    expect(onDisk('unix.txt')).toBe('x\ny\n');
  });

  it('refuses content over 1MB', async () => {
    expect(
      await codeOf(
        writeFile(sandbox, history, {
          path: 'big.txt',
          content: 'é'.repeat(MAX_FILE_BYTES / 2 + 1)
        })
      )
    ).toBe('too-large');
  });

  it('refuses protected and escaping paths without creating anything', async () => {
    for (const [path, code] of [
      ['.env', 'denied'],
      ['.git/hooks/pre-commit', 'denied'],
      ['../escape.txt', 'traversal'],
      ['/tmp/x', 'absolute-path']
    ] as const) {
      expect(await codeOf(writeFile(sandbox, history, { path, content: 'x' }))).toBe(code);
    }
    expect(readdirSync(project.root)).toEqual([]);
  });

  it.runIf(canSymlink())('never creates folders through a symlink that escapes', async () => {
    const outside = join(project.base, 'outside');
    await fs.mkdir(outside);
    symlinkSync(outside, join(project.root, 'escape'), 'junction');
    expect(
      await codeOf(writeFile(sandbox, history, { path: 'escape/a/b.txt', content: 'x' }))
    ).toBe('outside-root');
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('undo', () => {
  async function modify(rel: string, content: string) {
    return writeFile(sandbox, history, { path: rel, content, baseHash: hashOf(rel) });
  }

  it('restores a modified file byte for byte', async () => {
    project.write('a.txt', 'before\r\n');
    const { opId } = await modify('a.txt', 'after\n');
    expect(await undo(sandbox, history, opId)).toEqual({ opId, path: 'a.txt' });
    expect(onDisk('a.txt')).toBe('before\r\n');
    expect(history.get(opId)?.undoneAt).toBeTypeOf('number');
    expect(await codeOf(undo(sandbox, history, opId))).toBe('already-undone');
  });

  it('removes a created file', async () => {
    const { opId } = await writeFile(sandbox, history, { path: 'src/new.ts', content: 'x' });
    await undo(sandbox, history, opId);
    expect(existsSync(join(project.root, 'src/new.ts'))).toBe(false);
  });

  it('refuses with conflict after an external edit, unless forced', async () => {
    project.write('a.txt', 'v1');
    const { opId } = await modify('a.txt', 'v2');
    writeFileSync(join(project.root, 'a.txt'), 'v3 from an editor');
    expect(await codeOf(undo(sandbox, history, opId))).toBe('conflict');
    expect(onDisk('a.txt')).toBe('v3 from an editor');
    await undo(sandbox, history, opId, { force: true });
    expect(onDisk('a.txt')).toBe('v1');
  });

  it('refuses to remove a created file that was edited since, unless forced', async () => {
    const { opId } = await writeFile(sandbox, history, { path: 'n.txt', content: 'x' });
    writeFileSync(join(project.root, 'n.txt'), 'edited');
    expect(await codeOf(undo(sandbox, history, opId))).toBe('conflict');
    expect(existsSync(join(project.root, 'n.txt'))).toBe(true);
    await undo(sandbox, history, opId, { force: true });
    expect(existsSync(join(project.root, 'n.txt'))).toBe(false);
  });

  it('refuses an older write when a newer one changed the same file', async () => {
    project.write('a.txt', 'v1');
    const first = await modify('a.txt', 'v2');
    const second = await modify('a.txt', 'v3');
    expect(await codeOf(undo(sandbox, history, first.opId))).toBe('conflict');
    await undo(sandbox, history, second.opId);
    await undo(sandbox, history, first.opId);
    expect(onDisk('a.txt')).toBe('v1');
  });

  it('gives unknown-op for an id it never issued', async () => {
    expect(await codeOf(undo(sandbox, history, 'nope'))).toBe('unknown-op');
  });
});

describe('history', () => {
  it('prunes after 7 days or 500 operations', () => {
    expect(BACKUP_MAX_AGE_MS).toBe(7 * 24 * 60 * 60_000);
    expect(BACKUP_MAX_OPS).toBe(500);
  });

  it('drops operations older than the age limit, with their backups', async () => {
    let clock = 1_000_000;
    const aged = await History.open(join(project.base, 'aged'), {
      maxAgeMs: 1_000,
      now: () => clock
    });
    const op = (opId: string) => ({
      opId,
      time: clock,
      path: `${opId}.txt`,
      kind: 'modify' as const,
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64)
    });
    await aged.backup('old', Buffer.from('x'));
    await aged.commit(op('old'));
    clock += 600;
    await aged.backup('new', Buffer.from('y'));
    await aged.commit(op('new'));
    clock += 600;
    await aged.prune();
    expect(aged.list().map((o) => o.opId)).toEqual(['new']);
    expect(existsSync(join(aged.dir, 'old'))).toBe(false);
    expect(existsSync(join(aged.dir, 'new', 'before'))).toBe(true);
  });

  it('keeps only the newest operations past the count limit', async () => {
    const capped = await History.open(join(project.base, 'capped'), { maxOps: 3 });
    const project2 = await Sandbox.create(project.root);
    for (let i = 0; i < 5; i++) {
      await writeFile(project2, capped, { path: `f${i}.txt`, content: String(i) });
    }
    expect(capped.list().map((op) => op.path)).toEqual(['f4.txt', 'f3.txt', 'f2.txt']);
    expect(readdirSync(capped.dir).filter((n) => n !== 'log.json')).toHaveLength(3);
  });

  it('removes backups of writes that never completed', async () => {
    await history.backup('orphan', Buffer.from('x'));
    await history.prune();
    expect(existsSync(join(backups, 'orphan'))).toBe(false);
  });

  it('persists the log and survives a corrupt one', async () => {
    const { opId } = await writeFile(sandbox, history, { path: 'a.txt', content: 'x' });
    expect((await History.open(backups)).get(opId)?.path).toBe('a.txt');
    writeFileSync(join(backups, 'log.json'), '{not json');
    expect((await History.open(backups)).list()).toEqual([]);
  });
});

describe('tree', () => {
  const paths = async (limits?: Parameters<typeof listTree>[1]) =>
    (await listTree(sandbox, limits)).entries.map((e) =>
      e.type === 'dir' ? `${e.path}/` : e.path
    );

  it('lists files depth-first and sorted, with sizes', async () => {
    project.write('src/b.ts', 'bb');
    project.write('src/a.ts', 'a');
    project.write('README.md', '# x');
    const tree = await listTree(sandbox);
    expect(tree.entries).toEqual([
      { path: 'README.md', type: 'file', size: 3 },
      { path: 'src', type: 'dir', size: 0 },
      { path: 'src/a.ts', type: 'file', size: 1 },
      { path: 'src/b.ts', type: 'file', size: 2 }
    ]);
    expect(tree.truncated).toBe(false);
  });

  it('respects .gitignore at the root and in subfolders', async () => {
    project.write('.gitignore', '*.log\ncoverage/\n');
    project.write('app.log', '');
    project.write('coverage/index.html', '');
    project.write('pkg/.gitignore', 'generated.ts\n');
    project.write('pkg/generated.ts', '');
    project.write('pkg/kept.ts', '');
    project.write('generated.ts', '');
    expect(await paths()).toEqual([
      '.gitignore',
      'generated.ts',
      'pkg/',
      'pkg/.gitignore',
      'pkg/kept.ts'
    ]);
  });

  it('hides the denylist and build output, and shows node_modules collapsed', async () => {
    project.write('.git/config', '');
    project.write('.env', '');
    project.write('.env.local', '');
    project.write('certs/dev.pem', '');
    project.write('id_rsa', '');
    project.write('dist/bundle.js', '');
    project.write('out/main.js', '');
    project.write('build/x', '');
    project.write('.next/cache', '');
    project.write('node_modules/react/index.js', '');
    project.write('src/index.ts', '');
    const tree = await listTree(sandbox);
    expect(tree.entries).toEqual([
      { path: 'certs', type: 'dir', size: 0 },
      { path: 'node_modules', type: 'dir', size: 0, collapsed: true },
      { path: 'src', type: 'dir', size: 0 },
      { path: 'src/index.ts', type: 'file', size: 0 }
    ]);
  });

  it('hides OS junk files from the session prompt tree and the Send files tree', async () => {
    for (const junk of ['.DS_Store', 'Thumbs.db', 'desktop.ini']) {
      project.write(junk, '');
      project.write(`src/${junk}`, '');
    }
    project.write('src/THUMBS.DB', '');
    project.write('src/index.ts', '');
    project.write('docs/.ds_store', '');
    // `tree` feeds the session prompt; `list` (and `tree`, when filtering) the side panel.
    expect(await paths()).toEqual(['docs/', 'src/', 'src/index.ts']);
    expect((await listDir(sandbox, '')).entries.map((e) => e.path)).toEqual(['docs', 'src']);
    expect((await listDir(sandbox, 'src')).entries.map((e) => e.path)).toEqual(['src/index.ts']);
    expect((await listDir(sandbox, 'docs')).entries).toEqual([]);
  });

  it('honours user deny patterns', async () => {
    project.write('secrets/a.txt', '');
    project.write('ok.txt', '');
    const custom = await Sandbox.create(project.root, ['secrets/']);
    expect((await listTree(custom)).entries.map((e) => e.path)).toEqual(['ok.txt']);
  });

  it('stops at the entry cap and flags truncation', async () => {
    for (let i = 0; i < 10; i++) project.write(`f${i}.txt`, '');
    const tree = await listTree(sandbox, { maxEntries: 4 });
    expect(tree.entries).toHaveLength(4);
    expect(tree.truncated).toBe(true);
  });

  it('stops at the depth cap and flags truncation', async () => {
    project.write('a/b/c/d.txt', '');
    project.write('top.txt', '');
    const tree = await listTree(sandbox, { maxDepth: 2 });
    expect(tree.entries.map((e) => e.path)).toEqual(['a', 'a/b', 'top.txt']);
    expect(tree.truncated).toBe(true);
  });

  it('uses 5,000 entries and depth 12 by default', async () => {
    let rel = '';
    for (let depth = 1; depth <= 13; depth++) rel = rel ? `${rel}/d${depth}` : 'd1';
    project.write(`${rel}/leaf.txt`, '');
    const tree = await listTree(sandbox);
    expect(tree.entries.at(-1)?.path.split('/')).toHaveLength(12);
    expect(tree.truncated).toBe(true);
  });

  it.runIf(canSymlink())(
    'lists inside symlinks but not escaping ones, and never descends them',
    async () => {
      const outside = join(project.base, 'outside');
      await fs.mkdir(outside);
      writeFileSync(join(outside, 'secret.txt'), 's');
      project.write('src/a.ts', 'a');
      symlinkSync(outside, join(project.root, 'escape'), 'junction');
      symlinkSync(join(project.root, 'src'), join(project.root, 'alias'), 'junction');
      symlinkSync(join(project.root, '.env'), join(project.root, 'env-link'), 'file');
      project.write('.env', 'x');
      expect(await paths()).toEqual(['alias/', 'src/', 'src/a.ts']);
    }
  );
});
