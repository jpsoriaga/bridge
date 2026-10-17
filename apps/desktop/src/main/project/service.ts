import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import {
  FILE_ERROR_MESSAGES,
  type FileErrorCode,
  type FileOutcome,
  type FileRequest,
  type ProjectInfo,
  type UndoResult
} from '@bridge/shared';
import type { ActivityEntry } from '../../preload/api';
import { History, projectId } from './history';
import { FileOpError, listTree, readFile, undo, writeFile } from './operations';
import { Sandbox } from './sandbox';

export const MAX_RECENT_PROJECTS = 5;
const MAX_ACTIVITY = 100;
const MAX_SESSION_EVENTS = 200;

/** Codes that mean the sandbox refused the path itself. Shown as "Blocked". */
const SANDBOX_CODES: ReadonlySet<FileErrorCode> = new Set([
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root'
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
}

interface OpenProject {
  info: ProjectInfo;
  sandbox: Sandbox;
  history: History;
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
    return this.current?.info ?? null;
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
      const history = await History.open(join(this.options.backupsDir, projectId(real)));
      const info = this.describe(real);
      this.current = { info, sandbox, history };
      this.sessionEvents = [];

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
    const path = 'path' in request.payload ? request.payload.path : undefined;
    if (!project) return this.fail(request.type, path, 'no-project');
    try {
      switch (request.type) {
        case 'tree':
          return { ok: true, result: await listTree(project.sandbox) };
        case 'read':
          return { ok: true, result: await readFile(project.sandbox, request.payload.path) };
        case 'write': {
          const result = await this.exclusive(() =>
            writeFile(project.sandbox, project.history, request.payload)
          );
          this.options.onActivity?.();
          return { ok: true, result };
        }
        case 'undo':
          return await this.undo(request.payload.opId);
      }
    } catch (error) {
      return this.fail(request.type, path, error instanceof FileOpError ? error.code : 'io-error');
    }
  }

  /** From the app (with `force` after the user confirms) or the extension (never forced). */
  async undo(opId: string, options: { force?: boolean } = {}): Promise<FileOutcome<UndoResult>> {
    const project = this.current;
    if (!project) return this.fail('undo', undefined, 'no-project');
    const path = project.history.get(opId)?.path;
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
      ...(op.source && { source: op.source }),
      ...(op.trigger && { trigger: op.trigger }),
      ...(op.loopId && { loopId: op.loopId })
    }));
    return [...writes, ...this.sessionEvents]
      .sort((a, b) => b.time - a.time)
      .slice(0, MAX_ACTIVITY);
  }

  private fail(op: FileRequest['type'], path: unknown, code: FileErrorCode) {
    // Reads that simply miss aren't worth a row; refusals and failed writes are.
    if (SANDBOX_CODES.has(code) || op === 'write' || op === 'undo' || code === 'io-error') {
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
