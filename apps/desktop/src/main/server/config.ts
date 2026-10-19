import { BRIDGE_EXTENSION_ID, MAX_FILE_BYTES, type ClientMessage } from '@bridge/shared';

/**
 * Extension IDs allowed to pair and connect. The only place this list lives.
 * Add the Web Store ID here if the extension is ever published under a different key.
 */
export const ALLOWED_EXTENSION_IDS: readonly string[] = [BRIDGE_EXTENSION_ID];

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  ALLOWED_EXTENSION_IDS.map((id) => `chrome-extension://${id}`)
);

export const HOST = '127.0.0.1';

/** HTTP bodies are tiny: `{ code, publicKey }` at most. */
export const BODY_LIMIT_BYTES = 1024;
/**
 * JSON can grow text at most this many times: a one-byte control character becomes
 * `\u00XX`. Multi-byte characters are never escaped, and a lone surrogate (3 bytes) becomes
 * 6 characters.
 */
export const JSON_ESCAPE_GROWTH = 6;
/** Room for the envelope and the other fields of the largest message. */
export const ENVELOPE_ALLOWANCE_BYTES = 64 * 1024;
/**
 * Largest WebSocket frame: the largest message the protocol allows, a `write` of
 * MAX_FILE_BYTES of content, escaped as badly as JSON can, plus its envelope. Anything
 * bigger is closed with 1009 before it's parsed. The content's real size is checked after.
 */
export const MAX_WS_PAYLOAD_BYTES = MAX_FILE_BYTES * JSON_ESCAPE_GROWTH + ENVELOPE_ALLOWANCE_BYTES;
/** Open sockets at once, authenticated or not: the extension, plus one reconnecting. */
export const MAX_CONNECTIONS = 2;
/** An HTTP request (headers and body) must arrive within this, or the socket is closed. */
export const HTTP_REQUEST_TIMEOUT_MS = 10_000;

/** The whole handshake (hello → challenge → auth) must finish within this. */
export const AUTH_TIMEOUT_MS = 5_000;
/** Client nonces are remembered this long, so a replayed hello is refused. */
export const NONCE_TTL_MS = 10 * 60_000;
export const NONCE_LEDGER_MAX = 1024;
/** A server nonce from `/unpair/challenge` must be redeemed within this. */
export const UNPAIR_CHALLENGE_TTL_MS = 30_000;
/** The extension pings every 20s. Three missed pings and the socket is dropped. */
export const IDLE_TIMEOUT_MS = 60_000;

/**
 * Per-connection flood guard: past this the socket is closed (4008). Well above what the
 * per-operation limits allow, so it only ever catches a misbehaving client.
 */
export const RATE_LIMIT = { messages: 1_000, windowMs: 10_000 } as const;

/**
 * Requests of each kind one socket may make per second. Over it, the request is answered
 * `rate-limited` and not run; the extension waits a second and retries, so a legitimate
 * burst only slows down. Commands also run one at a time (`busy`).
 */
export const OP_RATE_LIMITS: Readonly<
  Record<
    Extract<
      ClientMessage['type'],
      | 'tree'
      | 'list'
      | 'read'
      | 'stat'
      | 'write'
      | 'delete'
      | 'rename'
      | 'undo'
      | 'watch'
      | 'run'
      | 'run_cancel'
    >,
    number
  >
> = {
  read: 50,
  stat: 100,
  list: 20,
  tree: 5,
  write: 10,
  delete: 10,
  rename: 10,
  undo: 10,
  watch: 5,
  run: 5,
  run_cancel: 10
};

export const PAIRING_CODE_TTL_MS = 2 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_LOCKOUT_MS = 60_000;
