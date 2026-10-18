import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { FILE_CHANGED_MAX_PATHS, MAX_WATCHED_PATHS } from '@bridge/shared';
import { isListed, withGitignore, type GitignoreScope } from './operations';
import type { Sandbox } from './sandbox';

/** Changes settle for this long before they're reported, in one batch. */
export const WATCH_DEBOUNCE_MS = 200;
/** A project with more listed entries than this is polled (files in context only). */
export const WATCH_MAX_ENTRIES = 20_000;
/** How often polled files are checked. */
export const POLL_MS = 2_000;

/** Bridge's own temp files (`.<name>.bridge-<hex>.tmp`) are never news. */
const TEMP_FILE = /(?:^|\/)\.[^/]*\.bridge-[0-9a-f]+\.tmp$/;

export interface WatcherOptions {
  /** The sandbox now: its root, and its denylist (which the user can change). */
  sandbox: () => Sandbox;
  /** Relative POSIX paths that were added, changed or removed. `overflow`: too many to list. */
  onChange: (paths: string[], overflow: boolean) => void;
  /** The project folder itself disappeared. */
  onRootGone?: () => void;
  debounceMs?: number;
  maxEntries?: number;
  pollMs?: number;
}

const toPosix = (p: string) => p.split(sep).join('/').normalize('NFC');

/**
 * Counts what Bridge would list, the way `listTree` walks, and collects every .gitignore on
 * the way. Stops counting past `max`.
 */
async function survey(
  sandbox: Sandbox,
  max: number
): Promise<{ count: number; scopes: GitignoreScope[] }> {
  const all: GitignoreScope[] = [];
  let count = 0;
  async function walk(abs: string, rel: string, scopes: GitignoreScope[]): Promise<void> {
    const here = await withGitignore(scopes, abs, rel);
    if (here.length > scopes.length) all.push(here.at(-1)!);
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (count > max) return;
      const childRel =
        rel === '' ? dirent.name.normalize('NFC') : `${rel}/${dirent.name.normalize('NFC')}`;
      const isDir = dirent.isDirectory();
      if (!isListed(sandbox, here, childRel, isDir)) continue;
      if (isDir && dirent.name.toLowerCase() === 'node_modules') continue;
      count += 1;
      if (isDir) await walk(join(abs, dirent.name), childRel, here);
    }
  }
  await walk(sandbox.root, '', []);
  return { count, scopes: all };
}

/**
 * Watches the open project and reports changed files in debounced batches. Follows the
 * same rules as the tree: the denylist, every .gitignore, the skipped build folders and
 * `node_modules` are never watched or reported. A project with more than `maxEntries`
 * listed entries isn't watched at all; the files in context (`setPolled`) are polled
 * instead, so a huge repo costs no file handles.
 */
export class ProjectWatcher {
  mode: 'watch' | 'poll' = 'watch';
  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polled = new Map<string, string>();
  private closed = false;
  private scopes: GitignoreScope[] = [];

  private constructor(private readonly options: WatcherOptions) {}

  static async start(options: WatcherOptions): Promise<ProjectWatcher> {
    const watcher = new ProjectWatcher(options);
    await watcher.begin();
    return watcher;
  }

  private get root(): string {
    return this.options.sandbox().root;
  }

  private async begin(): Promise<void> {
    const max = this.options.maxEntries ?? WATCH_MAX_ENTRIES;
    const { count, scopes } = await survey(this.options.sandbox(), max);
    this.scopes = scopes;
    if (this.closed) return;
    if (count > max) {
      this.startPolling();
      return;
    }
    const root = this.root;
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      persistent: true,
      ignored: (path, stats) => this.ignored(path, stats?.isDirectory())
    });
    this.watcher = watcher;
    const note = (path: string) => this.note(path);
    watcher.on('add', note).on('change', note).on('unlink', note);
    watcher.on('unlinkDir', (path) => {
      if (path === root) this.options.onRootGone?.();
    });
    watcher.on('error', () => {
      // Out of file handles, or the folder went away: fall back to polling what matters.
      void watcher.close();
      this.watcher = null;
      if (!this.closed) this.startPolling();
    });
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  }

  private ignored(abs: string, isDir: boolean | undefined): boolean {
    const rel = toPosix(relative(this.root, abs));
    if (rel === '') return false;
    if (rel.startsWith('..') || TEMP_FILE.test(rel)) return true;
    if (rel.split('/').some((s) => s.toLowerCase() === 'node_modules')) return true;
    const sandbox = this.options.sandbox();
    // Without stats, ignore only what's unlisted either way; chokidar asks again with them.
    if (isDir === undefined) {
      return (
        !isListed(sandbox, this.scopes, rel, false) && !isListed(sandbox, this.scopes, rel, true)
      );
    }
    return !isListed(sandbox, this.scopes, rel, isDir);
  }

  private note(abs: string): void {
    const rel = toPosix(relative(this.root, abs));
    if (!rel || rel.startsWith('..') || TEMP_FILE.test(rel)) return;
    this.pending.add(rel);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.closed || this.pending.size === 0) return;
    const paths = [...this.pending];
    this.pending.clear();
    const overflow = paths.length > FILE_CHANGED_MAX_PATHS;
    this.options.onChange(overflow ? paths.slice(0, FILE_CHANGED_MAX_PATHS) : paths, overflow);
  }

  /** The files in context. Only polled when the project is too big to watch. */
  setPolled(paths: readonly string[]): void {
    const next = new Map<string, string>();
    for (const path of paths.slice(0, MAX_WATCHED_PATHS)) {
      next.set(path, this.polled.get(path) ?? '');
    }
    this.polled = next;
    if (this.mode === 'poll') void this.poll(true);
  }

  private startPolling(): void {
    this.mode = 'poll';
    clearInterval(this.pollTimer);
    void this.poll(true);
    this.pollTimer = setInterval(() => void this.poll(false), this.options.pollMs ?? POLL_MS);
  }

  /** Checks each polled file's size and mtime. `prime`: record without reporting. */
  private async poll(prime: boolean): Promise<void> {
    try {
      await lstat(this.root);
    } catch {
      this.options.onRootGone?.();
      return;
    }
    for (const [path, last] of this.polled) {
      let now = 'missing';
      try {
        const stats = await lstat(join(this.root, ...path.split('/')));
        now = `${stats.size}:${stats.mtimeMs}`;
      } catch {
        // Gone.
      }
      if (this.closed || !this.polled.has(path)) return;
      this.polled.set(path, now);
      if (!prime && last !== '' && last !== now) this.note(join(this.root, ...path.split('/')));
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.pollTimer);
    await this.watcher?.close();
    this.watcher = null;
  }
}
