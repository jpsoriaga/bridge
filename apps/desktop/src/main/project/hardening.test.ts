import { linkSync, mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History } from './history';
import {
  deleteFile,
  FileOpError,
  openRead,
  readFile,
  renameFile,
  sha256,
  statFile,
  undo,
  writeFile,
  type WriteFs
} from './operations';
import { Sandbox } from './sandbox';
import { canSymlink, tempProject } from './test-utils';

// Phase 7: hard links, a folder swapped for a symlink just before the commit, and opens
// that never follow a symlink. Real temp folders, no fs mocks.

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
let history: History;

const hashOf = (rel: string) => sha256(readFileSync(join(project.root, rel)));
const posix = process.platform !== 'win32';

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
  project = tempProject();
  sandbox = await Sandbox.create(project.root);
  history = await History.open(join(project.base, 'userData/backups/p1'));
});
afterEach(() => project.cleanup());

describe('hard links', () => {
  /** A file outside the project with a second name inside it. */
  function linkedIn(rel = 'linked.txt') {
    const outside = project.write('secret.txt', 'outside the project\n', project.base);
    linkSync(outside, join(project.root, rel));
    return outside;
  }

  it('refuses to read or stat a file with more than one link', async () => {
    linkedIn();
    expect(await codeOf(readFile(sandbox, 'linked.txt'))).toBe('hardlink');
    expect(await codeOf(statFile(sandbox, 'linked.txt'))).toBe('hardlink');
  });

  it('refuses to modify, delete or rename one, and leaves the outside file alone', async () => {
    const outside = linkedIn();
    const baseHash = hashOf('linked.txt');
    expect(
      await codeOf(
        writeFile(sandbox, history, { path: 'linked.txt', content: 'overwritten\n', baseHash })
      )
    ).toBe('hardlink');
    expect(await codeOf(deleteFile(sandbox, history, { path: 'linked.txt', baseHash }))).toBe(
      'hardlink'
    );
    expect(
      await codeOf(renameFile(sandbox, history, { from: 'linked.txt', to: 'moved.txt', baseHash }))
    ).toBe('hardlink');
    expect(readFileSync(outside, 'utf8')).toBe('outside the project\n');
    expect(history.list()).toEqual([]);
  });

  it('refuses to undo onto a file that gained a second link since', async () => {
    project.write('a.txt', 'one\n');
    const { opId } = await writeFile(sandbox, history, {
      path: 'a.txt',
      content: 'two\n',
      baseHash: hashOf('a.txt')
    });
    linkSync(join(project.root, 'a.txt'), join(project.base, 'elsewhere.txt'));
    expect(await codeOf(undo(sandbox, history, opId))).toBe('hardlink');
    expect(readFileSync(join(project.base, 'elsewhere.txt'), 'utf8')).toBe('two\n');
  });

  it('still reads a file once its other link is gone', async () => {
    linkedIn();
    await fs.rm(join(project.base, 'secret.txt'));
    expect((await readFile(sandbox, 'linked.txt')).content).toBe('outside the project\n');
  });
});

/** A new, empty project (for a second case in one test). */
async function fresh() {
  project.cleanup();
  project = tempProject();
  sandbox = await Sandbox.create(project.root);
  history = await History.open(join(project.base, 'userData/backups/p1'));
}

describe.runIf(canSymlink())('a folder swapped for a symlink right before the commit', () => {
  /** Between the sandbox check and the commit, `src` becomes a link to a folder outside. */
  function swapping(): { writeFs: WriteFs; outside: string } {
    const outside = join(project.base, 'outside');
    mkdirSync(outside, { recursive: true });
    let swapped = false;
    const writeFs: WriteFs = {
      rename: fs.rename,
      link: fs.link,
      realpath: async (path) => {
        if (!swapped) {
          swapped = true;
          renameSync(join(project.root, 'src'), join(project.base, 'src-moved'));
          symlinkSync(outside, join(project.root, 'src'), 'junction');
        }
        return fs.realpath(path);
      }
    };
    return { writeFs, outside };
  }

  it('aborts a create and a modify, writing nothing outside', async () => {
    project.write('src/a.ts', 'one\n');
    const { writeFs, outside } = swapping();
    expect(
      await codeOf(
        writeFile(
          sandbox,
          history,
          { path: 'src/a.ts', content: 'two\n', baseHash: hashOf('src/a.ts') },
          writeFs
        )
      )
    ).toBe('outside-root');
    expect(await fs.readdir(outside)).toEqual([]);

    await fresh();
    project.write('src/keep.ts', 'x\n');
    const second = swapping();
    expect(
      await codeOf(
        writeFile(sandbox, history, { path: 'src/new.ts', content: 'new\n' }, second.writeFs)
      )
    ).toBe('outside-root');
    expect(await fs.readdir(second.outside)).toEqual([]);
  });

  it('aborts a delete and a rename', async () => {
    project.write('src/a.ts', 'one\n');
    const outsideCopy = project.write('outside/a.ts', 'outside\n', project.base);
    const baseHash = hashOf('src/a.ts');
    const first = swapping();
    expect(
      await codeOf(deleteFile(sandbox, history, { path: 'src/a.ts', baseHash }, first.writeFs))
    ).toBe('outside-root');
    expect(readFileSync(outsideCopy, 'utf8')).toBe('outside\n');

    await fresh();
    project.write('src/a.ts', 'one\n');
    const second = swapping();
    expect(
      await codeOf(
        renameFile(
          sandbox,
          history,
          { from: 'src/a.ts', to: 'src/b.ts', baseHash: hashOf('src/a.ts') },
          second.writeFs
        )
      )
    ).toBe('outside-root');
    expect(await fs.readdir(second.outside)).toEqual([]);
  });

  it('commits as before when nothing moved', async () => {
    project.write('src/a.ts', 'one\n');
    const writeFs: WriteFs = {
      rename: fs.rename,
      link: fs.link,
      realpath: (path) => fs.realpath(path)
    };
    await writeFile(
      sandbox,
      history,
      { path: 'src/a.ts', content: 'two\n', baseHash: hashOf('src/a.ts') },
      writeFs
    );
    expect(readFileSync(join(project.root, 'src/a.ts'), 'utf8')).toBe('two\n');
  });
});

describe.runIf(posix && canSymlink())('opens never follow a symlink', () => {
  it('refuses a symlink in the last component as outside-root', async () => {
    const target = project.write('real.txt', 'x\n');
    symlinkSync(target, join(project.root, 'link.txt'));
    expect(await codeOf(openRead(join(project.root, 'link.txt')))).toBe('outside-root');
    const handle = await openRead(target);
    await handle.close();
  });
});
