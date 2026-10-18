import { z } from 'zod';

// Project files over the socket: tree, list, read, stat, write, delete, rename, undo and
// watch. The desktop's sandbox decides what is allowed; these schemas only bound the shapes.

/** Largest file Bridge reads or writes, in bytes (UTF-8). */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Longest relative path the sandbox accepts, in characters after NFC. */
export const MAX_PATH_LENGTH = 1024;
export const TREE_MAX_ENTRIES = 5_000;
export const TREE_MAX_DEPTH = 12;
/** One folder's listing (`list`), for trees that load a folder at a time. */
export const LIST_MAX_ENTRIES = 2_000;
/**
 * Largest file Bridge deletes, renames or hashes with `stat`. Bigger than MAX_FILE_BYTES:
 * these never send the content, but the backup still holds a copy.
 */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
/** Files in context the desktop polls when the project is too big to watch. */
export const MAX_WATCHED_PATHS = 500;

/**
 * Every reason a request (file operation or command) can fail. Rejections never include
 * an absolute path.
 */
export const FILE_ERROR_CODES = [
  'no-project',
  /** The open project's folder is gone: deleted, moved, renamed or unmounted. */
  'project-missing',
  // Sandbox: the path itself.
  'invalid-path',
  'absolute-path',
  'traversal',
  'denied',
  'outside-root',
  // The file.
  'not-found',
  'not-a-file',
  'binary',
  'too-large',
  /** Not UTF-8 text. Bridge neither reads nor overwrites it. */
  'encoding',
  // Concurrency.
  'conflict',
  'exists',
  // Undo.
  'unknown-op',
  'already-undone',
  'io-error',
  // Modes: an automatic write or run the current mode doesn't allow, or a gated file.
  'mode',
  'gated',
  // Commands.
  'invalid-command',
  'not-allowlisted',
  'command-not-found',
  'project-binary',
  'busy',
  'unknown-run'
] as const;
export const FileErrorCode = z.enum(FILE_ERROR_CODES);
export type FileErrorCode = z.infer<typeof FileErrorCode>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
/** Upper bounds only. The sandbox applies the real rules and returns a typed error. */
const RelPath = z
  .string()
  .min(1)
  .max(4 * MAX_PATH_LENGTH);
export const OpId = z.string().regex(/^[0-9a-z-]{1,64}$/);
export const RunId = z.string().regex(/^[0-9a-z-]{1,64}$/);
/** One Full auto run. Writes and runs it makes carry it, so the app can group them. */
export const LoopId = z.string().regex(/^[\w-]{1,64}$/);

/**
 * `click`: the user pressed a button for this. `auto`: Bridge did it on its own (Auto-apply,
 * Full auto). The desktop refuses `auto` writes in Manual mode and `auto` runs outside
 * Full auto.
 */
export const Trigger = z.enum(['click', 'auto']);
export type Trigger = z.infer<typeof Trigger>;

export const ProjectInfo = z.strictObject({
  name: z.string().max(256),
  /** For display. The home directory is shortened to `~`. */
  path: z.string().max(4096),
  /** The folder is gone (deleted, moved, unmounted). Every file operation fails. */
  missing: z.literal(true).optional()
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

// Request payloads (extension → desktop).

export const TreeParams = z.strictObject({});
/** One folder's entries. `dir` is '' for the project root. */
export const ListParams = z.strictObject({
  dir: z.string().max(4 * MAX_PATH_LENGTH)
});
export const ReadParams = z.strictObject({ path: RelPath });
/** Size and hash of any regular file, text or not. For delete cards and stale checks. */
export const StatParams = z.strictObject({ path: RelPath });
export const WriteParams = z.strictObject({
  path: RelPath,
  // Characters, not bytes. The desktop checks the UTF-8 size against MAX_FILE_BYTES.
  content: z.string().max(MAX_FILE_BYTES),
  /** Required to modify an existing file, absent to create one. From `read`. */
  baseHash: Sha256Hex.optional(),
  /** `chat`: applied from a diff card. The desktop's activity list says "via chat". */
  source: z.literal('chat').optional(),
  trigger: Trigger,
  loopId: LoopId.optional()
});
/**
 * Deletes and renames always need a click: the desktop refuses `trigger: 'auto'` in every
 * mode. Both need the hash the card saw, so a file changed since gets `conflict`.
 */
export const DeleteParams = z.strictObject({
  path: RelPath,
  baseHash: Sha256Hex,
  source: z.literal('chat').optional(),
  trigger: Trigger
});
export const RenameParams = z.strictObject({
  from: RelPath,
  to: RelPath,
  baseHash: Sha256Hex,
  source: z.literal('chat').optional(),
  trigger: Trigger
});
export const UndoParams = z.strictObject({ opId: OpId });
/**
 * The files in context, for when the project is too big to watch: the desktop polls these
 * instead. Replaces the previous list.
 */
export const WatchParams = z.strictObject({
  paths: z.array(RelPath).max(MAX_WATCHED_PATHS)
});
/** One command as argv. The desktop re-checks every word and the allowlist. */
export const RunParams = z.strictObject({
  argv: z.array(z.string().max(1_000)).min(1).max(100),
  trigger: Trigger,
  loopId: LoopId.optional()
});
export const RunCancelParams = z.strictObject({ runId: RunId });
export type RunParams = z.infer<typeof RunParams>;
export type ReadParams = z.infer<typeof ReadParams>;
export type WriteParams = z.infer<typeof WriteParams>;
export type UndoParams = z.infer<typeof UndoParams>;
export type ListParams = z.infer<typeof ListParams>;
export type StatParams = z.infer<typeof StatParams>;
export type DeleteParams = z.infer<typeof DeleteParams>;
export type RenameParams = z.infer<typeof RenameParams>;
export type WatchParams = z.infer<typeof WatchParams>;

// Results (desktop → extension).

export const TreeEntry = z.strictObject({
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative(),
  /** Shown but never opened, e.g. `node_modules`. */
  collapsed: z.literal(true).optional()
});
export type TreeEntry = z.infer<typeof TreeEntry>;

export const TreeResult = z.strictObject({
  entries: z.array(TreeEntry).max(TREE_MAX_ENTRIES),
  truncated: z.boolean()
});
export const ListResult = z.strictObject({
  entries: z.array(TreeEntry).max(LIST_MAX_ENTRIES),
  truncated: z.boolean()
});
export const ReadResult = z.strictObject({
  /** Without the UTF-8 byte order mark, if the file has one (`bom`). */
  content: z.string(),
  /** SHA-256 of the raw bytes, BOM included. */
  hash: Sha256Hex,
  eol: z.enum(['lf', 'crlf']),
  /** The file starts with a UTF-8 BOM. Writes over it keep it. */
  bom: z.boolean()
});
export const StatResult = z.strictObject({
  size: z.number().int().nonnegative(),
  hash: Sha256Hex
});
export const WriteResult = z.strictObject({
  opId: OpId,
  kind: z.enum(['create', 'modify']),
  hash: Sha256Hex
});
export const DeleteResult = z.strictObject({ opId: OpId });
export const RenameResult = z.strictObject({ opId: OpId, hash: Sha256Hex });
export const UndoResult = z.strictObject({ opId: OpId, path: z.string() });
/** `watch`: every change is reported. `poll`: too big to watch; only the files in context. */
export const WatchResult = z.strictObject({ mode: z.enum(['watch', 'poll']) });
export const RunStarted = z.strictObject({ runId: RunId });
export const RunCancelResult = z.strictObject({ cancelled: z.boolean() });
export type RunStarted = z.infer<typeof RunStarted>;
export type TreeResult = z.infer<typeof TreeResult>;
export type ReadResult = z.infer<typeof ReadResult>;
export type WriteResult = z.infer<typeof WriteResult>;
export type UndoResult = z.infer<typeof UndoResult>;
export type ListResult = z.infer<typeof ListResult>;
export type StatResult = z.infer<typeof StatResult>;
export type DeleteResult = z.infer<typeof DeleteResult>;
export type RenameResult = z.infer<typeof RenameResult>;
export type WatchResult = z.infer<typeof WatchResult>;

export const FileError = z.strictObject({
  code: FileErrorCode,
  message: z.string().max(500)
});
export type FileError = z.infer<typeof FileError>;

/** Request type → its result schema, for the client to validate replies. */
export const FILE_RESULTS = {
  tree: TreeResult,
  list: ListResult,
  read: ReadResult,
  stat: StatResult,
  write: WriteResult,
  delete: DeleteResult,
  rename: RenameResult,
  undo: UndoResult,
  watch: WatchResult,
  run: RunStarted,
  run_cancel: RunCancelResult
} as const;
export type FileRequestType = keyof typeof FILE_RESULTS;
export type FileResult<T extends FileRequestType> = z.infer<(typeof FILE_RESULTS)[T]>;

export type FileOutcome<T> = { ok: true; result: T } | { ok: false; error: FileError };

/** Short, human-readable text for each code. Never includes a path. */
export const FILE_ERROR_MESSAGES: Record<FileErrorCode, string> = {
  'no-project': 'No project folder is open in Bridge.',
  'project-missing':
    'The project folder is missing. It may have been moved, renamed or unmounted. Open it again in Bridge.',
  'invalid-path': 'That path is not a valid project path.',
  'absolute-path': 'Paths must be relative to the project folder.',
  traversal: 'Paths may not contain "." or ".." segments.',
  denied: 'That file is protected and Bridge will not touch it.',
  'outside-root': 'That path leads outside the project folder.',
  'not-found': 'That file does not exist.',
  'not-a-file': 'That path is not a regular file.',
  binary: 'That file looks binary. Bridge only reads text files.',
  'too-large': 'That file is too large for Bridge (over 1 MB to read or write, 50 MB to delete).',
  encoding: 'That file isn’t UTF-8 text, so Bridge won’t read or overwrite it.',
  conflict: 'The file changed since it was read.',
  exists: 'A file already exists at that path.',
  'unknown-op': 'Bridge has no record of that change. Its backup may have expired.',
  'already-undone': 'That change was already undone.',
  'io-error': 'Bridge couldn’t complete the file operation. Check the disk and try again.',
  mode: 'Bridge doesn’t do that on its own in this mode. Click to do it.',
  gated: 'That file can change what commands do, so it needs a click in every mode.',
  'invalid-command': 'Bridge runs single commands only, with no shell features.',
  'not-allowlisted': 'That command isn’t on the allowlist. Add it in the Bridge app.',
  'command-not-found': 'That program isn’t installed or isn’t on the PATH.',
  'project-binary':
    'Bridge doesn’t run programs from inside the project unless they’re allowlisted.',
  busy: 'Another command is still running.',
  'unknown-run': 'That command isn’t running.'
};

/** A few words for each code, for activity rows and card meta lines. */
export const FILE_ERROR_LABELS: Record<FileErrorCode, string> = {
  'no-project': 'no project open',
  'project-missing': 'project missing',
  'invalid-path': 'invalid path',
  'absolute-path': 'absolute path',
  traversal: '"." or ".." in path',
  denied: 'protected file',
  'outside-root': 'outside the project',
  'not-found': 'not found',
  'not-a-file': 'not a file',
  binary: 'binary file',
  'too-large': 'too large',
  encoding: 'not UTF-8',
  conflict: 'changed on disk',
  exists: 'already exists',
  'unknown-op': 'unknown change',
  'already-undone': 'already undone',
  'io-error': 'disk error',
  mode: 'needs a click',
  gated: 'gated file',
  'invalid-command': 'invalid command',
  'not-allowlisted': 'not allowed',
  'command-not-found': 'not found',
  'project-binary': 'project program',
  busy: 'busy',
  'unknown-run': 'not running'
};
