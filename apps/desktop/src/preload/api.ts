import type { ConnectionStatus, FileErrorCode, FileRequest, ProjectInfo } from '@bridge/shared';

export interface PairingCode {
  /** Six digits, shown to the user and typed into the extension. */
  code: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Everything the renderer shows about the server and pairing. */
export interface DesktopState {
  /** `connecting` here means paired and waiting for the extension. */
  status: ConnectionStatus;
  paired: boolean;
  /** The port the server is bound to, or null if it isn't running. */
  port: number | null;
  pairing: PairingCode | null;
  /** Epoch ms until which `/pair` refuses codes after too many wrong ones, or null. */
  lockedUntil: number | null;
  /** The open project folder, or null. */
  project: ProjectInfo | null;
  /** Newest first, at most 5. Opened by index with `openRecent`. */
  recentProjects: ProjectInfo[];
  /** Built-in protected patterns. Read-only. */
  defaultDenyPatterns: readonly string[];
  /** The user's extra protected patterns. */
  denyPatterns: string[];
}

/** One row in the activity list. */
export interface ActivityEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  /** A write Bridge made, or a request it refused (`rejected`: the sandbox; `failed`: other). */
  kind: 'create' | 'modify' | 'rejected' | 'failed';
  /** Relative path, or what the extension sent (sanitised) for a refusal. */
  path: string;
  /** For create/modify: the op to undo. */
  opId?: string;
  undone?: boolean;
  code?: FileErrorCode;
  op?: FileRequest['type'];
}

export type OpenFolderResult =
  { ok: true } | { ok: false; reason: 'cancelled' | 'not-a-directory' | 'too-broad' | 'protected' };

/** `cancelled`: the file changed since Bridge wrote it and the user chose not to discard that. */
export type UndoOutcome = { ok: true } | { ok: false; code: FileErrorCode | 'cancelled' };

/** Everything the renderer can reach in the main world, as `window.bridge`. Keep it minimal. */
export interface BridgeApi {
  readonly version: string;
  getStatus(): Promise<DesktopState>;
  /** Returns an unsubscribe function. */
  onStatus(listener: (state: DesktopState) => void): () => void;
  startPairing(): Promise<PairingCode>;
  unpair(): Promise<void>;
  /** Shows the native folder picker. The renderer never passes a path. */
  openFolder(): Promise<OpenFolderResult>;
  openRecent(index: number): Promise<OpenFolderResult>;
  getActivity(): Promise<ActivityEntry[]>;
  /** Returns an unsubscribe function. */
  onActivity(listener: (entries: ActivityEntry[]) => void): () => void;
  /** Asks for confirmation in a native dialog if the file changed since the write. */
  undo(opId: string): Promise<UndoOutcome>;
  undoLast(): Promise<UndoOutcome>;
  /** Replaces the user's extra protected patterns. Returns false if any is invalid. */
  setDenyPatterns(patterns: string[]): Promise<boolean>;
}

/** One channel per method. Main checks the sender on each. */
export const IPC = {
  getStatus: 'bridge:get-status',
  status: 'bridge:status',
  startPairing: 'bridge:start-pairing',
  unpair: 'bridge:unpair',
  openFolder: 'bridge:open-folder',
  openRecent: 'bridge:open-recent',
  getActivity: 'bridge:get-activity',
  activity: 'bridge:activity',
  undo: 'bridge:undo',
  undoLast: 'bridge:undo-last',
  setDenyPatterns: 'bridge:set-deny-patterns'
} as const;
