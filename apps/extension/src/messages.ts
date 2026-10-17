import { z } from 'zod';
import { PairingCode, type ConnectionStatus } from '@bridge/shared';

/** chrome.runtime messages to the service worker, from the side panel or content script. */
export const WorkerRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-status') }),
  z.strictObject({ type: z.literal('pair'), code: PairingCode }),
  z.strictObject({ type: z.literal('unpair') }),
  z.strictObject({ type: z.literal('retry') })
]);
export type WorkerRequest = z.infer<typeof WorkerRequest>;

/** The only request a content script on chatgpt.com may make. */
export const CONTENT_SCRIPT_REQUESTS: ReadonlySet<WorkerRequest['type']> = new Set(['get-status']);

export type PairResult =
  | { ok: true }
  | { ok: false; error: 'app-not-running' | 'invalid_code' | 'failed' }
  | { ok: false; error: 'locked'; retryAfterMs: number };

/** Pushed to the side panel over its `chrome.runtime` port. */
export interface StatusUpdate {
  type: 'status';
  status: ConnectionStatus;
}

export const SIDE_PANEL_PORT = 'sidepanel';
