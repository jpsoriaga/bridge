import { BRIDGE_EXTENSION_ID } from '@bridge/shared';

/**
 * Extension IDs allowed to pair and connect. The only place this list lives.
 * Add the Web Store ID here if the extension is ever published under a different key.
 */
export const ALLOWED_EXTENSION_IDS: readonly string[] = [BRIDGE_EXTENSION_ID];

export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  ALLOWED_EXTENSION_IDS.map((id) => `chrome-extension://${id}`)
);

export const HOST = '127.0.0.1';

/** HTTP bodies are tiny in Phase 2 (`{ code }`). */
export const BODY_LIMIT_BYTES = 1024;
/** Largest WebSocket frame. Raise when file contents start flowing (Phase 4). */
export const MAX_WS_PAYLOAD_BYTES = 16 * 1024;

export const AUTH_TIMEOUT_MS = 5_000;
/** The extension pings every 20s. Three missed pings and the socket is dropped. */
export const IDLE_TIMEOUT_MS = 60_000;

/** Per-connection message budget. */
export const RATE_LIMIT = { messages: 100, windowMs: 10_000 } as const;

export const PAIRING_CODE_TTL_MS = 2 * 60_000;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_LOCKOUT_MS = 60_000;
