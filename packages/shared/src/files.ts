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
/** Largest binary file (an image, a font, a download) Bridge writes, reads or attaches. */
export const MAX_BINARY_BYTES = 20 * 1024 * 1024;
/**
 * Raw bytes in one `upload` chunk. A binary write travels in chunks of this size, base64,
 * so no frame comes near the socket's size limit.
 */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
/**
 * Longest command a background process reports (`formatArgv`): a 1,000-character argv of
 * 100 words, each quoted and escaped, can't pass this.
 */
export const MAX_PROCESS_COMMAND_CHARS = 4_000;
/** Background processes (dev servers) running at once. */
export const MAX_BACKGROUND_PROCESSES = 3;
/** Lines a background process keeps in its log. */
export const BACKGROUND_LOG_LINES = 2_000;

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
  /** A file with more than one hard link: it may be a file outside the project. */
  'hardlink',
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
  /** Too many requests of this kind in the last second (`OP_RATE_LIMITS` in the desktop). */
  'rate-limited',
  // Modes: an automatic write or run the current mode doesn't allow, or a gated file.
  'mode',
  'gated',
  // Commands.
  'invalid-command',
  'not-allowlisted',
  /** An allowlisted program with an option Bridge never allows (`DENIED_FLAGS`). */
  'denied-flag',
  'command-not-found',
  'project-binary',
  'busy',
  'unknown-run',
  /** A background command (`@@START`) asked for with `@@RUN`, which would never finish. */
  'background-only',
  /** A one-off command asked for with `@@START`: it isn't marked as a background process. */
  'not-background',
  /** `MAX_BACKGROUND_PROCESSES` are running already. */
  'too-many',
  'unknown-process',
  // Binary files and downloads.
  /** A binary write whose chunks didn't add up (missing, out of order, wrong size or hash). */
  'upload',
  'not-https',
  /** The download's host is this computer or the local network. */
  'private-address',
  'download-failed',
  /** The file's bytes aren't one of the types Bridge downloads, or not the type its name says. */
  'unsupported-type',
  /** An SVG with scripts or event handlers. */
  'unsafe-svg'
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
export const UploadId = z.string().regex(/^[0-9a-z-]{1,64}$/);
export const ProcessId = z.string().regex(/^[0-9a-z-]{1,64}$/);
/** Standard base64 with padding, at most `bytes` decoded bytes. */
const base64 = (bytes: number) =>
  z
    .string()
    .max(Math.ceil(bytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);

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
  loopId: LoopId.optional(),
  /**
   * Full auto wrote a file that looks partial because "Also approve automatically" allows
   * it. Only a label for Activity; the app keeps it only while that setting is on.
   */
  autoApproved: z.literal(true).optional()
});
/**
 * Deletes and renames need a click: the desktop refuses `trigger: 'auto'` unless Full
 * auto's "Also approve automatically" allows them. Both need the hash the card saw, so a
 * file changed since gets `conflict`.
 */
export const DeleteParams = z.strictObject({
  path: RelPath,
  baseHash: Sha256Hex,
  source: z.literal('chat').optional(),
  trigger: Trigger,
  loopId: LoopId.optional()
});
export const RenameParams = z.strictObject({
  from: RelPath,
  to: RelPath,
  baseHash: Sha256Hex,
  source: z.literal('chat').optional(),
  trigger: Trigger,
  loopId: LoopId.optional()
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

/**
 * One chunk of a binary write, base64. Chunks of one `uploadId` arrive in order (`offset`
 * is where this one starts); `write_binary` then commits them. The desktop keeps them in
 * memory only, briefly.
 */
export const UploadParams = z.strictObject({
  uploadId: UploadId,
  offset: z.number().int().nonnegative().max(MAX_BINARY_BYTES),
  data: base64(UPLOAD_CHUNK_BYTES)
});
/**
 * Writes the uploaded bytes to `path`: the same sandbox, denylist, gated files, backup and
 * undo as a text write. `size` and `sha256` must match what arrived.
 */
export const WriteBinaryParams = z.strictObject({
  path: RelPath,
  uploadId: UploadId,
  size: z.number().int().nonnegative().max(MAX_BINARY_BYTES),
  sha256: Sha256Hex,
  /** Required to replace an existing file, absent to create one. From `stat`. */
  baseHash: Sha256Hex.optional(),
  source: z.literal('chat').optional(),
  trigger: Trigger,
  loopId: LoopId.optional(),
  autoApproved: z.literal(true).optional()
});
/** Any regular file up to MAX_BINARY_BYTES, as bytes: an image to attach to the chat. */
export const ReadBinaryParams = z.strictObject({ path: RelPath });
/**
 * Fetches an https URL in the desktop and writes it to `path` as a binary write. Always a
 * click, in every mode. HTTPS only, no local addresses, MAX_BINARY_BYTES, and the bytes
 * must be one of `DOWNLOAD_TYPES` (sniffed, not just the name).
 */
export const DownloadParams = z.strictObject({
  url: z.string().min(1).max(2048),
  path: RelPath,
  baseHash: Sha256Hex.optional(),
  trigger: Trigger
});
/** A command that keeps running (a dev server): an allowlisted background entry. */
export const BackgroundStartParams = z.strictObject({
  argv: RunParams.shape.argv,
  trigger: Trigger,
  loopId: LoopId.optional()
});
/** A background process, by the command that started it (`@@STOP cmd@@`) or its id. */
const ProcessRef = {
  procId: ProcessId.optional(),
  argv: RunParams.shape.argv.optional()
};
export const BackgroundStopParams = z.strictObject({
  ...ProcessRef,
  trigger: Trigger
});
/**
 * A background process's log: lines numbered from 0 since it started, `since` onwards, or
 * the last `tail` lines.
 */
export const BackgroundLogsParams = z.strictObject({
  ...ProcessRef,
  since: z.number().int().nonnegative().optional(),
  tail: z.number().int().nonnegative().max(BACKGROUND_LOG_LINES).optional()
});
export type UploadParams = z.infer<typeof UploadParams>;
export type WriteBinaryParams = z.infer<typeof WriteBinaryParams>;
export type ReadBinaryParams = z.infer<typeof ReadBinaryParams>;
export type DownloadParams = z.infer<typeof DownloadParams>;
export type BackgroundStartParams = z.infer<typeof BackgroundStartParams>;
export type BackgroundStopParams = z.infer<typeof BackgroundStopParams>;
export type BackgroundLogsParams = z.infer<typeof BackgroundLogsParams>;
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
export const UploadResult = z.strictObject({ received: z.number().int().nonnegative() });
export const WriteBinaryResult = WriteResult;
export const ReadBinaryResult = z.strictObject({
  data: base64(MAX_BINARY_BYTES),
  size: z.number().int().nonnegative(),
  hash: Sha256Hex,
  /** Sniffed from the bytes, e.g. `image/png`; `application/octet-stream` if unknown. */
  mime: z.string().max(100)
});
export const DownloadResult = z.strictObject({
  opId: OpId,
  kind: z.enum(['create', 'modify']),
  hash: Sha256Hex,
  size: z.number().int().nonnegative(),
  mime: z.string().max(100)
});
export const BackgroundStarted = z.strictObject({
  procId: ProcessId,
  /** It was running already, so it was stopped and started again. */
  restarted: z.boolean()
});
export const BackgroundStopped = z.strictObject({ stopped: z.boolean() });
/** Most characters kept per log line. */
export const BACKGROUND_LINE_CHARS = 4_000;
export const BackgroundLogs = z.strictObject({
  procId: ProcessId,
  command: z.string().max(MAX_PROCESS_COMMAND_CHARS),
  lines: z.array(z.string().max(BACKGROUND_LINE_CHARS)).max(BACKGROUND_LOG_LINES),
  /** The number of `lines[0]`: lines before it scrolled out of the log. */
  first: z.number().int().nonnegative(),
  /** The number the next line will get. Pass it as `since` to get only newer lines. */
  next: z.number().int().nonnegative()
});
/**
 * A background process as the app reports it in `status`, on every change of state (not on
 * every line). `running` until it exits or is stopped; `url` once it printed a local one.
 */
export const BackgroundProcess = z.strictObject({
  procId: ProcessId,
  /** As the allowlist writes it (`formatArgv`). */
  command: z.string().max(MAX_PROCESS_COMMAND_CHARS),
  state: z.enum(['running', 'exited', 'stopped']),
  /** The first local URL it printed (`http://localhost:5173/`), once it has. */
  url: z.string().max(200).nullable(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable()
});
export type BackgroundProcess = z.infer<typeof BackgroundProcess>;
export type UploadResult = z.infer<typeof UploadResult>;
export type ReadBinaryResult = z.infer<typeof ReadBinaryResult>;
export type DownloadResult = z.infer<typeof DownloadResult>;
export type BackgroundStarted = z.infer<typeof BackgroundStarted>;
export type BackgroundStopped = z.infer<typeof BackgroundStopped>;
export type BackgroundLogs = z.infer<typeof BackgroundLogs>;
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
  run_cancel: RunCancelResult,
  upload: UploadResult,
  write_binary: WriteBinaryResult,
  read_binary: ReadBinaryResult,
  download: DownloadResult,
  bg_start: BackgroundStarted,
  bg_stop: BackgroundStopped,
  bg_logs: BackgroundLogs
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
  hardlink:
    'That file has more than one hard link, so it may be a file outside the project. Bridge won’t touch it.',
  'not-found': 'That file does not exist.',
  'not-a-file': 'That path is not a regular file.',
  binary:
    'That file looks binary. Bridge saves binary files only through @@ASSET or @@DOWNLOAD, and sends images as attachments.',
  'too-large':
    'That file is too large for Bridge (over 1 MB for text, 20 MB for an image or download, 50 MB to delete).',
  encoding: 'That file isn’t UTF-8 text, so Bridge won’t read or overwrite it.',
  conflict: 'The file changed since it was read.',
  exists: 'A file already exists at that path.',
  'unknown-op': 'Bridge has no record of that change. Its backup may have expired.',
  'already-undone': 'That change was already undone.',
  'io-error': 'Bridge couldn’t complete the file operation. Check the disk and try again.',
  'rate-limited': 'Too many requests of this kind at once. Wait a moment and try again.',
  mode: 'Bridge doesn’t do that on its own in this mode. Click to do it.',
  gated: 'That file can change what commands do, so it needs a click in every mode.',
  'invalid-command': 'Bridge runs single commands only, with no shell features.',
  'not-allowlisted': 'That command isn’t on the allowlist. Add it in the Bridge app.',
  'denied-flag':
    'That command uses an option Bridge never allows, because it could run other code, write files or change folders.',
  'command-not-found': 'That program isn’t installed or isn’t on the PATH.',
  'project-binary':
    'Bridge doesn’t run programs from inside the project unless they’re allowlisted.',
  busy: 'Another command is still running.',
  'unknown-run': 'That command isn’t running.',
  'background-only':
    'That command keeps running (a dev server, a watcher), so Bridge starts it with @@START, not @@RUN.',
  'not-background':
    'That command isn’t marked as a background process in the Bridge app. Run it with @@RUN.',
  'too-many': 'Three background processes are running already. Stop one first.',
  'unknown-process': 'That background process isn’t running.',
  upload: 'The file didn’t arrive whole. Try again.',
  'not-https': 'Bridge downloads only https:// links.',
  'private-address': 'Bridge doesn’t download from this computer or the local network.',
  'download-failed': 'The download didn’t finish. Check the link and try again.',
  'unsupported-type':
    'That file isn’t a type Bridge downloads, or isn’t the type its name says (images, fonts, audio, video, JSON and text only).',
  'unsafe-svg': 'That SVG has scripts or event handlers in it, so Bridge won’t save it.'
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
  hardlink: 'hard-linked file',
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
  'rate-limited': 'too many requests',
  mode: 'needs a click',
  gated: 'gated file',
  'invalid-command': 'invalid command',
  'not-allowlisted': 'not allowed',
  'denied-flag': 'option not allowed',
  'command-not-found': 'not found',
  'project-binary': 'project program',
  busy: 'busy',
  'unknown-run': 'not running',
  'background-only': 'use @@START',
  'not-background': 'not a background command',
  'too-many': 'three already running',
  'unknown-process': 'not running',
  upload: 'incomplete upload',
  'not-https': 'not https',
  'private-address': 'local address',
  'download-failed': 'download failed',
  'unsupported-type': 'file type not allowed',
  'unsafe-svg': 'SVG with scripts'
};
