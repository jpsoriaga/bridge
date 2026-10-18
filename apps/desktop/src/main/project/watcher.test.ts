import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from './sandbox';
import { tempProject } from './test-utils';
import { ProjectWatcher } from './watcher';

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
let watcher: ProjectWatcher | null;
let batches: { paths: string[]; overflow: boolean }[];
let gone: number;

const changed = () => [...new Set(batches.flatMap((b) => b.paths))].sort();

// File events can lag a lot while the rest of the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const quiet = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/**
 * Writes a file until the watcher reports it. Under heavy load the OS can drop a watch
 * event outright; Bridge copes (stale checks rerun on reconnect, Apply compares hashes),
 * and the tests shouldn't hang on it.
 */
async function writeUntilSeen(rel: string): Promise<void> {
  for (let i = 0; i < 40 && !changed().includes(rel); i += 1) {
    project.write(rel, `v${i}`);
    await quiet(500);
  }
  expect(changed()).toContain(rel);
}

async function start(options: { maxEntries?: number } = {}) {
  watcher = await ProjectWatcher.start({
    sandbox: () => sandbox,
    onChange: (paths, overflow) => batches.push({ paths, overflow }),
    onRootGone: () => {
      gone += 1;
    },
    debounceMs: 50,
    pollMs: 100,
    ...options
  });
  return watcher;
}

beforeEach(async () => {
  project = tempProject('bridge-watch-');
  project.write('.gitignore', 'ignored/\n');
  project.write('src/a.ts', 'a');
  project.write('ignored/x.ts', 'x');
  sandbox = await Sandbox.create(project.root);
  batches = [];
  gone = 0;
  watcher = null;
});
afterEach(async () => {
  await watcher?.close();
  project.cleanup();
});

describe('ProjectWatcher', () => {
  it('reports added, changed and removed files in debounced batches', async () => {
    await start();
    expect(watcher!.mode).toBe('watch');
    await writeUntilSeen('src/a.ts');
    await writeUntilSeen('src/new.ts');
    await quiet();
    const before = batches.length;
    rmSync(join(project.root, 'src/new.ts'));
    await until(() => batches.slice(before).some((b) => b.paths.includes('src/new.ts')));
    expect(changed()).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('never reports denied, ignored, node_modules or Bridge temp files', async () => {
    project.write('node_modules/pkg/index.js', 'x');
    await start();
    project.write('.env', 'SECRET=1');
    project.write('ignored/y.ts', 'y');
    project.write('node_modules/pkg/other.js', 'x');
    project.write('src/.a.ts.bridge-abc123.tmp', 'tmp');
    await writeUntilSeen('src/visible.ts');
    await quiet();
    // Only what Bridge lists. (A late event for a file written before the watch began is
    // harmless: it only makes the extension compare a hash.)
    for (const path of changed()) {
      expect(path).not.toMatch(/^(?:\.env|ignored\/|node_modules\/)|\.bridge-[0-9a-f]+\.tmp$/);
    }
  });

  it('polls only the files in context when the project is too big to watch', async () => {
    await start({ maxEntries: 1 });
    expect(watcher!.mode).toBe('poll');
    watcher!.setPolled(['src/a.ts']);
    await quiet(250);
    project.write('src/other.ts', 'not in context');
    await writeUntilSeen('src/a.ts');
    await quiet(250);
    expect(changed()).not.toContain('src/other.ts');
  });

  it('says so when the project folder disappears', async () => {
    await start({ maxEntries: 1 });
    renameSync(project.root, `${project.root}-moved`);
    await until(() => gone > 0);
  });
});
