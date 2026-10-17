import { z } from 'zod';
import {
  ReadParams,
  TreeParams,
  UndoParams,
  WriteParams,
  PairingCode,
  type ConnectionStatus,
  type FileOutcome,
  type ProjectInfo
} from '@bridge/shared';

/** chrome.runtime messages to the service worker, from the side panel or content script. */
export const WorkerRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get-status') }),
  z.strictObject({ type: z.literal('pair'), code: PairingCode }),
  z.strictObject({ type: z.literal('unpair') }),
  z.strictObject({ type: z.literal('retry') }),
  // Dev builds only: the side panel's "Test read" field. Refused in production.
  z.strictObject({
    type: z.literal('dev-file'),
    request: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('tree'), payload: TreeParams }),
      z.strictObject({ type: z.literal('read'), payload: ReadParams }),
      z.strictObject({ type: z.literal('write'), payload: WriteParams }),
      z.strictObject({ type: z.literal('undo'), payload: UndoParams })
    ])
  })
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
  /** The desktop's open project while connected, else null. */
  project: ProjectInfo | null;
}

/** A file request's outcome, plus the ways it can fail before the desktop answers. */
export type RequestOutcome<T> =
  | FileOutcome<T>
  | {
      ok: false;
      error: { code: 'not-connected' | 'timeout' | 'bad-response'; message: string };
    };

export const SIDE_PANEL_PORT = 'sidepanel';
