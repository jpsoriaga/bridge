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
  /** How many times a chat session starting or ending turned Full auto off. Goes up: a toast. */
  sessionResets: number;
  /** The open project's allowlist, or null until the user confirms one. */
  allowlist: string[] | null;
  /** Suggested entries from the project's package.json, shown until it's confirmed. */
  allowlistSuggestions: string[];
  defaultGatedPatterns: readonly string[];
  gatedPatterns: string[];
  defaultEnvPatterns: readonly string[];
  envPatterns: string[];
  runSettings: RunSettings;
  /** The PATH commands run with, and where it came from. */
  commandPath: CommandPath;
  running: RunningCommand | null;
  /** The Full auto loop as the extension last reported it. */
  loop: LoopReport | null;
  /** How the open project is watched: every change, or only the files in context. */
  watch: 'watch' | 'poll' | null;
  theme: Theme;
  /** Days ops and backups are kept. */
  backupRetentionDays: number;
  /** The first-run checklist. */
  onboarding: { dismissed: boolean; sessionStarted: boolean };
}

export type Theme = 'system' | 'light' | 'dark';

/** One op as the Activity detail view shows it. */
export interface OpDetail {
  opId: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  path: string;
  from?: string;
  time: number;
  undone: boolean;
  before: string | null;
  after: string | null;
  /** Why there's no text: binary, too big, or the backup is gone. */
  unavailable?: 'binary' | 'too-large' | 'missing';
}

/** A command's full result, for the Activity detail view. */
export type RunDetail = Pick<
  RunResult,
  'argv' | 'status' | 'exitCode' | 'durationMs' | 'output' | 'truncated'
>;

/** What a menu item asks the window to do. */
export type MenuAction = 'settings' | 'onboarding' | 'activity' | 'session';

/** One row in the activity list. */
export interface ActivityEntry {
  id: string;
  /** Epoch ms. */
  time: number;
  /**
   * A change Bridge made (create, modify, delete, rename), or a request it refused
   * (`rejected`: the sandbox; `failed`: other), a command that ran (`run`), or a Full auto
   * step (`loop`).
   */
  kind: 'create' | 'modify' | 'delete' | 'rename' | 'rejected' | 'failed' | 'run' | 'loop';
  /** Relative path, what the extension sent (sanitised) for a refusal, or the command. */
  path: string;
  /** For a rename: the old path (`path` is the new one). */
  from?: string;
  /** For create/modify/delete/rename: the op to undo. */
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
  /** For `run`: its id, to fetch the full output while the app is open. */
  runId?: string;
  /** For `loop`: what happened, in a few words. */
  text?: string;
}

/** The command running now, with its output so far (capped). */
export interface RunningCommand {
  runId: string;
  command: string;
  startedAt: number;
}

/**
 * Where commands' PATH comes from: the login shell (macOS, Linux), the app's own (Windows),
 * the app's own because the login shell couldn't be read (`fallback`, with `warning`), or
 * the user's override. `null` source: the login shell is still being read.
 */
export interface CommandPath {
  source: 'login-shell' | 'inherited' | 'fallback' | 'override' | null;
  path: string;
  warning?: string;
  /** The user's override, or '' for none. */
  override: string;
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
  /** Replaces the PATH commands get. '' goes back to the login shell's. False if invalid. */
  setPathOverride(path: string): Promise<boolean>;
  /** Cancels the running command, if any. */
  cancelRun(): Promise<void>;
  /** Stops the Full auto loop and cancels its command. Reverts nothing. */
  stopLoop(): Promise<void>;
  /** Live output of the running command. Returns an unsubscribe function. */
  onRunOutput(listener: (chunk: { runId: string; text: string }) => void): () => void;
  /** Before and after text of one op, for the diff viewer. Null if it's not in the log. */
  getOpDetail(opId: string): Promise<OpDetail | null>;
  /** A command's full output, while the app is still open. Null once it's forgotten. */
  getRunDetail(runId: string): Promise<RunDetail | null>;
  setTheme(theme: Theme): Promise<boolean>;
  /** Days to keep ops and backups, 1–90. Prunes now. */
  setBackupRetention(days: number): Promise<boolean>;
  /** Opens the project's backups folder in Finder/Explorer. */
  openBackupsFolder(): Promise<boolean>;
  /** Asks in a native dialog, then deletes every backup for the project. */
  clearBackups(): Promise<boolean>;
  setOnboardingDismissed(dismissed: boolean): Promise<void>;
  /** Menu items that act in the window. Returns an unsubscribe function. */
  onMenu(listener: (action: MenuAction) => void): () => void;
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
  setPathOverride: 'bridge:set-path-override',
  cancelRun: 'bridge:cancel-run',
  stopLoop: 'bridge:stop-loop',
  runOutput: 'bridge:run-output',
  getOpDetail: 'bridge:get-op-detail',
  getRunDetail: 'bridge:get-run-detail',
  setTheme: 'bridge:set-theme',
  setBackupRetention: 'bridge:set-backup-retention',
  openBackupsFolder: 'bridge:open-backups-folder',
  clearBackups: 'bridge:clear-backups',
  setOnboardingDismissed: 'bridge:set-onboarding-dismissed',
  menu: 'bridge:menu'
} as const;
