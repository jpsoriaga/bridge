import {
  buildFollowUp,
  LOOP_MIN_SEND_GAP_MS,
  PAUSE_REASON_TEXT,
  type BridgeConfig,
  type ContextFile,
  type FollowUpRun,
  type LoopEvent,
  type LoopReport,
  type LoopState,
  type PauseReason,
  type RefusedFile,
  type RunResult
} from '@bridge/shared';
import type { InsertResult } from '../../messages';

/** How long a sent message has to show up as a new user turn. */
export const SEND_CONFIRM_MS = 10_000;
/** How long the send button may take to appear after the text goes in. */
export const SEND_BUTTON_WAIT_MS = 5_000;
const SEND_POLL_MS = 250;

/** The chat page, as the loop sees it. `page.ts` has the real one; tests use a fake. */
export interface LoopPage {
  conversationId(): string | null;
  /** User messages on the page, to see that a send went through. */
  userTurns(): number;
  composerText(): string;
  insert(text: string): InsertResult;
  /** Clicks the send button. False if there isn't one, or it's disabled. */
  submit(): boolean;
  /** A visible error or limit banner's text, or null. */
  error(): string | null;
}

/** Why an edit was left on its card for a click. */
export type EditHold = 'gated' | 'partial' | 'conflict' | 'blocked';

export interface EditSummary {
  applied: string[];
  held: { path: string; hold: EditHold; reason: string }[];
}

export type RunOutcome =
  { ok: true; result: RunResult } | { ok: false; disconnected: boolean; message: string };

/** One `@@RUN` in the reply, through its card. */
export interface RunAction {
  command: string;
  /** Null if allowed; else why not, in a few words. */
  refusal(): string | null;
  run(loopId: string): Promise<RunOutcome>;
}

/** What a finished reply asks for, through its cards. */
export interface ReplyActions {
  /** Edits, reads or runs. A reply with none ends the loop. */
  hasActions: boolean;
  /** `@@DONE@@`: apply the edits, then end. */
  done: boolean;
  /** Applies pending edits by the Auto-apply rules (skipping held ones). */
  applyEdits(loopId?: string): Promise<void>;
  /** Where the edits stand now, after Auto-apply and any clicks. */
  edits(): EditSummary;
  reads: readonly string[];
  readFiles(): Promise<{ files: ContextFile[]; refused: RefusedFile[]; disconnected: boolean }>;
  /** The READ card's files went out with the follow-up. */
  markReadsSent(): void;
  runs: readonly RunAction[];
}

export interface LoopDeps {
  page: LoopPage;
  /** The app's config, or null while disconnected. */
  config(): BridgeConfig | null;
  report(report: LoopReport): void;
  /** Stops the command running now, if this loop started one. */
  cancelRun(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  newId(): string;
}

type Phase = 'edits' | 'reads' | 'runs' | 'build' | 'send';

/** The step in progress: one reply's actions, and how far the loop got with them. */
interface Step {
  actions: ReplyActions;
  phase: Phase;
  /** Edits held for a click have paused the loop once already. */
  editsReviewed: boolean;
  /** Commands that aren't allowed have paused the loop once already. */
  disallowedReviewed: boolean;
  files: ContextFile[];
  refused: RefusedFile[];
  runs: FollowUpRun[];
  runIndex: number;
  message: string | null;
  /** Set once the message is in the composer: user turns before the send. */
  sentFrom: number | null;
}

const HOLD_REASON: Record<EditHold, PauseReason> = {
  gated: 'gated',
  partial: 'partial',
  conflict: 'conflict',
  blocked: 'blocked'
};

/**
 * Full auto, as a state machine. After a reply finishes it applies the edits (Auto-apply
 * rules), reads the files and runs the allowlisted commands the reply asked for, one after
 * another, puts one follow-up message in the composer, presses send, and checks that a new
 * user turn appeared. Then it waits for the next reply.
 *
 *   idle → acting → sending → waiting-reply → acting → … → idle
 *
 * It ends when a reply has no actions or says `@@DONE@@`, and pauses for a click on
 * anything it shouldn't decide alone (see `PauseReason`). Stop halts it at once and is
 * sticky: nothing starts again until Resume. Sends are at least 3s apart, and there's no
 * other delay: Bridge doesn't pretend to be a person.
 */
export class FullAutoLoop {
  state: LoopState = 'idle';
  step = 0;
  limit = 0;
  reason: PauseReason | undefined;
  loopId = '';
  /** The conversation this run belongs to. */
  private conversation: string | null = null;
  private current: Step | null = null;
  private lastSendAt = Number.NEGATIVE_INFINITY;
  /** Bumped by Stop and by a new run, so work still in flight drops its result. */
  private generation = 0;
  private running = false;

  constructor(private readonly deps: LoopDeps) {}

  /** True while a run is going or waits on the user. */
  get active(): boolean {
    return this.state !== 'idle' && this.state !== 'stopped';
  }

  /** A new assistant reply finished (one that wasn't on the page when it loaded). */
  onReply(actions: ReplyActions): void {
    if (this.deps.config()?.mode !== 'full-auto') return;
    // A reply after Bridge pressed send is proof the message went out, whatever the page's
    // turn count says (it may only keep nearby turns mounted).
    const clicked = this.current?.sentFrom !== null && this.current?.sentFrom !== undefined;
    if (
      clicked &&
      (this.state === 'sending' || (this.state === 'paused' && this.reason === 'send-failed'))
    ) {
      this.confirmSent(this.current!);
    }
    if (this.state === 'stopped' || this.state === 'acting' || this.state === 'sending') return;
    if (this.state === 'paused') {
      // The user carried on by hand. That run is over; this reply may start the next.
      this.finish('A new reply arrived while paused, so that run ended.');
    }
    if (this.state === 'idle') {
      if (!actions.hasActions || actions.done) {
        // Nothing to loop on. Still apply what a DONE reply edits.
        if (actions.done && actions.hasActions) void actions.applyEdits();
        return;
      }
      this.generation += 1;
      this.loopId = this.deps.newId();
      this.step = 0;
      this.limit = this.deps.config()?.stepLimit ?? 1;
      this.conversation = this.deps.page.conversationId();
      this.reason = undefined;
      this.lastSendAt = Number.NEGATIVE_INFINITY;
      this.emit({ kind: 'started', text: 'Full auto run started.' });
    }
    // waiting-reply (or a run that just started).
    if (!actions.hasActions) {
      this.finish(actions.done ? 'The chat said it’s done.' : 'The chat asked for nothing more.');
      return;
    }
    this.current = {
      actions,
      phase: 'edits',
      editsReviewed: false,
      disallowedReviewed: false,
      files: [],
      refused: [],
      runs: [],
      runIndex: 0,
      message: null,
      sentFrom: null
    };
    this.set('acting');
    void this.advance();
  }

  /** Halts the loop and its command now. Reverts nothing. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.generation += 1;
    this.current = null;
    this.reason = undefined;
    this.deps.cancelRun();
    this.set('stopped', { kind: 'stopped', text: 'Stopped.' });
  }

  /** Carries on after a pause, or allows runs again after Stop. */
  resume(): void {
    if (this.state === 'stopped') {
      this.set('idle', { kind: 'resumed', text: 'Full auto can start again.' });
      return;
    }
    if (this.state !== 'paused') return;
    const config = this.deps.config();
    if (!config || config.mode !== 'full-auto') return;
    if (this.reason === 'navigated' && this.deps.page.conversationId() !== this.conversation) {
      return;
    }
    if (this.reason === 'step-limit') {
      this.continueFor();
      return;
    }
    if (this.reason === 'too-big') {
      this.finish('The follow-up was too big to send. It’s over to you.');
      return;
    }
    this.reason = undefined;
    if (!this.current) {
      // Paused while waiting for a reply (page error, lost connection): keep waiting.
      this.set('waiting-reply', { kind: 'resumed', text: 'Resumed.' });
      return;
    }
    this.set('acting', { kind: 'resumed', text: 'Resumed.' });
    void this.advance();
  }

  /** After the step limit: allow another `stepLimit` sends, then carry on. */
  continueFor(): void {
    if (this.state !== 'paused' || this.reason !== 'step-limit') return;
    this.limit += this.deps.config()?.stepLimit ?? 1;
    this.reason = undefined;
    this.set('acting', { kind: 'resumed', text: `Continuing, up to ${this.limit} messages.` });
    void this.advance();
  }

  /** The tab moved to another conversation (or a new chat). */
  onNavigate(conversationId: string | null): void {
    if (!this.active || conversationId === this.conversation) return;
    this.pause('navigated');
  }

  /** The app's config changed, or the connection went (null). */
  onConfig(config: BridgeConfig | null): void {
    if (config === null) {
      if (this.active && this.state !== 'paused') this.pause('disconnected');
      return;
    }
    if (config.mode !== 'full-auto' && this.state !== 'idle') {
      this.generation += 1;
      this.current = null;
      this.reason = undefined;
      if (this.active) this.deps.cancelRun();
      this.set('idle', { kind: 'stopped', text: 'Full auto was turned off.' });
    }
  }

  /** Called about once a second: an error banner while waiting for a reply pauses the loop. */
  tick(): void {
    if (this.state === 'waiting-reply' && this.deps.page.error()) this.pause('page-error');
  }

  private async advance(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.work(this.generation);
    } finally {
      this.running = false;
    }
  }

  /** Runs the current step from its phase until it sends, pauses or ends. */
  private async work(generation: number): Promise<void> {
    const step = this.current;
    if (!step) return;
    const stale = () => generation !== this.generation || this.current !== step;
    const { actions } = step;

    if (step.phase === 'edits') {
      await actions.applyEdits(this.loopId);
      if (stale()) return;
      const { applied, held } = actions.edits();
      if (applied.length > 0) {
        this.emit({
          kind: 'applied',
          text: `Applied ${applied.length} of ${applied.length + held.length} edits.`
        });
      }
      if (actions.done) {
        this.finish('The chat said it’s done.');
        return;
      }
      step.phase = 'reads';
      const first = held[0];
      if (first && !step.editsReviewed) {
        step.editsReviewed = true;
        this.pause(HOLD_REASON[first.hold]);
        return;
      }
    }

    if (step.phase === 'reads') {
      if (!step.disallowedReviewed && actions.runs.some((run) => run.refusal() !== null)) {
        step.disallowedReviewed = true;
        this.pause('not-allowed');
        return;
      }
      if (actions.reads.length > 0) {
        const read = await actions.readFiles();
        if (stale()) return;
        if (read.disconnected) {
          this.pause('disconnected');
          return;
        }
        step.files = read.files;
        step.refused = read.refused;
      }
      step.phase = 'runs';
    }

    if (step.phase === 'runs') {
      while (step.runIndex < actions.runs.length) {
        const run = actions.runs[step.runIndex]!;
        const refusal = run.refusal();
        if (refusal !== null) {
          step.runs.push({ command: run.command, refused: refusal });
          step.runIndex += 1;
          continue;
        }
        const outcome = await run.run(this.loopId);
        if (stale()) return;
        if (!outcome.ok) {
          if (outcome.disconnected) {
            this.pause('disconnected');
            return;
          }
          step.runs.push({ command: run.command, refused: outcome.message });
          step.runIndex += 1;
          continue;
        }
        step.runs.push({ command: run.command, result: outcome.result });
        step.runIndex += 1;
        const { status, exitCode } = outcome.result;
        const passed = status === 'exited' && exitCode === 0;
        this.emit({
          kind: 'ran',
          text: `${run.command}: ${passed ? 'passed' : status === 'exited' ? `exit ${exitCode ?? '?'}` : status}`
        });
        if (!passed && this.deps.config()?.pauseOnFailure) {
          this.pause('failure');
          return;
        }
      }
      step.phase = 'build';
    }

    if (step.phase === 'build') {
      const { applied, held } = actions.edits();
      const built = buildFollowUp({
        applied,
        skipped: held.map(({ path, reason }) => ({ path, reason })),
        files: step.files,
        refused: step.refused,
        runs: step.runs
      });
      if (!built) {
        this.pause('too-big');
        return;
      }
      step.message = built.text;
      step.phase = 'send';
    }

    if (step.phase === 'send') await this.send(step, stale);
  }

  private async send(step: Step, stale: () => boolean): Promise<void> {
    const { page } = this.deps;
    if (step.sentFrom === null) {
      if (this.step >= this.limit) {
        this.pause('step-limit');
        return;
      }
      if (page.error()) {
        this.pause('page-error');
        return;
      }
      const wait = this.lastSendAt + LOOP_MIN_SEND_GAP_MS - this.deps.now();
      if (wait > 0) {
        await this.deps.sleep(wait);
        if (stale()) return;
      }
      this.set('sending');
      const before = page.userTurns();
      if (!page.composerText().trim()) {
        const inserted = page.insert(step.message ?? '');
        if (!inserted.ok) {
          this.pause('send-failed');
          return;
        }
      }
      step.sentFrom = before;
      if (!(await this.pressSend(stale))) {
        if (!stale()) this.pause('send-failed');
        return;
      }
      this.lastSendAt = this.deps.now();
    } else if (!this.sendLanded(step)) {
      // Resumed after a send that didn't show up: press send again (the text is still there).
      this.set('sending');
      if (!page.composerText().trim() && !page.insert(step.message ?? '').ok) {
        this.pause('send-failed');
        return;
      }
      if (!(await this.pressSend(stale))) {
        if (!stale()) this.pause('send-failed');
        return;
      }
      this.lastSendAt = this.deps.now();
    }

    const deadline = this.deps.now() + SEND_CONFIRM_MS;
    while (!this.sendLanded(step)) {
      if (this.deps.now() >= deadline) {
        this.pause('send-failed');
        return;
      }
      await this.deps.sleep(SEND_POLL_MS);
      if (stale()) return;
    }
    this.confirmSent(step);
  }

  /**
   * Whether the follow-up went out: a new user turn, or the composer no longer holding it
   * (the page empties it on send). The turn count alone isn't enough: the page may unmount
   * turns far from the viewport.
   */
  private sendLanded(step: Step): boolean {
    const { page } = this.deps;
    if (page.userTurns() > (step.sentFrom ?? Number.POSITIVE_INFINITY)) return true;
    const composer = page.composerText().trim();
    if (!composer) return true;
    // The first line only: a rich composer joins paragraphs without line breaks.
    const probe = (step.message ?? '').trim().split('\n')[0]!.slice(0, 40).trim();
    return probe.length > 0 && !composer.includes(probe);
  }

  /** The follow-up went out: count it and wait for the reply. */
  private confirmSent(step: Step): void {
    this.step += 1;
    step.actions.markReadsSent();
    this.current = null;
    this.reason = undefined;
    this.set('waiting-reply', {
      kind: 'sent',
      text: `Sent message ${this.step} of ${this.limit}.`
    });
  }

  /**
   * Clicks send, waiting for the button: the page shows (or enables) it only once it has
   * rendered the text just inserted, so it may not be there yet.
   */
  private async pressSend(stale: () => boolean): Promise<boolean> {
    const deadline = this.deps.now() + SEND_BUTTON_WAIT_MS;
    while (!this.deps.page.submit()) {
      if (stale() || this.deps.now() >= deadline) return false;
      await this.deps.sleep(SEND_POLL_MS);
    }
    return true;
  }

  private pause(reason: PauseReason): void {
    this.reason = reason;
    this.set('paused', { kind: 'paused', text: PAUSE_REASON_TEXT[reason] });
  }

  private finish(text: string): void {
    this.generation += 1;
    this.current = null;
    this.reason = undefined;
    this.set('idle', { kind: 'done', text });
  }

  private emit(event: LoopEvent): void {
    this.report(event);
  }

  private set(state: LoopState, event?: LoopEvent): void {
    this.state = state;
    this.report(event);
  }

  private report(event?: LoopEvent): void {
    // Stop before any run still reports, under an id of its own.
    if (!this.loopId) this.loopId = this.deps.newId();
    this.deps.report({
      loopId: this.loopId,
      state: this.state,
      step: this.step,
      limit: Math.max(1, this.limit),
      ...(this.state === 'paused' && this.reason && { reason: this.reason }),
      ...(event && { event })
    });
  }
}
