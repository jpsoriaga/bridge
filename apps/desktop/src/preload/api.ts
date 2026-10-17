import type {
  ConnectionStatus,
  FileErrorCode,
  FileRequest,
  LoopReport,
  Mode,
  ProjectInfo,
  RunResult
} from '@bridge/shared';

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
  mode: Mode;
  /** The open project's allowlist, or null until the user confirms one. */
  allowlist: string[] | null;
  /** Suggested entries from the project's package.json, shown until it's confirmed. */
  allowlistSuggestions: string[];
  defaultGatedPatterns: readonly string[];
  gatedPatterns: string[];
  defaultEnvPatterns: readonly string[];
  envPatterns: string[];
  runSettings: RunSettings;
  running: RunningCommand | null;
  /** The Full auto loop as the extension last reported it. */
  loop: LoopReport | null;
}

/** One row in the activity list. */
export interface ActivityEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  /**
   * A write Bridge made, or a request it refused (`rejected`: the sandbox; `failed`:
   * other), a command that ran (`run`), or a Full auto step (`loop`).
   */
  kind: 'create' | 'modify' | 'rejected' | 'failed' | 'run' | 'loop';
  /** Relative path, what the extension sent (sanitised) for a refusal, or the command. */
  path: string;
  /** For create/modify: the op to undo. */
  opId?: string;
  undone?: boolean;
  /** For create/modify: `chat` when applied from a diff card. */
  source?: 'chat';
  /** `auto`: Bridge did it on its own (Auto-apply, Full auto). */
  trigger?: 'auto';
  /** The Full auto run it belongs to. Rows with one are grouped. */
  loopId?: string;
  code?: FileErrorCode;
  op?: FileRequest['type'] | 'run';
  /** For `run`: how it ended. */
  run?: Pick<RunResult, 'status' | 'exitCode' | 'durationMs'>;
  /** For `loop`: what happened, in a few words. */
  text?: string;
}

/** The command running now, with its output so far (capped). */
export interface RunningCommand {
  runId: string;
  command: string;
  startedAt: number;
}

/** Command and Full auto settings, edited only in the app. */
export interface RunSettings {
  timeoutMs: number;
  stepLimit: number;
  pauseOnFailure: boolean;
}

export type OpenFolderResult =
  { ok: true } | { ok: false; reason: 'cancelled' | 'not-a-directory' | 'too-broad' | 'protected' };

/** `cancelled`: the file changed since Bridge wrote it and the user chose not to discard that. */
export type UndoOutcome = { ok: true } | { ok: false; code: FileErrorCode | 'cancelled' };

/** A list the app saves (allowlist, gated files, env filter): `invalid` names the bad entry. */
export type SaveListResult = { ok: true } | { ok: false; invalid: string | null };

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
  /** Switching to Full auto asks for confirmation in a native dialog first. Returns the mode now. */
  setMode(mode: Mode): Promise<Mode>;
  /** Confirms or replaces the open project's allowlist. */
  setAllowlist(entries: string[]): Promise<SaveListResult>;
  setGatedPatterns(patterns: string[]): Promise<SaveListResult>;
  setEnvPatterns(patterns: string[]): Promise<SaveListResult>;
  setRunSettings(settings: RunSettings): Promise<boolean>;
  /** Cancels the running command, if any. */
  cancelRun(): Promise<void>;
  /** Stops the Full auto loop and cancels its command. Reverts nothing. */
  stopLoop(): Promise<void>;
  /** Live output of the running command. Returns an unsubscribe function. */
  onRunOutput(listener: (chunk: { runId: string; text: string }) => void): () => void;
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
  setDenyPatterns: 'bridge:set-deny-patterns',
  setMode: 'bridge:set-mode',
  setAllowlist: 'bridge:set-allowlist',
  setGatedPatterns: 'bridge:set-gated-patterns',
  setEnvPatterns: 'bridge:set-env-patterns',
  setRunSettings: 'bridge:set-run-settings',
  cancelRun: 'bridge:cancel-run',
  stopLoop: 'bridge:stop-loop',
  runOutput: 'bridge:run-output'
} as const;
