/** One whole-file write proposed by the assistant. `path` is relative to the project root. */
export interface FileEdit {
  path: string;
  content: string;
}

/** How proposed edits reach disk. See PLAN.md, "Modes". */
export type Mode = 'manual' | 'auto-apply' | 'full-auto';

export const MODES: readonly Mode[] = ['manual', 'auto-apply', 'full-auto'];

export const MODE_LABELS: Record<Mode, string> = {
  manual: 'Manual',
  'auto-apply': 'Auto-apply',
  'full-auto': 'Full auto'
};

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  manual: 'Review every edit before it is written.',
  'auto-apply': 'Edits apply instantly. You can undo any change.',
  'full-auto': 'Edits apply and allowlisted commands run without asking.'
};

/** Connection between the extension and the desktop app, as either side reports it. */
export type ConnectionStatus =
  | 'app-not-running'
  | 'not-paired'
  | 'connecting'
  | 'connected'
  | 'error'
  /** The two sides speak different protocol versions; the named one is older. */
  | 'update-app'
  | 'update-extension';

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'app-not-running',
  'not-paired',
  'connecting',
  'connected',
  'error',
  'update-app',
  'update-extension'
];

/** `data-tone` for the status pill dot. `undefined` is the idle grey. */
export const CONNECTION_STATUS_TONES: Record<
  ConnectionStatus,
  'success' | 'warning' | 'danger' | undefined
> = {
  'app-not-running': undefined,
  'not-paired': undefined,
  connecting: 'warning',
  connected: 'success',
  error: 'danger',
  'update-app': 'warning',
  'update-extension': 'warning'
};
