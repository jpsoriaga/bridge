import ignore, { type Ignore } from 'ignore';
import type {
  BridgeConfig,
  DeleteParams,
  FileErrorCode,
  FileOutcome,
  FileRequest,
  Mode,
  RenameParams,
  WriteParams
} from '@bridge/shared';

/** Full auto → "Also approve automatically". All off unless the user turns them on. */
export type AutoApprove = BridgeConfig['autoApprove'];
export const NO_AUTO_APPROVE: AutoApprove = { changes: false, gated: false, partial: false };

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
 * and never touches a gated file, unless Full auto's "Also approve automatically" allows
 * gated files.
 */
export function writeRefusal(
  params: Pick<WriteParams, 'path' | 'trigger'>,
  mode: Mode,
  gated: GatedFiles,
  approve: AutoApprove = NO_AUTO_APPROVE
): FileErrorCode | null {
  if (params.trigger !== 'auto') return null;
  if (mode === 'manual') return 'mode';
  if (gated.matches(params.path) && !(mode === 'full-auto' && approve.gated)) return 'gated';
  return null;
}

/**
 * Why the server refuses a delete or rename before it reaches the sandbox, or null. Both
 * need a click (`gated` if either path is gated, else `mode`), unless Full auto's "Also
 * approve automatically" allows deletes and renames (and gated files, for a gated path).
 */
export function changeRefusal(
  params: Pick<DeleteParams, 'path' | 'trigger'> | Pick<RenameParams, 'from' | 'to' | 'trigger'>,
  gated: GatedFiles,
  mode: Mode = 'manual',
  approve: AutoApprove = NO_AUTO_APPROVE
): FileErrorCode | null {
  if (params.trigger !== 'auto') return null;
  const paths = 'path' in params ? [params.path] : [params.from, params.to];
  const isGated = paths.some((path) => gated.matches(path));
  if (mode === 'full-auto' && approve.changes && (!isGated || approve.gated)) return null;
  return isGated ? 'gated' : 'mode';
}

export interface GuardedProject {
  /** `autoApproved`: Full auto did it only because "Also approve automatically" allows it. */
  handle(request: FileRequest, labels?: { autoApproved?: boolean }): Promise<FileOutcome<unknown>>;
  /** Logs the refusal and returns it. */
  refuse(op: FileRequest['type'], path: unknown, code: FileErrorCode): FileOutcome<never>;
  /** Forgets the chunks of a binary write that was refused before it got to them. */
  dropUpload?(uploadId: string): void;
}

/**
 * File requests as the server answers them: `writeRefusal` (or `changeRefusal` for deletes
 * and renames) first, then the sandbox. A download is never automatic, in any mode. What
 * Full auto did only because "Also approve automatically" allows it is labelled
 * `autoApproved` for Activity.
 */
export function guardedFiles(
  project: GuardedProject,
  mode: () => Mode,
  gated: () => GatedFiles,
  approve: () => AutoApprove = () => NO_AUTO_APPROVE
): (request: FileRequest) => Promise<FileOutcome<unknown>> {
  return async (request) => {
    const now = { mode: mode(), gated: gated(), approve: approve() };
    if (request.type === 'write' || request.type === 'write_binary') {
      const { payload } = request;
      const refusal = writeRefusal(payload, now.mode, now.gated, now.approve);
      if (refusal) {
        if (request.type === 'write_binary') project.dropUpload?.(request.payload.uploadId);
        return project.refuse(request.type, payload.path, refusal);
      }
      const auto = payload.trigger === 'auto';
      // Gated passed only because the setting allows it; "partial" is the extension's word,
      // kept only while the setting it relies on is on.
      const approved =
        auto &&
        ((now.gated.matches(payload.path) && now.approve.gated) ||
          (payload.autoApproved === true && now.mode === 'full-auto' && now.approve.partial));
      return project.handle(request, { autoApproved: approved });
    }
    if (request.type === 'delete' || request.type === 'rename') {
      const refusal = changeRefusal(request.payload, now.gated, now.mode, now.approve);
      const path = request.type === 'delete' ? request.payload.path : request.payload.from;
      if (refusal) return project.refuse(request.type, path, refusal);
      // Automatic at all means the setting allowed it.
      return project.handle(request, { autoApproved: request.payload.trigger === 'auto' });
    }
    if (request.type === 'download' && request.payload.trigger === 'auto') {
      return project.refuse('download', request.payload.path, 'mode');
    }
    return project.handle(request);
  };
}
