import ignore, { type Ignore } from 'ignore';
import type {
  DeleteParams,
  FileErrorCode,
  FileOutcome,
  FileRequest,
  Mode,
  RenameParams,
  WriteParams
} from '@bridge/shared';

/**
 * Files that change what a command does, or what runs around one: installs, scripts,
 * CI and hooks. A write to one needs a click in every mode, so Auto-apply and Full auto
 * leave it on its card. .gitignore syntax, case-insensitive. Users can add patterns in
 * Settings but not remove these.
 *
 * This only closes the most direct routes. Running the tests still runs code the chat
 * wrote, and a test or config file can do anything a script can. See PLAN.md.
 */
export const DEFAULT_GATED_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.yarnrc*',
  '.pnpmfile.cjs',
  '.github/workflows/',
  '.husky/',
  '.githooks/',
  'lefthook.yml',
  '.lefthook.yml',
  '.pre-commit-config.yaml',
  'Dockerfile',
  'Makefile'
];

/** The gated list, defaults plus the user's patterns. */
export class GatedFiles {
  private readonly matcher: Ignore;

  constructor(readonly userPatterns: readonly string[] = []) {
    this.matcher = ignore({ ignorecase: true }).add([...DEFAULT_GATED_FILES, ...userPatterns]);
  }

  /** `path` is relative and POSIX. Invalid paths aren't gated; the sandbox refuses them. */
  matches(path: string): boolean {
    const rel = path.normalize('NFC');
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '')) {
      return false;
    }
    try {
      // Test as a file and as a folder, so `.husky/` covers everything under it.
      return this.matcher.ignores(rel) || this.matcher.ignores(`${rel}/`);
    } catch {
      return false;
    }
  }
}

export interface ModeStore {
  read(): { mode: 'manual' | 'auto-apply' };
  update(patch: { mode: 'manual' | 'auto-apply' }): void;
}

/**
 * The app's mode. The app is the authority: the extension only mirrors it, and the server
 * checks every automatic write and run against it.
 *
 * Full auto is never saved. Turning it on saves `manual` as the mode to start in, so a
 * restart comes back in Manual. `dropFullAuto` puts it back to Manual on unpairing and
 * switching project, and `noteSession` when a chat session starts or ends. Auto-apply is
 * saved and survives all of those.
 */
export class ModeState {
  private current: Mode;
  private root: string | null | undefined;

  constructor(
    private readonly store: ModeStore,
    private readonly onChange: (mode: Mode, previous: Mode) => void = () => {}
  ) {
    this.current = store.read().mode;
  }

  get mode(): Mode {
    return this.current;
  }

  /** Callers confirm Full auto with the user before calling this. */
  set(mode: Mode): void {
    const previous = this.current;
    this.current = mode;
    this.store.update({ mode: mode === 'full-auto' ? 'manual' : mode });
    if (mode !== previous) this.onChange(mode, previous);
  }

  /** Back to Manual if in Full auto. Returns whether it was. */
  dropFullAuto(): boolean {
    if (this.current !== 'full-auto') return false;
    this.set('manual');
    return true;
  }

  /** How many times a session starting or ending turned Full auto off. */
  sessionResets = 0;

  /**
   * A chat session started or ended. Full auto is per session, so it goes back to Manual;
   * Manual and Auto-apply stay as they are. Returns whether Full auto was on.
   */
  noteSession(): boolean {
    if (!this.dropFullAuto()) return false;
    this.sessionResets += 1;
    return true;
  }

  /** The open project, after any change. A different one ends Full auto. Returns whether it did. */
  noteProject(root: string | null): boolean {
    const switched = this.root !== undefined && root !== this.root;
    this.root = root;
    return switched && this.dropFullAuto();
  }
}

/**
 * Why the server refuses a write before it reaches the sandbox, or null. A click is always
 * allowed (the sandbox still applies). An automatic write needs Auto-apply or Full auto,
 * and never touches a gated file.
 */
export function writeRefusal(
  params: Pick<WriteParams, 'path' | 'trigger'>,
  mode: Mode,
  gated: GatedFiles
): FileErrorCode | null {
  if (params.trigger !== 'auto') return null;
  if (mode === 'manual') return 'mode';
  if (gated.matches(params.path)) return 'gated';
  return null;
}

/**
 * Why the server refuses a delete or rename before it reaches the sandbox, or null. Both
 * always need a click, in every mode: `gated` if either path is gated, else `mode`.
 */
export function changeRefusal(
  params: Pick<DeleteParams, 'path' | 'trigger'> | Pick<RenameParams, 'from' | 'to' | 'trigger'>,
  gated: GatedFiles
): FileErrorCode | null {
  if (params.trigger !== 'auto') return null;
  const paths = 'path' in params ? [params.path] : [params.from, params.to];
  return paths.some((path) => gated.matches(path)) ? 'gated' : 'mode';
}

export interface GuardedProject {
  handle(request: FileRequest): Promise<FileOutcome<unknown>>;
  /** Logs the refusal and returns it. */
  refuse(op: FileRequest['type'], path: unknown, code: FileErrorCode): FileOutcome<never>;
}

/**
 * File requests as the server answers them: `writeRefusal` (or `changeRefusal` for deletes
 * and renames) first, then the sandbox.
 */
export function guardedFiles(
  project: GuardedProject,
  mode: () => Mode,
  gated: () => GatedFiles
): (request: FileRequest) => Promise<FileOutcome<unknown>> {
  return async (request) => {
    if (request.type === 'write') {
      const refusal = writeRefusal(request.payload, mode(), gated());
      if (refusal) return project.refuse('write', request.payload.path, refusal);
    }
    if (request.type === 'delete' || request.type === 'rename') {
      const refusal = changeRefusal(request.payload, gated());
      const path = request.type === 'delete' ? request.payload.path : request.payload.from;
      if (refusal) return project.refuse(request.type, path, refusal);
    }
    return project.handle(request);
  };
}
