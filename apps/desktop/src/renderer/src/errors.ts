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
  hardlink:
    'That file has another hard link, so it could be a file outside the project. Bridge won’t touch it.',
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
  'rate-limited': 'The extension asked for too much at once, so Bridge slowed it down. Try again.',
  mode: 'This mode doesn’t do that on its own. It waits for a click.',
  gated: 'That file can change what commands do, so it always needs a click.',
  'invalid-command': 'Bridge runs single commands only, with no shell features.',
  'not-allowlisted': 'That command isn’t on the allowlist. Add it in Settings → Commands.',
  'denied-flag':
    'That command uses an option Bridge never allows (it could run other code, write files or change folders).',
  'command-not-found':
    'That program wasn’t found on the PATH. Check Settings → Commands → PATH for commands.',
  'project-binary': 'Bridge doesn’t run programs from inside the project unless allowlisted.',
  busy: 'Another command is still running. Wait for it, or cancel it.',
  'unknown-run': 'That command has already finished.',
  'background-only':
    'That command keeps running, so it’s started with @@START, not @@RUN. See Settings → Commands.',
  'not-background':
    'That command isn’t marked “Runs in the background” in Settings → Commands, so @@START refused it.',
  'too-many': 'Three background processes are running already. Stop one first.',
  'unknown-process': 'That background process isn’t running.',
  upload: 'The file didn’t arrive whole from the extension. Nothing was written.',
  'not-https': 'Bridge downloads only https:// links.',
  'private-address':
    'That link points at this computer or the local network, so Bridge didn’t download it.',
  'download-failed': 'The download didn’t finish. Nothing was written.',
  'unsupported-type':
    'That file isn’t a type Bridge saves, or isn’t the type its name says (a .png that’s really a web page, say).',
  'unsafe-svg': 'That SVG has scripts or event handlers in it, so Bridge didn’t save it.',
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
  if (entry.kind === 'run' || entry.kind === 'process' || entry.op === 'run') kinds.push('run');
  if (entry.kind === 'rejected' || entry.kind === 'failed') kinds.push('blocked');
  if (entry.trigger === 'auto') kinds.push('auto');
  return kinds;
}

/** An activity row's meta line ("Modified · via chat") and its dot. */
/** What a file change did. Its row shows an icon and the verb, coloured by kind. */
export type ResultKind = 'create' | 'modify' | 'rename' | 'delete';

/** Only a new file is green and only a delete is red; the others stay neutral. */
export const RESULT_TONES: Record<ResultKind, Tone> = {
  create: 'success',
  modify: undefined,
  rename: undefined,
  delete: 'danger'
};

export interface EntryDescription {
  /** The whole line after the time, for labels: "Created · via chat". */
  meta: string;
  /** The dot's tone, for rows that aren't file changes. */
  tone?: Tone;
  /** File changes: the kind, and the verb and the rest of `meta` to show apart. */
  result?: { kind: ResultKind; verb: string; rest: string; tone: Tone };
}

export function describeEntry(entry: ActivityEntry): EntryDescription {
  const reason = entry.code ? FILE_ERROR_LABELS[entry.code] : '';
  const via =
    entry.trigger === 'auto'
      ? entry.autoApproved
        ? ' · auto-approved'
        : ' · auto'
      : entry.source === 'chat'
        ? ' · via chat'
        : '';
  const what = entry.origin === 'download' ? ' · downloaded' : entry.binary ? ' · binary' : '';
  const done = (kind: ResultKind, verb: string, detail = ''): EntryDescription => {
    const rest = `${detail}${what}${via}${entry.undone ? ' · undone' : ''}`;
    return {
      meta: `${verb}${rest}`,
      result: { kind, verb, rest, tone: entry.undone ? undefined : RESULT_TONES[kind] }
    };
  };
  switch (entry.kind) {
    case 'create':
      return done('create', 'Created');
    case 'modify':
      return done('modify', 'Modified');
    case 'delete':
      return done('delete', 'Deleted');
    case 'rename':
      return done('rename', 'Renamed', ` from ${entry.from ?? '?'}`);
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
                : entry.op === 'download'
                  ? 'Download failed'
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
    case 'process': {
      const text = entry.text ?? '';
      return {
        meta: `Background · ${text}`,
        // A clean exit is neutral; only a failure or a kill is red.
        tone:
          text === 'started'
            ? 'success'
            : text.startsWith('exited') && text !== 'exited' && text !== 'exited (exit 0)'
              ? 'danger'
              : undefined
      };
    }
    case 'loop':
      return { meta: 'Full auto' };
  }
}
