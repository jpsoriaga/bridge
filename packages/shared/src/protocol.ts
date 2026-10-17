import { z } from 'zod';
import {
  FileError,
  ProjectInfo,
  ReadParams,
  RunCancelParams,
  RunId,
  RunParams,
  TreeParams,
  UndoParams,
  WriteParams
} from './files';
import { LoopReport, MAX_STEP_LIMIT } from './loop';
import { MODES } from './types';

/** Bumped when a message shape changes incompatibly. Both sides reject other versions. */
export const PROTOCOL_VERSION = 3;

/** The desktop listens on the first free port in `DEFAULT_PORT .. DEFAULT_PORT + PORT_RANGE - 1`. */
export const DEFAULT_PORT = 47821;
export const PORT_RANGE = 10;

export function candidatePorts(): number[] {
  return Array.from({ length: PORT_RANGE }, (_, i) => DEFAULT_PORT + i);
}

/**
 * The extension's ID, fixed by the `key` in apps/extension/manifest.config.ts.
 * The desktop accepts only `chrome-extension://<id>` origins from its allowlist.
 */
export const BRIDGE_EXTENSION_ID = 'golkpkmancgpgkpfjggoimedcogghhip';

export const PAIRING_CODE_LENGTH = 6;
export const PairingCode = z.string().regex(/^\d{6}$/);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
/** 32 random bytes, hex encoded. Only ever sent once, in the `/pair` response. */
export const Token = hex32;
/** SHA-256 of the token, hex. Both sides keep this; it is the HMAC key for every proof. */
export const TokenHash = hex32;
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
  purpose: 'ws' | 'unpair',
  port: number,
  nonce: string
): string {
  return `bridge/v${PROTOCOL_VERSION}/${role}/${purpose}/${port}/${nonce}`;
}

// HTTP

export const HealthResponse = z.strictObject({
  name: z.literal('bridge'),
  version: z.string().max(32)
});
export type HealthResponse = z.infer<typeof HealthResponse>;

export const PairRequest = z.strictObject({ code: PairingCode });
export type PairRequest = z.infer<typeof PairRequest>;

export const PairSuccess = z.strictObject({ token: Token });
export type PairSuccess = z.infer<typeof PairSuccess>;

export const PairFailure = z.strictObject({
  error: z.enum(['invalid_request', 'invalid_code', 'locked']),
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
  /** Full auto: most messages Bridge sends on its own in one run before it pauses. */
  stepLimit: z.number().int().min(1).max(MAX_STEP_LIMIT),
  /** Full auto: pause on a non-zero exit instead of sending the output to the chat. */
  pauseOnFailure: z.boolean(),
  /** The command running now, if any. */
  running: z.strictObject({ runId: RunId, argv: z.array(z.string()) }).nullable()
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
export const ReadRequest = message('read', ReadParams);
export const WriteRequest = message('write', WriteParams);
export const UndoRequest = message('undo', UndoParams);
export const FileRequest = z.discriminatedUnion('type', [
  TreeRequest,
  ReadRequest,
  WriteRequest,
  UndoRequest
]);
export type FileRequest = z.infer<typeof FileRequest>;

// Commands. `run` answers with a `response` holding the run id, then the desktop sends
// `run_output` chunks and one `run_exit`.
export const RunRequest = message('run', RunParams);
export const RunCancelRequest = message('run_cancel', RunCancelParams);
export const CommandRequest = z.discriminatedUnion('type', [RunRequest, RunCancelRequest]);
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

// Full auto. The extension reports the loop; the app can stop it.
export const LoopReportMessage = message('loop_report', LoopReport);
export const LoopStopMessage = message('loop_stop', empty);
/** The extension ended a chat session. The app drops out of Full auto. */
export const SessionEndMessage = message('session_end', empty);

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
  ReadRequest,
  WriteRequest,
  UndoRequest,
  RunRequest,
  RunCancelRequest,
  LoopReportMessage,
  SessionEndMessage
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
  LoopStopMessage
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
  rateLimited: 4008
} as const;
