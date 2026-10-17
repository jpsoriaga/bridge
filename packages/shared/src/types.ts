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
