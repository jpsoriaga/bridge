import { z } from 'zod';

/** Bumped when a message shape changes incompatibly. Both sides reject other versions. */
export const PROTOCOL_VERSION = 1;

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
/** 32 random bytes, hex encoded. */
export const Token = z.string().regex(/^[0-9a-f]{64}$/);

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

export const AuthMessage = message('auth', z.strictObject({ token: Token }));
export const AuthOkMessage = message('auth_ok', empty);
export const AuthErrorMessage = message(
  'auth_error',
  z.strictObject({ reason: z.enum(['invalid_token', 'timeout', 'expected_auth']) })
);
export const PingMessage = message('ping', empty);
export const PongMessage = message('pong', empty);
export const StatusMessage = message('status', z.strictObject({ version: z.string().max(32) }));
export const ErrorMessage = message(
  'error',
  z.strictObject({
    code: z.enum(['invalid_message', 'rate_limited']),
    message: z.string().max(500)
  })
);

/** Extension → desktop. */
export const ClientMessage = z.discriminatedUnion('type', [AuthMessage, PingMessage, PongMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Desktop → extension. */
export const ServerMessage = z.discriminatedUnion('type', [
  AuthOkMessage,
  AuthErrorMessage,
  PingMessage,
  PongMessage,
  StatusMessage,
  ErrorMessage
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
  /** Bad token, or the pairing was revoked. The extension forgets its token. */
  unauthorized: 4001,
  protocolError: 4002,
  idle: 4003,
  rateLimited: 4008
} as const;
