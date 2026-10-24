import { z } from 'zod';
import { UI_GUIDANCE } from './project';
import {
  BackgroundLogsParams,
  BackgroundProcess,
  BackgroundStartParams,
  BackgroundStopParams,
  DeleteParams,
  DownloadParams,
  FileError,
  ListParams,
  ProjectInfo,
  ReadBinaryParams,
  ReadParams,
  RenameParams,
  RunCancelParams,
  RunId,
  RunParams,
  StatParams,
  TreeParams,
  UndoParams,
  UploadParams,
  WatchParams,
  WriteBinaryParams,
  WriteParams
} from './files';
import { LoopReport, MAX_STEP_LIMIT } from './loop';
import { MODES } from './types';

/** Bumped when a message shape changes incompatibly. Both sides reject other versions. */
export const PROTOCOL_VERSION = 8;

export { candidatePorts, DEFAULT_PORT, E2E_PORT, PORT_RANGE } from './ports';

/**
 * The extension's ID, fixed by the `key` in apps/extension/manifest.config.ts.
 * The desktop accepts only `chrome-extension://<id>` origins from its allowlist.
 */
export const BRIDGE_EXTENSION_ID = 'golkpkmancgpgkpfjggoimedcogghhip';

/**
 * The Chrome Web Store's ID for Bridge, once it has one: empty until the first upload.
 * The store build has no `key`, so the store assigns this. After the first draft upload,
 * set it here (RELEASE.md, "First store upload"); the desktop then accepts it too.
 */
export const STORE_EXTENSION_ID = '';

export const PAIRING_CODE_LENGTH = 6;
export const PairingCode = z.string().regex(/^\d{6}$/);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * The pairing key, hex: 32 bytes both sides derive from an ECDH exchange while pairing
 * (`pairKeyInput`). It never crosses the wire; it is the HMAC key for every proof.
 */
export const TokenHash = hex32;
/** An uncompressed P-256 public key (65 bytes, 0x04‖x‖y), base64url without padding. */
export const PublicKey = z.string().regex(/^B[A-P][A-Za-z0-9_-]{85}$/);
/** 32 random bytes, hex. Single use. */
export const Nonce = hex32;
/** HMAC-SHA256, hex. See `proofInput`. */
export const Proof = hex32;

/**
 * The bytes each side signs with HMAC-SHA256(tokenHash, ·). The role and purpose keep a
 * proof from one step being reflected into another, and the port binds it to the socket
 * the client actually dialled, so a process on another port can't relay a real server's
 * proofs. The token itself never crosses the wire after pairing.
 */
export function proofInput(
  role: 'server' | 'client',
  purpose: 'ws' | 'unpair' | 'pair',
  port: number,
  nonce: string
): string {
  return `bridge/v${PROTOCOL_VERSION}/${role}/${purpose}/${port}/${nonce}`;
}

/**
 * What a pairing binds together: the port the extension dialled, the code, and both
 * public keys. A process relaying or squatting a port changes at least one of them, so
 * its fingerprint can't match the app's.
 */
export function pairTranscript(
  port: number,
  code: string,
  serverKey: string,
  clientKey: string
): string {
  return `bridge/v${PROTOCOL_VERSION}/pair/${port}/${code}/${serverKey}/${clientKey}`;
}

/** Label hashed in front of the ECDH secret and the transcript to make the pairing key. */
export const PAIR_KEY_LABEL = `bridge/v${PROTOCOL_VERSION}/key/`;
/** Label hashed in front of the transcript for the fingerprint. */
export const FINGERPRINT_LABEL = `bridge/v${PROTOCOL_VERSION}/fingerprint/`;

/** The first 4 bytes of the fingerprint hash, as the two sides show it: `a1b2 c3d4`. */
export function formatFingerprint(hashHex: string): string {
  return `${hashHex.slice(0, 4)} ${hashHex.slice(4, 8)}`;
}

// HTTP

/**
 * `GET /health`. The one message meant to outlive protocol changes: any build of either side
 * must be able to read any other's, so it's a loose object (newer fields are ignored) and
 * `protocol` is optional (apps from before 1.0 don't send it). See `protocolAdvice`.
 */
export const HealthResponse = z.looseObject({
  name: z.literal('bridge'),
  version: z.string().max(32),
  protocol: z.number().int().positive().max(10_000).optional()
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** What a protocol mismatch asks the user to do, or null when both sides speak the same one. */
export type ProtocolAdvice = 'update-app' | 'update-extension';

/** Whichever side speaks the older protocol is the one to update. */
export function protocolAdvice(app: number, extension: number): ProtocolAdvice | null {
  if (app === extension) return null;
  return app < extension ? 'update-app' : 'update-extension';
}

/**
 * The protocol version of a raw `hello`, whatever version it is, or null if `raw` isn't one.
 * The app reads it before the strict schema (which accepts only its own version), so it can
 * tell an extension that speaks another protocol from a broken one.
 */
export function helloProtocol(raw: string): number | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const hello = z
    .looseObject({ v: z.number().int().positive().max(10_000), type: z.literal('hello') })
    .safeParse(data);
  return hello.success ? hello.data.v : null;
}

/** Close reason sent with `CloseCode.protocolMismatch`: the app's protocol, e.g. `protocol 5`. */
export function mismatchReason(protocol: number): string {
  return `protocol ${protocol}`;
}

/** The app's protocol from a `protocolMismatch` close reason, or null. */
export function parseMismatchReason(reason: string): number | null {
  const match = /^protocol (\d{1,5})$/.exec(reason);
  return match ? Number(match[1]) : null;
}

/** Step 1 of pairing: the code, and the extension's one-time ECDH public key. */
export const PairRequest = z.strictObject({ code: PairingCode, publicKey: PublicKey });
export type PairRequest = z.infer<typeof PairRequest>;

/**
 * The app's public key, and its proof over the transcript (`proofInput('server', 'pair',
 * port, sha256(transcript))`) that it derived the same key. Nothing is stored yet: both
 * sides show the fingerprint, and the user confirms it in the app, then in the extension.
 */
export const PairSuccess = z.strictObject({ publicKey: PublicKey, proof: Proof });
export type PairSuccess = z.infer<typeof PairSuccess>;

/** Step 2: the extension's proof over the same transcript hash, after the user confirmed. */
export const PairConfirmRequest = z.strictObject({ proof: Proof });
export type PairConfirmRequest = z.infer<typeof PairConfirmRequest>;

export const PairFailure = z.strictObject({
  error: z.enum([
    'invalid_request',
    'invalid_code',
    'locked',
    /** `/pair/confirm` before the user confirmed the fingerprint in the app. */
    'not_confirmed',
    /** No pairing waiting: it expired, was cancelled, or the proof was wrong. */
    'no_pairing'
  ]),
  retryAfterMs: z.number().int().nonnegative().optional()
});
export type PairFailure = z.infer<typeof PairFailure>;

/** Step 1 of `/unpair`: the client's nonce. The server answers with its proof and a nonce. */
export const UnpairChallengeRequest = z.strictObject({ nonce: Nonce });
export const UnpairChallengeResponse = z.strictObject({ proof: Proof, serverNonce: Nonce });
/** Step 2 of `/unpair`: the client's proof over the server's nonce. */
export const UnpairRequest = z.strictObject({ serverNonce: Nonce, proof: Proof });

// WebSocket. Every message is an envelope `{ v, id, type, payload }`.

const messageId = z.string().min(1).max(64);
const empty = z.strictObject({});

function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    id: messageId,
    type: z.literal(type),
    payload
  });
}

// Handshake: hello → challenge → auth → auth_ok. See PLAN.md, "Socket auth".
export const HelloMessage = message('hello', z.strictObject({ nonce: Nonce }));
export const ChallengeMessage = message(
  'challenge',
  z.strictObject({ proof: Proof, serverNonce: Nonce })
);
export const AuthMessage = message('auth', z.strictObject({ proof: Proof }));
export const AuthOkMessage = message('auth_ok', empty);
export const AuthErrorMessage = message(
  'auth_error',
  z.strictObject({
    reason: z.enum([
      'invalid_proof',
      'not_paired',
      'replayed_nonce',
      'timeout',
      'expected_hello',
      'expected_auth'
    ])
  })
);
export const PingMessage = message('ping', empty);
export const PongMessage = message('pong', empty);
export const ModeSchema = z.enum(MODES);
export const MAX_ALLOWLIST_ENTRIES = 100;
export const MAX_ALLOWLIST_ENTRY_CHARS = 200;

/** What the app decides and the extension mirrors. Only the app can change any of it. */
export const BridgeConfig = z.strictObject({
  mode: ModeSchema,
  /** Commands as written in the app, e.g. `pnpm test`. Each is an argv prefix. */
  allowlist: z.array(z.string().max(MAX_ALLOWLIST_ENTRY_CHARS)).max(MAX_ALLOWLIST_ENTRIES),
  /**
   * Full auto: most messages Bridge sends on its own in one run before it pauses. Null:
   * Unlimited (the loop guard still pauses a run that repeats the same failure).
   */
  stepLimit: z.number().int().min(1).max(MAX_STEP_LIMIT).nullable(),
  /** Full auto: pause on a non-zero exit instead of sending the output to the chat. */
  pauseOnFailure: z.boolean(),
  /** Full auto: after the computer sleeps, wait for the chat and carry on instead of pausing. */
  catchUpAfterSleep: z.boolean(),
  /** The command running now, if any. */
  running: z.strictObject({ runId: RunId, argv: z.array(z.string()) }).nullable(),
  /**
   * Allowlist entries that are background processes (dev servers): `@@START` only. The rest
   * of the allowlist runs to completion with `@@RUN`.
   */
  background: z.array(z.string().max(MAX_ALLOWLIST_ENTRY_CHARS)).max(MAX_ALLOWLIST_ENTRIES),
  /** Background processes started this session, running or recently ended. */
  processes: z.array(BackgroundProcess).max(10),
  /**
   * Full auto → "Also approve automatically": what Full auto may do without a click that
   * otherwise waits for one. Commands off the allowlist, downloads, protected files and
   * conflicts always wait, whatever this says.
   */
  autoApprove: z.strictObject({
    /** Deletes and renames. */
    changes: z.boolean(),
    /** Gated files: package.json, lockfiles, CI, hooks. */
    gated: z.boolean(),
    /** Files that look partial ("…rest unchanged"). */
    partial: z.boolean()
  }),
  /**
   * Settings → Project → UI guidance: whether the session prompt has the UI quality block
   * (Auto: frontend projects, their own design rules first).
   */
  uiGuidance: z.enum(UI_GUIDANCE),
  /**
   * Random per app launch. A new one after a reconnect means the app restarted: Full auto
   * was reset, so a loop that was running pauses.
   */
  instance: z.string().regex(/^[\w-]{1,64}$/)
});
export type BridgeConfig = z.infer<typeof BridgeConfig>;

/** Sent after auth_ok and whenever the project or the config changes. */
export const StatusMessage = message(
  'status',
  z.strictObject({
    version: z.string().max(32),
    project: ProjectInfo.nullable(),
    config: BridgeConfig
  })
);

// File requests. The reply is a `response` whose `id` is the request's `id`.
export const TreeRequest = message('tree', TreeParams);
export const ListRequest = message('list', ListParams);
export const ReadRequest = message('read', ReadParams);
export const StatRequest = message('stat', StatParams);
export const WriteRequest = message('write', WriteParams);
export const DeleteRequest = message('delete', DeleteParams);
export const RenameRequest = message('rename', RenameParams);
export const UndoRequest = message('undo', UndoParams);
export const WatchRequest = message('watch', WatchParams);
export const UploadRequest = message('upload', UploadParams);
export const WriteBinaryRequest = message('write_binary', WriteBinaryParams);
export const ReadBinaryRequest = message('read_binary', ReadBinaryParams);
export const DownloadRequest = message('download', DownloadParams);
export const FileRequest = z.discriminatedUnion('type', [
  TreeRequest,
  ListRequest,
  ReadRequest,
  StatRequest,
  WriteRequest,
  DeleteRequest,
  RenameRequest,
  UndoRequest,
  WatchRequest,
  UploadRequest,
  WriteBinaryRequest,
  ReadBinaryRequest,
  DownloadRequest
]);
export type FileRequest = z.infer<typeof FileRequest>;

// Commands. `run` answers with a `response` holding the run id, then the desktop sends
// `run_output` chunks and one `run_exit`.
export const RunRequest = message('run', RunParams);
export const RunCancelRequest = message('run_cancel', RunCancelParams);
export const BackgroundStartRequest = message('bg_start', BackgroundStartParams);
export const BackgroundStopRequest = message('bg_stop', BackgroundStopParams);
export const BackgroundLogsRequest = message('bg_logs', BackgroundLogsParams);
export const CommandRequest = z.discriminatedUnion('type', [
  RunRequest,
  RunCancelRequest,
  BackgroundStartRequest,
  BackgroundStopRequest,
  BackgroundLogsRequest
]);
export type CommandRequest = z.infer<typeof CommandRequest>;

export const RUN_OUTPUT_CHUNK_CHARS = 16 * 1024;
export const RunOutputMessage = message(
  'run_output',
  z.strictObject({ runId: RunId, chunk: z.string().max(RUN_OUTPUT_CHUNK_CHARS) })
);

export const RunResult = z.strictObject({
  runId: RunId,
  argv: z.array(z.string()),
  /** `failed`: it never started (e.g. the program vanished from the PATH). */
  status: z.enum(['exited', 'timed-out', 'cancelled', 'failed']),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  durationMs: z.number().int().nonnegative(),
  /** ANSI codes stripped. The first and last 100 KB if there was more. */
  output: z.string().max(512 * 1024),
  truncated: z.boolean()
});
export type RunResult = z.infer<typeof RunResult>;
export const RunExitMessage = message('run_exit', RunResult);

/** Most paths in one `file_changed`. Past that, `overflow` says "re-check everything". */
export const FILE_CHANGED_MAX_PATHS = 500;
/**
 * Files in the project changed on disk (added, changed or removed), batched. From the
 * watcher, or from polling the files in context when the project is too big to watch.
 */
export const FileChangedMessage = message(
  'file_changed',
  z.strictObject({
    paths: z.array(z.string().max(4096)).max(FILE_CHANGED_MAX_PATHS),
    overflow: z.boolean()
  })
);

// Full auto. The extension reports the loop; the app can stop it.
export const LoopReportMessage = message('loop_report', LoopReport);
export const LoopStopMessage = message('loop_stop', empty);
/** The extension ended a chat session. The app drops out of Full auto. */
export const SessionEndMessage = message('session_end', empty);
/** The extension started a chat session. The app's first-run checklist ticks it off. */
export const SessionStartMessage = message('session_start', empty);

/** `result` is checked against `FILE_RESULTS[request type]` by the side that asked. */
export const ResponseMessage = message(
  'response',
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), result: z.unknown() }),
    z.strictObject({ ok: z.literal(false), error: FileError })
  ])
);
export const ErrorMessage = message(
  'error',
  z.strictObject({
    code: z.enum(['invalid_message', 'rate_limited']),
    message: z.string().max(500)
  })
);

/** Extension → desktop. */
export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  AuthMessage,
  PingMessage,
  PongMessage,
  TreeRequest,
  ListRequest,
  ReadRequest,
  StatRequest,
  WriteRequest,
  DeleteRequest,
  RenameRequest,
  UndoRequest,
  WatchRequest,
  UploadRequest,
  WriteBinaryRequest,
  ReadBinaryRequest,
  DownloadRequest,
  RunRequest,
  RunCancelRequest,
  BackgroundStartRequest,
  BackgroundStopRequest,
  BackgroundLogsRequest,
  LoopReportMessage,
  SessionEndMessage,
  SessionStartMessage
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Desktop → extension. */
export const ServerMessage = z.discriminatedUnion('type', [
  ChallengeMessage,
  AuthOkMessage,
  AuthErrorMessage,
  PingMessage,
  PongMessage,
  StatusMessage,
  ResponseMessage,
  ErrorMessage,
  RunOutputMessage,
  RunExitMessage,
  LoopStopMessage,
  FileChangedMessage
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

type Of<M, T> = Extract<M, { type: T }>;

// Callers pass the id so this module stays free of platform crypto.

export function clientMessage<T extends ClientMessage['type']>(
  id: string,
  type: T,
  payload: Of<ClientMessage, T>['payload']
) {
  return { v: PROTOCOL_VERSION, id, type, payload } as Of<ClientMessage, T>;
}

export function serverMessage<T extends ServerMessage['type']>(
  id: string,
  type: T,
  payload: Of<ServerMessage, T>['payload']
) {
  return { v: PROTOCOL_VERSION, id, type, payload } as Of<ServerMessage, T>;
}

/** Parses raw JSON against a schema. Returns null for anything malformed. */
export function parseMessage<S extends z.ZodType>(schema: S, raw: string): z.infer<S> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

/** WebSocket close codes the desktop uses. 4xxx are application-defined. */
export const CloseCode = {
  authTimeout: 4000,
  /**
   * Bad proof, not paired, or the pairing was revoked. The extension forgets its key only
   * if the server had already proved itself on this socket.
   */
  unauthorized: 4001,
  protocolError: 4002,
  idle: 4003,
  rateLimited: 4008,
  /**
   * The extension's `hello` spoke another protocol version. The reason carries the app's
   * (`mismatchReason`), so either side can say which one to update. Never changes: builds
   * of any version must understand it.
   */
  protocolMismatch: 4009
} as const;
