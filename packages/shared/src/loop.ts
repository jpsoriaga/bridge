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
  'send-failed'
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
  'send-failed': 'Bridge pressed send, but no new message appeared.'
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
  event: LoopEvent.optional()
});
export type LoopReport = z.infer<typeof LoopReport>;
