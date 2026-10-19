import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import {
  FILE_ERROR_MESSAGES,
  MAX_FILE_BYTES,
  type FileErrorCode,
  type FileOutcome,
  type FileRequest,
  type ProjectInfo,
  type UndoResult
} from '@bridge/shared';
import type { ActivityEntry } from '../../preload/api';
import { History, projectId } from './history';
import {
  decodeText,
  deleteFile,
  FileOpError,
  listDir,
  listTree,
  readFile,
  renameFile,
  statFile,
  undo,
  writeFile
} from './operations';
import { Sandbox } from './sandbox';
import { ProjectWatcher } from './watcher';

export const MAX_RECENT_PROJECTS = 5;
const MAX_ACTIVITY = 100;
const MAX_SESSION_EVENTS = 200;

/** Codes that mean the sandbox refused the path itself. Shown as "Blocked". */
const SANDBOX_CODES: ReadonlySet<FileErrorCode> = new Set([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  'hardlink'
]);

export type OpenProjectResult =
  | { ok: true; project: ProjectInfo }
  | { ok: false; reason: 'not-a-directory' | 'too-broad' | 'protected' };

/** The part of settings.json this service owns. */
export interface ProjectSettings {
  read(): { project?: string; recentProjects: string[]; denyPatterns: string[] };
  update(patch: { project?: string; recentProjects?: string[]; denyPatterns?: string[] }): void;
}

export interface ProjectServiceOptions {
  settings: ProjectSettings;
  /** `userData/backups`. One subfolder per project. */
  backupsDir: string;
  homeDir: string;
  /** Folders a project may not be, contain, or sit inside (userData). */
  protectedDirs: readonly string[];
  /** Project, recents or deny patterns changed. */
  onChange?: () => void;
  /** Activity changed. */
  onActivity?: () => void;
  /** Watch the open project and report changed files here. Off unless given. */
  onFilesChanged?: (paths: string[], overflow: boolean) => void;
  /** How long ops and backups are kept. Read when a project opens. */
  retentionMs?: () => number;
}

/** One op as the app's diff viewer shows it: the text before and after, when it's text. */
export interface OpDetail {
  opId: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  from?: string;
  time: number;
  undone: boolean;
  /** Null: nothing there (a create's before, a delete's after). */
  before: string | null;
  after: string | null;
  /** Why there's no text to show: binary, too big, or the backup is gone. */
  unavailable?: 'binary' | 'too-large' | 'missing';
}

interface OpenProject {
  info: ProjectInfo;
  sandbox: Sandbox;
  history: History;
  watcher: ProjectWatcher | null;
  /** The folder is gone (deleted, moved, unmounted). Every operation fails until it's back. */
  missing: boolean;
}

/** Replaces control characters and caps length, for paths the extension sent. */
export function displayPath(input: unknown): string {
  if (typeof input !== 'string') return '(not a path)';
  // eslint-disable-next-line no-control-regex
  const clean = input.replace(/[\x00-\x1f\x7f]/g, '�');
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}

const isInside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * The open project folder and everything that touches it. File operations from the
 * extension and undo from the app all come through here, and writes run one at a time.
 */
export class ProjectService {
  private current: OpenProject | null = null;
  private sessionEvents: ActivityEntry[] = [];
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ProjectServiceOptions) {}

  get project(): ProjectInfo | null {
    if (!this.current) return null;
    return this.current.missing ? { ...this.current.info, missing: true } : this.current.info;
  }

  /** How the open project is watched: every change, or only the files in context. */
  get watchMode(): 'watch' | 'poll' | null {
    return this.current?.watcher?.mode ?? null;
  }

  /** The open project's real path. Main-process only; never sent to the extension. */
  get root(): string | null {
    return this.current?.sandbox.root ?? null;
  }

  /** Stable id of the open project, for per-project settings. */
  get projectKey(): string | null {
    return this.current ? projectId(this.current.sandbox.root) : null;
  }

  get recentProjects(): ProjectInfo[] {
    return this.options.settings.read().recentProjects.map((path) => this.describe(path));
  }

  get denyPatterns(): string[] {
    return this.options.settings.read().denyPatterns;
  }

  /** Reopens the last project if it still exists. */
  async restore(): Promise<void> {
    const { project } = this.options.settings.read();
    if (project === undefined) return;
    const result = await this.open(project).catch(() => null);
    if (!result?.ok) this.options.settings.update({ project: undefined });
  }

  /** `dir` comes from the native folder dialog or the recent list, never the renderer. */
  open(dir: string): Promise<OpenProjectResult> {
    return this.exclusive(async () => {
      let real: string;
      try {
        if (!(await stat(dir)).isDirectory()) return { ok: false, reason: 'not-a-directory' };
        real = await realpath(dir);
      } catch {
        return { ok: false, reason: 'not-a-directory' };
      }
      const home = await realpath(this.options.homeDir).catch(() => this.options.homeDir);
      if (dirname(real) === real || real === home) return { ok: false, reason: 'too-broad' };
      for (const dir of this.options.protectedDirs) {
        const guarded = await realpath(dir).catch(() => dir);
        if (isInside(real, guarded) || isInside(guarded, real)) {
          return { ok: false, reason: 'protected' };
        }
      }

      const sandbox = await Sandbox.create(real, this.denyPatterns);
      const history = await History.open(join(this.options.backupsDir, projectId(real)), {
        ...(this.options.retentionMs && { maxAgeMs: this.options.retentionMs() })
      });
      const info = this.describe(real);
      await this.current?.watcher?.close();
      this.current = { info, sandbox, history, watcher: null, missing: false };
      this.sessionEvents = [];
      void this.watch(this.current);

      const { recentProjects } = this.options.settings.read();
      this.options.settings.update({
        project: real,
        recentProjects: [real, ...recentProjects.filter((p) => p !== real)].slice(
          0,
          MAX_RECENT_PROJECTS
        )
      });
      this.options.onChange?.();
      this.options.onActivity?.();
      return { ok: true, project: info };
    });
  }

  /** Starts watching `project`, if this service reports changes. */
  private async watch(project: OpenProject): Promise<void> {
    const onFilesChanged = this.options.onFilesChanged;
    if (!onFilesChanged) return;
    try {
      const watcher = await ProjectWatcher.start({
        sandbox: () => project.sandbox,
        onChange: (paths, overflow) => {
          if (this.current === project) onFilesChanged(paths, overflow);
        },
        onRootGone: () => void this.checkRoot()
      });
      if (this.current !== project) await watcher.close();
      else project.watcher = watcher;
    } catch {
      // Can't watch (permissions, odd filesystem). Stale checks fall back to on-demand stats.
    }
  }

  /**
   * Whether the project folder is still there. Notices it going (deleted, moved, renamed,
   * unmounted) and coming back, and tells the app either way. Returns false while missing.
   */
  async checkRoot(): Promise<boolean> {
    const project = this.current;
    if (!project) return false;
    let present: boolean;
    try {
      present = (await stat(project.sandbox.root)).isDirectory();
    } catch {
      present = false;
    }
    if (this.current !== project || present !== project.missing) return present;
    project.missing = !present;
    if (present) {
      // Back (remounted): watch it again.
      await project.watcher?.close();
      project.watcher = null;
      void this.watch(project);
    } else {
      await project.watcher?.close();
      project.watcher = null;
    }
    this.options.onChange?.();
    return present;
  }

  /** The files in context, polled when the project is too big to watch. */
  watchFiles(paths: readonly string[]): 'watch' | 'poll' {
    this.current?.watcher?.setPolled(paths);
    return this.watchMode ?? 'poll';
  }

  /** The open project's backups folder (main only; for "Open the backups folder"). */
  get backupsPath(): string | null {
    return this.current?.history.dir ?? null;
  }

  /** A new retention period, applied (and pruned) now. */
  async setRetention(ms: number): Promise<void> {
    await this.current?.history.setMaxAge(ms);
    this.options.onActivity?.();
  }

  /** Deletes every backup for the open project. Undo is gone for all of it. */
  async clearHistory(): Promise<void> {
    const project = this.current;
    if (!project) return;
    await this.exclusive(() => project.history.clear());
    this.options.onActivity?.();
  }

  /** Before and after text of one op, for the app's diff viewer. */
  async opDetail(opId: string): Promise<OpDetail | null> {
    const history = this.current?.history;
    const op = history?.get(opId);
    if (!history || !op) return null;
    const detail: OpDetail = {
      opId,
      kind: op.kind,
      path: op.path,
      ...(op.from && { from: op.from }),
      time: op.time,
      undone: op.undoneAt !== undefined,
      before: null,
      after: null
    };
    const text = (data: Buffer | null): string | null => {
      if (data === null) return null;
      if (data.length > MAX_FILE_BYTES) throw new FileOpError('too-large');
      return decodeText(data).content;
    };
    try {
      const before = op.kind === 'create' ? null : await history.readBackup(opId).catch(() => null);
      if (op.kind !== 'create' && before === null) return { ...detail, unavailable: 'missing' };
      detail.before = text(before);
      if (op.kind === 'rename') detail.after = detail.before;
      else if (op.kind !== 'delete') {
        const after = await history.readAfter(opId);
        // Writes from before Bridge kept what it wrote: nothing to compare against.
        if (after === null) return { ...detail, unavailable: 'missing' };
        detail.after = text(after);
      }
    } catch (error) {
      const code = error instanceof FileOpError ? error.code : 'io-error';
      return {
        ...detail,
        before: null,
        after: null,
        unavailable: code === 'too-large' ? 'too-large' : 'binary'
      };
    }
    return detail;
  }

  /** Stops watching. For quitting. */
  async close(): Promise<void> {
    await this.current?.watcher?.close();
  }

  openRecent(index: number): Promise<OpenProjectResult> | null {
    const path = this.options.settings.read().recentProjects[index];
    return path === undefined ? null : this.open(path);
  }

  /** Replaces the user's extra deny patterns and rebuilds the sandbox. */
  async setDenyPatterns(patterns: string[]): Promise<void> {
    await this.exclusive(async () => {
      this.options.settings.update({ denyPatterns: patterns });
      if (this.current) {
        this.current.sandbox = await Sandbox.create(this.current.sandbox.root, patterns);
      }
    });
    this.options.onChange?.();
  }

  /** A file request from the extension. Never throws; never returns an absolute path. */
  async handle(request: FileRequest): Promise<FileOutcome<unknown>> {
    const project = this.current;
    const payload = request.payload as { path?: unknown; from?: unknown };
    const path = payload.path ?? payload.from;
    if (!project) return this.fail(request.type, path, 'no-project');
    if (!(await this.checkRoot())) return this.fail(request.type, path, 'project-missing');
    try {
      switch (request.type) {
        case 'tree':
          return { ok: true, result: await listTree(project.sandbox) };
        case 'list':
          return { ok: true, result: await listDir(project.sandbox, request.payload.dir) };
        case 'read':
          return { ok: true, result: await readFile(project.sandbox, request.payload.path) };
        case 'stat':
          return { ok: true, result: await statFile(project.sandbox, request.payload.path) };
        case 'write':
          return await this.change(() =>
            writeFile(project.sandbox, project.history, request.payload)
          );
        case 'delete':
          return await this.change(() =>
            deleteFile(project.sandbox, project.history, request.payload)
          );
        case 'rename':
          return await this.change(() =>
            renameFile(project.sandbox, project.history, request.payload)
          );
        case 'undo':
          return await this.undo(request.payload.opId);
        case 'watch':
          return { ok: true, result: { mode: this.watchFiles(request.payload.paths) } };
      }
    } catch (error) {
      return this.fail(request.type, path, error instanceof FileOpError ? error.code : 'io-error');
    }
  }

  /** A write, delete or rename: one at a time, then the activity list updates. */
  private async change<T>(fn: () => Promise<T>): Promise<FileOutcome<T>> {
    const result = await this.exclusive(fn);
    this.options.onActivity?.();
    return { ok: true, result };
  }

  /** From the app (with `force` after the user confirms) or the extension (never forced). */
  async undo(opId: string, options: { force?: boolean } = {}): Promise<FileOutcome<UndoResult>> {
    const project = this.current;
    if (!project) return this.fail('undo', undefined, 'no-project');
    const path = project.history.get(opId)?.path;
    if (!(await this.checkRoot())) return this.fail('undo', path, 'project-missing');
    try {
      const result = await this.exclusive(() =>
        undo(project.sandbox, project.history, opId, options)
      );
      this.options.onActivity?.();
      return { ok: true, result };
    } catch (error) {
      return this.fail('undo', path, error instanceof FileOpError ? error.code : 'io-error');
    }
  }

  /** Adds a row for something that isn't a write: a command, a Full auto step, a refusal. */
  record(entry: Omit<ActivityEntry, 'id' | 'time'>): void {
    if (!this.current) return;
    this.sessionEvents.unshift({ id: randomUUID(), time: Date.now(), ...entry });
    this.sessionEvents.length = Math.min(this.sessionEvents.length, MAX_SESSION_EVENTS);
    this.options.onActivity?.();
  }

  /** A write the server refused before the sandbox (mode or gated file). */
  refuse(op: FileRequest['type'], path: unknown, code: FileErrorCode) {
    return this.fail(op, path, code);
  }

  /** A small text file at the project root (e.g. package.json), through the sandbox. */
  async readText(path: string): Promise<string | null> {
    const project = this.current;
    if (!project) return null;
    try {
      return (await readFile(project.sandbox, path)).content;
    } catch {
      return null;
    }
  }

  /** The newest write that can still be undone. */
  lastUndoable(): string | null {
    return this.current?.history.lastUndoable()?.opId ?? null;
  }

  pathOf(opId: string): string | null {
    return this.current?.history.get(opId)?.path ?? null;
  }

  /** Writes from the log plus this session's refusals, newest first. */
  activity(): ActivityEntry[] {
    if (!this.current) return [];
    const writes: ActivityEntry[] = this.current.history.list().map((op) => ({
      id: op.opId,
      time: op.time,
      kind: op.kind,
      path: op.path,
      opId: op.opId,
      undone: op.undoneAt !== undefined,
      ...(op.from && { from: op.from }),
      ...(op.source && { source: op.source }),
      ...(op.trigger && { trigger: op.trigger }),
      ...(op.loopId && { loopId: op.loopId })
    }));
    return [...writes, ...this.sessionEvents]
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_ACTIVITY);
  }

  private fail(op: FileRequest['type'], path: unknown, code: FileErrorCode) {
    // Reads that simply miss aren't worth a row; refusals and failed changes are.
    const change = op === 'write' || op === 'delete' || op === 'rename' || op === 'undo';
    if (SANDBOX_CODES.has(code) || change || code === 'io-error') {
      this.sessionEvents.unshift({
        id: randomUUID(),
        time: Date.now(),
        kind: SANDBOX_CODES.has(code) ? 'rejected' : 'failed',
        path: path === undefined ? '' : displayPath(path),
        code,
        op
      });
      this.sessionEvents.length = Math.min(this.sessionEvents.length, MAX_SESSION_EVENTS);
      this.options.onActivity?.();
    }
    return { ok: false as const, error: { code, message: FILE_ERROR_MESSAGES[code] } };
  }

  private describe(real: string): ProjectInfo {
    const home = this.options.homeDir;
    const path = isInside(real, home) ? `~${real.slice(home.length)}` : real;
    return { name: basename(real) || real, path };
  }

  /** Runs `fn` after every earlier exclusive task, even failed ones. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }
}
