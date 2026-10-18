import { FILE_ERROR_LABELS, type FileErrorCode } from '@bridge/shared';
import type { ActivityEntry, OpenFolderResult, UndoOutcome } from '../../preload/api';

/**
 * What every error code means, in plain words, as the app says it: what happened and what
 * to do next. Never a raw code. A test checks every code has one.
 */
export const ERROR_TEXT: Record<FileErrorCode | 'cancelled', string> = {
  'no-project': 'Open a project folder first.',
  'project-missing':
    'The project folder is missing. It may have been moved, renamed or unmounted. Open it again.',
  'invalid-path': 'That isn’t a path Bridge accepts inside a project.',
  'absolute-path': 'The chat sent a path from outside the project, so Bridge refused it.',
  traversal: 'The path tried to leave the project with “..”, so Bridge refused it.',
  denied: 'That file is protected, so Bridge won’t touch it. See Settings → Project.',
  'outside-root': 'That path leads outside the project, so Bridge won’t change it.',
  'not-found': 'That file isn’t there any more.',
  'not-a-file': 'Something other than a file is at that path now.',
  binary: 'That file isn’t text, so Bridge won’t read or write it.',
  'too-large': 'That file is too large for Bridge.',
  encoding: 'That file isn’t UTF-8 text, so Bridge won’t read or overwrite it.',
  conflict: 'The file changed since Bridge last looked at it. Nothing was overwritten.',
  exists: 'Something is already at that path, so Bridge didn’t replace it.',
  'unknown-op': 'There’s nothing to undo. The backup may have expired.',
  'already-undone': 'That change was already undone.',
  'io-error': 'Bridge couldn’t finish the file operation. Check the disk and try again.',
  mode: 'This mode doesn’t do that on its own. It waits for a click.',
  gated: 'That file can change what commands do, so it always needs a click.',
  'invalid-command': 'Bridge runs single commands only, with no shell features.',
  'not-allowlisted': 'That command isn’t on the allowlist. Add it in Settings → Commands.',
  'command-not-found':
    'That program wasn’t found on the PATH. Check Settings → Commands → PATH for commands.',
  'project-binary': 'Bridge doesn’t run programs from inside the project unless allowlisted.',
  busy: 'Another command is still running. Wait for it, or cancel it.',
  'unknown-run': 'That command has already finished.',
  cancelled: 'Cancelled. Nothing changed.'
};

/** Why an undo from the app didn't happen, or null when there's nothing to say. */
export function undoError(outcome: UndoOutcome): string | null {
  if (outcome.ok || outcome.code === 'cancelled') return null;
  return ERROR_TEXT[outcome.code];
}

export const OPEN_ERRORS: Record<Exclude<OpenFolderResult, { ok: true }>['reason'], string | null> =
  {
    cancelled: null,
    'not-a-directory': 'That folder can’t be opened. It may have been moved or deleted.',
    'too-broad': 'Choose a project folder, not your home folder or the top of a disk.',
    protected: 'That folder holds Bridge’s own data. Choose a different one.'
  };

export type Tone = 'success' | 'warning' | 'danger' | undefined;

/** The kinds the Activity filter offers. */
export type ActivityKind = 'write' | 'delete' | 'rename' | 'run' | 'blocked' | 'auto';
export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'write',
  'delete',
  'rename',
  'run',
  'blocked',
  'auto'
];
export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  write: 'Writes',
  delete: 'Deletes',
  rename: 'Renames',
  run: 'Commands',
  blocked: 'Blocked',
  auto: 'Automatic'
};

/** Which filter kinds a row belongs to. */
export function kindsOf(entry: ActivityEntry): ActivityKind[] {
  const kinds: ActivityKind[] = [];
  if (entry.kind === 'create' || entry.kind === 'modify') kinds.push('write');
  if (entry.kind === 'delete') kinds.push('delete');
  if (entry.kind === 'rename') kinds.push('rename');
  if (entry.kind === 'run' || entry.op === 'run') kinds.push('run');
  if (entry.kind === 'rejected' || entry.kind === 'failed') kinds.push('blocked');
  if (entry.trigger === 'auto') kinds.push('auto');
  return kinds;
}

/** An activity row's meta line ("Modified · via chat") and its dot. */
export function describeEntry(entry: ActivityEntry): { meta: string; tone?: Tone } {
  const reason = entry.code ? FILE_ERROR_LABELS[entry.code] : '';
  const via = entry.trigger === 'auto' ? ' · auto' : entry.source === 'chat' ? ' · via chat' : '';
  const done = (verb: string) =>
    entry.undone
      ? { meta: `${verb}${via} · undone` }
      : { meta: `${verb}${via}`, tone: 'success' as const };
  switch (entry.kind) {
    case 'create':
      return done('Created');
    case 'modify':
      return done('Modified');
    case 'delete':
      return entry.undone
        ? { meta: `Deleted${via} · undone` }
        : { meta: `Deleted${via}`, tone: 'danger' };
    case 'rename':
      return done(`Renamed from ${entry.from ?? '?'}`);
    case 'rejected':
      return { meta: `Blocked ${entry.op ?? 'request'} · ${reason}`, tone: 'danger' };
    case 'failed': {
      if (entry.code === 'gated' || entry.code === 'mode') {
        return { meta: `Left for a click · ${reason}`, tone: 'warning' };
      }
      const what =
        entry.op === 'undo'
          ? 'Undo failed'
          : entry.op === 'run'
            ? 'Command refused'
            : entry.op === 'delete'
              ? 'Delete failed'
              : entry.op === 'rename'
                ? 'Rename failed'
                : 'Write failed';
      return { meta: `${what} · ${reason}`, tone: 'danger' };
    }
    case 'run': {
      const run = entry.run;
      if (!run) return { meta: `Ran${via}` };
      const seconds = ` · ${(run.durationMs / 1000).toFixed(1)}s`;
      if (run.status === 'exited') {
        return run.exitCode === 0
          ? { meta: `Passed${seconds}${via}`, tone: 'success' }
          : { meta: `Exit ${run.exitCode ?? '?'}${seconds}${via}`, tone: 'danger' };
      }
      const label =
        run.status === 'timed-out'
          ? 'Timed out'
          : run.status === 'cancelled'
            ? 'Cancelled'
            : 'Couldn’t start';
      return {
        meta: `${label}${seconds}${via}`,
        tone: run.status === 'cancelled' ? undefined : 'danger'
      };
    }
    case 'loop':
      return { meta: 'Full auto' };
  }
}
