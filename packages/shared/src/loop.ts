import { z } from 'zod';
import { LoopId } from './files';

// The Full auto loop runs in the extension. The desktop shows its state, logs its steps in
// Activity and can stop it. These are the words both sides use.

export const DEFAULT_STEP_LIMIT = 10;
export const MAX_STEP_LIMIT = 25;
/** The loop never auto-sends sooner than this after the previous auto-send. */
export const LOOP_MIN_SEND_GAP_MS = 3_000;

export const LOOP_STATES = [
  'idle',
  'waiting-reply',
  'acting',
  'sending',
  'paused',
  'stopped'
] as const;
export const LoopState = z.enum(LOOP_STATES);
export type LoopState = z.infer<typeof LoopState>;

/** Why the loop stopped to wait for a click. */
export const PAUSE_REASONS = [
  'gated',
  'partial',
  'conflict',
  'blocked',
  'not-allowed',
  'failure',
  'too-big',
  'page-error',
  'disconnected',
  'navigated',
  'step-limit',
  'send-failed',
  'needs-click',
  'app-restarted',
  'slept',
  'format-issues',
  'stalled',
  'interrupted',
  'command-interrupted'
] as const;
export const PauseReason = z.enum(PAUSE_REASONS);
export type PauseReason = z.infer<typeof PauseReason>;

export const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  gated: 'An edit touches a gated file. Review it on its card.',
  partial: 'An edit looks like part of a file. Review it on its card.',
  conflict: 'A file changed since the reply was written. Review the new diff on its card.',
  blocked: 'Bridge refused an edit. Its card says why.',
  'not-allowed': 'The chat asked for a command that isn’t on the allowlist.',
  failure: 'A command failed, and “Pause on failure” is on.',
  'too-big': 'The follow-up message is too big to send, even trimmed.',
  'page-error': 'The chat page shows an error or a limit.',
  disconnected: 'The connection to the Bridge app was lost.',
  navigated: 'You left the conversation the loop was running in.',
  'step-limit': 'The loop reached its step limit.',
  'send-failed': 'Bridge pressed send, but no new message appeared.',
  'needs-click':
    'The reply deletes or renames files. Those always need your click: review them on their cards, then Resume.',
  'app-restarted':
    'The Bridge app restarted, which turns Full auto off. Turn it on again in the app, then Resume.',
  slept: 'The computer slept in the middle of a step. Check the cards, then Resume.',
  'format-issues':
    'The chat kept missing Bridge’s format after two reminders. Check the reply, then Resume.',
  stalled: 'The chat seems stuck after sleep.',
  interrupted: 'The chat’s reply was interrupted.',
  'command-interrupted': 'A command was interrupted by sleep.'
};

/**
 * A pause reason in words, with what it's about where that helps: the last complete marker
 * of an interrupted reply, or the interrupted command.
 */
export function pauseReasonText(reason: PauseReason, detail?: string): string {
  if (reason === 'interrupted') {
    return detail
      ? `The chat’s reply was interrupted after ${detail}.`
      : 'The chat’s reply was interrupted before its first Bridge marker.';
  }
  if (reason === 'command-interrupted' && detail) {
    return `A command was interrupted by sleep: ${detail}`;
  }
  return PAUSE_REASON_TEXT[reason];
}

/** How long a reply may show as streaming with no new text, after sleep, before it's stuck. */
export const STALL_MS = 60_000;

/**
 * Extra words on a report after the computer slept: `after-sleep` while Full auto waits for
 * a reply that was streaming when it slept, `caught-up` while it acts on that reply.
 */
export const LOOP_NOTES = ['after-sleep', 'caught-up'] as const;
export const LoopNote = z.enum(LOOP_NOTES);
export type LoopNote = z.infer<typeof LoopNote>;

export const LOOP_NOTE_TEXT: Record<LoopNote, string> = {
  'after-sleep': 'Waiting for the chat to finish (resumed after sleep)',
  'caught-up': 'Caught up after sleep'
};

export const LOOP_STATE_LABELS: Record<LoopState, string> = {
  idle: 'Idle',
  'waiting-reply': 'Waiting for the reply',
  acting: 'Applying and running',
  sending: 'Sending',
  paused: 'Paused',
  stopped: 'Stopped'
};

/** One step of a loop run, as the desktop logs it. */
export const LoopEvent = z.strictObject({
  kind: z.enum(['started', 'applied', 'ran', 'sent', 'paused', 'resumed', 'stopped', 'done']),
  text: z.string().max(300)
});
export type LoopEvent = z.infer<typeof LoopEvent>;

/** The loop's state, as the extension reports it to the desktop after every change. */
export const LoopReport = z.strictObject({
  loopId: LoopId,
  state: LoopState,
  /** Messages auto-sent in this run. */
  step: z.number().int().nonnegative().max(1000),
  limit: z.number().int().positive().max(1000),
  reason: PauseReason.optional(),
  /** What the pause is about (`pauseReasonText`): a marker, a path or a command. */
  detail: z.string().max(300).optional(),
  /** The chat page shows its own "Continue generating" button for the interrupted reply. */
  pageContinue: z.boolean().optional(),
  note: LoopNote.optional(),
  event: LoopEvent.optional()
});
export type LoopReport = z.infer<typeof LoopReport>;
