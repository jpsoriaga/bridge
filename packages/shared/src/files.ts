import { z } from 'zod';

// Project files over the socket: tree, read, write and undo. The desktop's sandbox
// decides what is allowed; these schemas only bound the shapes.

/** Largest file Bridge reads or writes, in bytes (UTF-8). */
export const MAX_FILE_BYTES = 1024 * 1024;
/** Longest relative path the sandbox accepts, in characters after NFC. */
export const MAX_PATH_LENGTH = 1024;
export const TREE_MAX_ENTRIES = 5_000;
export const TREE_MAX_DEPTH = 12;

/**
 * Every reason a request (file operation or command) can fail. Rejections never include
 * an absolute path.
 */
export const FILE_ERROR_CODES = [
  'no-project',
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
  path: z.string().max(4096)
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;

// Request payloads (extension → desktop).

export const TreeParams = z.strictObject({});
export const ReadParams = z.strictObject({ path: RelPath });
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
export const UndoParams = z.strictObject({ opId: OpId });
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
export const ReadResult = z.strictObject({
  content: z.string(),
  hash: Sha256Hex,
  eol: z.enum(['lf', 'crlf'])
});
export const WriteResult = z.strictObject({
  opId: OpId,
  kind: z.enum(['create', 'modify']),
  hash: Sha256Hex
});
export const UndoResult = z.strictObject({ opId: OpId, path: z.string() });
export const RunStarted = z.strictObject({ runId: RunId });
export const RunCancelResult = z.strictObject({ cancelled: z.boolean() });
export type RunStarted = z.infer<typeof RunStarted>;
export type TreeResult = z.infer<typeof TreeResult>;
export type ReadResult = z.infer<typeof ReadResult>;
export type WriteResult = z.infer<typeof WriteResult>;
export type UndoResult = z.infer<typeof UndoResult>;

export const FileError = z.strictObject({
  code: FileErrorCode,
  message: z.string().max(500)
});
export type FileError = z.infer<typeof FileError>;

/** Request type → its result schema, for the client to validate replies. */
export const FILE_RESULTS = {
  tree: TreeResult,
  read: ReadResult,
  write: WriteResult,
  undo: UndoResult,
  run: RunStarted,
  run_cancel: RunCancelResult
} as const;
export type FileRequestType = keyof typeof FILE_RESULTS;
export type FileResult<T extends FileRequestType> = z.infer<(typeof FILE_RESULTS)[T]>;

export type FileOutcome<T> = { ok: true; result: T } | { ok: false; error: FileError };

/** Short, human-readable text for each code. Never includes a path. */
export const FILE_ERROR_MESSAGES: Record<FileErrorCode, string> = {
  'no-project': 'No project folder is open in Bridge.',
  'invalid-path': 'That path is not a valid project path.',
  'absolute-path': 'Paths must be relative to the project folder.',
  traversal: 'Paths may not contain "." or ".." segments.',
  denied: 'That file is protected and Bridge will not touch it.',
  'outside-root': 'That path leads outside the project folder.',
  'not-found': 'That file does not exist.',
  'not-a-file': 'That path is not a regular file.',
  binary: 'That file looks binary. Bridge only reads text files.',
  'too-large': 'That file is larger than 1 MB.',
  conflict: 'The file changed since it was read.',
  exists: 'A file already exists at that path.',
  'unknown-op': 'Bridge has no record of that change.',
  'already-undone': 'That change was already undone.',
  'io-error': 'Bridge could not complete the file operation.',
  mode: 'Bridge’s current mode doesn’t do that on its own. Click to do it.',
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
  'invalid-path': 'invalid path',
  'absolute-path': 'absolute path',
  traversal: '"." or ".." in path',
  denied: 'protected file',
  'outside-root': 'outside the project',
  'not-found': 'not found',
  'not-a-file': 'not a file',
  binary: 'binary file',
  'too-large': 'over 1 MB',
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
