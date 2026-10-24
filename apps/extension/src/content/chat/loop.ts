import {
  buildFollowUp,
  failureSignature,
  FORMAT_REMINDER,
  LOOP_GUARD_REPEATS,
  LOOP_MIN_SEND_GAP_MS,
  pauseReasonText,
  STALL_MS,
  type BridgeConfig,
  type ContextFile,
  type FollowUpProcess,
  type FollowUpRun,
  type Interruption,
  type LoopEvent,
  type LoopNote,
  type LoopReport,
  type LoopState,
  type PauseReason,
  type ProcessLines,
  type RefusedFile,
  type RunResult
} from '@bridge/shared';
import type { AttachmentFile, InsertResult } from '../../messages';

/** How long a sent message has to show up as a new user turn. */
export const SEND_CONFIRM_MS = 10_000;
/** How long the send button may take to appear after the text goes in. */
export const SEND_BUTTON_WAIT_MS = 5_000;
/** With images attached, the page enables send only once they've uploaded. */
export const ATTACH_SEND_WAIT_MS = 60_000;
/**
 * After edits, how long dev servers get to rebuild before Full auto reads the errors they
 * printed (hot reload usually takes well under this).
 */
export const PROCESS_SETTLE_MS = 3_000;
const SEND_POLL_MS = 250;
/** Format reminders Full auto sends in one run before it pauses with `format-issues`. */
export const MAX_FORMAT_REMINDERS = 2;
/**
 * After waking, a lost connection is the sleep's doing for this long: Full auto picks up
 * where it was once the app is back, instead of waiting for Resume.
 */
export const WAKE_WINDOW_MS = 120_000;
/** A reply cut off by an error reaches the loop through a scan; the banner waits this long. */
export const INTERRUPT_GRACE_MS = 10_000;
/** How long a re-run waits for the interrupted run to finish cancelling. */
const RERUN_WAIT_MS = 5_000;

/**
 * The newest assistant reply: none yet, still streaming, finished, or cut off (an error in
 * its turn or the page's own "Continue generating").
 */
export type ReplyStatus = 'none' | 'streaming' | 'complete' | 'interrupted';

/** The chat page, as the loop sees it. `page.ts` has the real one; tests use a fake. */
export interface LoopPage {
  conversationId(): string | null;
  /** User messages on the page, to see that a send went through. */
  userTurns(): number;
  composerText(): string;
  insert(text: string): InsertResult;
  /** Attaches images to the message, as the attach button would. False if it couldn't. */
  attach(images: readonly AttachmentFile[]): boolean;
  /** Clicks the send button. False if there isn't one, or it's disabled. */
  submit(): boolean;
  /** A visible error or limit banner's text, or null. */
  error(): string | null;
  replyStatus(): ReplyStatus;
  /** Characters in the newest reply so far, to tell a stalled reply from a slow one. */
  replyLength(): number;
  /** Clicks the page's stop button. False if there isn't one. */
  stopReply(): boolean;
  /** Clicks the page's own "Continue generating". False if there isn't one. */
  continueReply(): boolean;
  /** The browser thinks it's online. */
  online(): boolean;
}

/** Why an edit was left on its card for a click. */
export type EditHold = 'gated' | 'partial' | 'conflict' | 'blocked';

export interface EditSummary {
  applied: string[];
  held: { path: string; hold: EditHold; reason: string }[];
}

/** Where a reply's deletes and renames stand. They never apply on their own. */
export interface ChangeSummary {
  /** "src/old.ts (deleted)", "a.ts → b.ts (renamed)". */
  applied: string[];
  /** Still waiting for a click, as the same kind of text. */
  pending: string[];
}

export type RunOutcome =
  { ok: true; result: RunResult } | { ok: false; disconnected: boolean; message: string };

/** One `@@START` or `@@STOP` in the reply, through its card. */
export interface ProcessAction {
  kind: 'start' | 'stop';
  command: string;
  /** Null if allowed; else why not. A STOP is always allowed. */
  refusal(): string | null;
  act(loopId: string): Promise<FollowUpProcess | { disconnected: true }>;
}

/** One `@@LOGS` in the reply. */
export interface LogsAction {
  command: string;
  read(): Promise<ProcessLines | { refused: string } | { disconnected: true }>;
}

/** Where each running background process's log was, to read only what came after. */
export type LogCursor = readonly { command: string; next: number }[];

/** What a reply's `@@READ`s came to: text files, images to attach, refusals. */
export interface ReadOutcome {
  files: ContextFile[];
  images?: (AttachmentFile & { path: string })[];
  refused: RefusedFile[];
  disconnected: boolean;
}

/** One `@@RUN` in the reply, through its card. */
export interface RunAction {
  command: string;
  /** Null if allowed; else why not, in a few words. */
  refusal(): string | null;
  run(loopId: string): Promise<RunOutcome>;
  /** Still running (or cancelling) from before. */
  busy?(): boolean;
}

/** Where a cut-off reply stopped, and whether the page offers its own Continue generating. */
export type ReplyInterruption = Interruption & { pageContinue: boolean };

/** What a finished reply asks for, through its cards. */
export interface ReplyActions {
  /** Edits, reads or runs. A reply with none ends the loop. */
  hasActions: boolean;
  /** `@@DONE@@`: apply the edits, then end. */
  done: boolean;
  /**
   * Something in the reply looks meant for Bridge but isn't in its format (`FormatIssue`).
   * Full auto asks the chat to redo it instead of acting on it.
   */
  formatIssues: boolean;
  /** Full auto sent the format reminder for this reply. */
  markReminded(): void;
  /**
   * Applies pending edits by the Auto-apply rules (skipping held ones), saves the images the
   * chat named with `@@ASSET`, and applies what "Also approve automatically" allows.
   */
  applyEdits(loopId?: string): Promise<void>;
  /** Where the edits stand now, after Auto-apply and any clicks. */
  edits(): EditSummary;
  /** Where the reply's deletes and renames stand. */
  changes(): ChangeSummary;
  /** Each edit as `path` + content hash, for the loop guard: the same file written the same way. */
  fingerprints?: readonly { path: string; hash: string }[];
  reads: readonly string[];
  readFiles(): Promise<ReadOutcome>;
  /** The READ card's files went out with the follow-up. */
  markReadsSent(): void;
  runs: readonly RunAction[];
  /** `@@START` and `@@STOP`, in the reply's order. */
  processes?: readonly ProcessAction[];
  /** `@@LOGS`. */
  logs?: readonly LogsAction[];
  /** The reply's `@@DOWNLOAD`s: saved, and still waiting for the user's click (always). */
  downloads?(): ChangeSummary;
  /** Where each running background process's log is now. */
  logCursor?(): Promise<LogCursor>;
  /** Error lines the background processes printed since `cursor`. */
  processErrors?(cursor: LogCursor): Promise<ProcessLines[]>;
  /**
   * The reply was cut off (an error, the network, or Bridge stopping a stuck reply): where.
   * Its unfinished block is already left out of the edits above. Null for a whole reply.
   */
  interruption: ReplyInterruption | null;
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

type Phase = 'edits' | 'reads' | 'review' | 'processes' | 'runs' | 'logs' | 'build' | 'send';

/** The step in progress: one reply's actions, and how far the loop got with them. */
interface Step {
  actions: ReplyActions;
  phase: Phase;
  /** Edits held for a click have paused the loop once already. */
  editsReviewed: boolean;
  /** Deletes and renames have paused the loop once already. */
  changesReviewed: boolean;
  /** Commands that aren't allowed have paused the loop once already. */
  disallowedReviewed: boolean;
  /** Downloads waiting for a click have paused the loop once already. */
  downloadsReviewed: boolean;
  /** The loop guard has looked at this step's edits. */
  guarded: boolean;
  files: ContextFile[];
  /** Images the chat asked for, attached to the follow-up. */
  images: (AttachmentFile & { path: string })[];
  refused: RefusedFile[];
  runs: FollowUpRun[];
  runIndex: number;
  processes: FollowUpProcess[];
  processIndex: number;
  logs: ProcessLines[];
  /** Errors background processes printed after this step's edits. */
  errors: ProcessLines[];
  /** Where the background logs were before the edits. Null until read. */
  cursor: LogCursor | null;
  /** When the edits went in, so dev servers get a moment to rebuild. */
  editedAt: number | null;
  message: string | null;
  /** Likely secrets the follow-up had replaced with `[redacted]`. */
  redacted: number;
  /** Set once the message is in the composer: user turns before the send. */
  sentFrom: number | null;
  /** The step only sends `FORMAT_REMINDER`: the reply missed the format. */
  reminder: boolean;
  /** The reply was cut off: the follow-up asks the chat to continue. */
  continuation?: Interruption;
}

/** After waking, the reply Full auto waits for: how long it went without new text. */
interface StallWatch {
  length: number;
  changedAt: number;
  /** Stuck replies Bridge already stopped on its own. */
  stops: number;
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
 * A reply that misses Bridge's format gets a reminder instead (see `onFormatIssues`).
 * It ends when a reply has no actions or says `@@DONE@@`, and pauses for a click on
 * anything it shouldn't decide alone (see `PauseReason`). Stop halts it at once and is
 * sticky: nothing starts again until Resume. Sends are at least 3s apart, and there's no
 * other delay: Bridge doesn't pretend to be a person.
 */
export class FullAutoLoop {
  state: LoopState = 'idle';
  step = 0;
  /** The run's step limit, or null for Unlimited. */
  limit: number | null = 0;
  reason: PauseReason | undefined;
  loopId = '';
  /** The conversation this run belongs to. */
  private conversation: string | null = null;
  private current: Step | null = null;
  private lastSendAt = Number.NEGATIVE_INFINITY;
  /** Format reminders sent (or being sent) in this run. */
  private reminders = 0;
  /** Bumped by Stop and by a new run, so work still in flight drops its result. */
  private generation = 0;
  /** The generation whose work is running now, if any. */
  private working: number | null = null;
  /** The app launch the config came from. A new one means the app restarted. */
  private instance: string | null = null;
  /** `catchUpAfterSleep` from the last config seen (the connection may be gone on waking). */
  private catchUp = true;
  /** When the computer last woke, while catching up. */
  private wokeAt: number | null = null;
  /** After waking: the reply being waited for, to notice it stuck. Ends with a whole reply. */
  private watch: StallWatch | null = null;
  /** After sleep: waiting for the reply that was streaming (`after-sleep`), or acting on it. */
  note: LoopNote | undefined;
  /** What the pause is about: the last complete marker, or the interrupted command. */
  private detail: string | undefined;
  private pageContinue = false;
  /** Bridge already asked the chat to continue the last cut-off reply on its own. */
  private continued = false;
  /** A lost connection paused the run while catching up: pick it up when the app is back. */
  private resumeOnConnect = false;
  /** A reply that finished while the app was unreachable after waking. */
  private deferred: ReplyActions | null = null;
  /** The command this step is running now. */
  private running: string | null = null;
  /** Since when an error banner has shown over a cut-off reply. */
  private errorSince: number | null = null;
  /** The loop guard: each command's last failure and how many times in a row it repeated. */
  private failures = new Map<string, { signature: string; count: number }>();
  /** The loop guard: how many replies wrote each file with the same content, this run. */
  private writes = new Map<string, number>();

  constructor(private readonly deps: LoopDeps) {}

  /** True while a run is going or waits on the user. */
  get active(): boolean {
    return this.state !== 'idle' && this.state !== 'stopped';
  }

  /** A new assistant reply finished (one that wasn't on the page when it loaded). */
  onReply(actions: ReplyActions): void {
    if (this.deps.config() === null && this.inWakeWindow() && this.state === 'waiting-reply') {
      // Finished while the app was out of reach after sleep: act on it once it's back.
      this.deferred = actions;
      this.pause('disconnected');
      return;
    }
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
    if (this.state === 'paused' && (this.reason === 'stalled' || this.reason === 'interrupted')) {
      // The stuck or cut-off reply came to an end after all (or the page continued it):
      // the run goes on with it.
      this.current = null;
      this.reason = undefined;
      this.state = 'waiting-reply';
    }
    if (this.state === 'paused') {
      // The user carried on by hand. That run is over; this reply may start the next.
      this.finish('A new reply arrived while paused, so that run ended.');
    }
    if (this.state === 'idle') {
      const cut = actions.interruption;
      const resumable = cut !== null && (actions.hasActions || cut.marker !== null);
      if ((!actions.hasActions && !actions.formatIssues && !resumable) || actions.done) {
        // Nothing to loop on. Still apply what a DONE reply edits.
        if (actions.done && actions.hasActions) void actions.applyEdits();
        return;
      }
      this.generation += 1;
      this.loopId = this.deps.newId();
      this.step = 0;
      const config = this.deps.config();
      this.limit = config ? config.stepLimit : 1;
      this.failures.clear();
      this.writes.clear();
      // The app launch this run belongs to, so a restart mid-run is noticed.
      this.instance = this.deps.config()?.instance ?? this.instance;
      this.conversation = this.deps.page.conversationId();
      this.reason = undefined;
      this.lastSendAt = Number.NEGATIVE_INFINITY;
      this.reminders = 0;
      this.continued = false;
      this.emit({ kind: 'started', text: 'Full auto run started.' });
    }
    // waiting-reply (or a run that just started).
    if (actions.interruption && !actions.done) {
      this.onInterrupted(actions, actions.interruption);
      return;
    }
    this.continued = false;
    if (this.watch) {
      this.watch = null;
      this.note = 'caught-up';
      this.emit({ kind: 'resumed', text: 'Caught up after sleep.' });
    }
    if (actions.formatIssues && !actions.done) {
      this.onFormatIssues(actions);
      return;
    }
    if (!actions.hasActions) {
      this.finish(actions.done ? 'The chat said it’s done.' : 'The chat asked for nothing more.');
      return;
    }
    this.current = this.newStep(actions);
    this.set('acting');
    void this.advance();
  }

  /**
   * The reply missed Bridge's format. Rather than act on half of it, ask the chat to redo it:
   * one reminder per reply, `MAX_FORMAT_REMINDERS` per run. The files it asked for go with
   * the reminder, so its READ card is answered either way. Past the limit the run pauses;
   * Resume acts on whatever Bridge could read.
   */
  private onFormatIssues(actions: ReplyActions): void {
    if (this.reminders >= MAX_FORMAT_REMINDERS) {
      this.current = actions.hasActions ? this.newStep(actions) : null;
      this.pause('format-issues');
      return;
    }
    this.reminders += 1;
    this.current = { ...this.newStep(actions), phase: 'reads', reminder: true };
    this.set('acting');
    void this.advance();
  }

  /**
   * The reply was cut off. Its whole blocks are acted on as usual, and the follow-up asks the
   * chat to continue, or the page's own Continue generating carries on the same reply. Bridge
   * does that on its own once per interruption, and only online; past that it pauses.
   */
  private onInterrupted(actions: ReplyActions, cut: ReplyInterruption): void {
    this.detail = cut.marker ?? undefined;
    this.pageContinue = cut.pageContinue;
    const step = { ...this.newStep(actions), continuation: cut };
    if (this.continued || !this.deps.page.online()) {
      this.current = step;
      this.pause('interrupted');
      return;
    }
    this.continued = true;
    if (cut.pageContinue && this.deps.page.continueReply()) {
      this.current = null;
      this.set('waiting-reply', {
        kind: 'resumed',
        text: 'The reply was cut off. Bridge pressed the page’s Continue generating.'
      });
      return;
    }
    this.emit({
      kind: 'resumed',
      text: `The reply was cut off${cut.marker ? ` after ${cut.marker}` : ''}. Asking the chat to continue.`
    });
    this.current = step;
    this.set('acting');
    void this.advance();
  }

  private newStep(actions: ReplyActions): Step {
    return {
      actions,
      phase: 'edits',
      editsReviewed: false,
      changesReviewed: false,
      disallowedReviewed: false,
      downloadsReviewed: false,
      guarded: false,
      files: [],
      images: [],
      refused: [],
      runs: [],
      runIndex: 0,
      processes: [],
      processIndex: 0,
      logs: [],
      errors: [],
      cursor: null,
      editedAt: null,
      message: null,
      redacted: 0,
      sentFrom: null,
      reminder: false
    };
  }

  /** Halts the loop and its command now. Reverts nothing. */
  stop(): void {
    if (this.state === 'stopped') return;
    this.generation += 1;
    this.current = null;
    this.reason = undefined;
    this.clearCatchUp();
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
    if (this.reason === 'stalled') {
      this.stopAndContinue();
      return;
    }
    // Resume after an interruption is the user asking for the continuation.
    if (this.reason === 'interrupted') this.continued = true;
    // Resume after the loop guard: the user looked, so what repeated starts counting again.
    if (this.reason === 'stuck' && this.detail) {
      this.failures.delete(this.detail);
      for (const key of [...this.writes.keys()]) {
        if (key.startsWith(`${this.detail}\u0000`)) this.writes.delete(key);
      }
    }
    const rerun = this.reason === 'command-interrupted';
    this.reason = undefined;
    if (this.deferred) {
      const reply = this.deferred;
      this.deferred = null;
      this.state = 'waiting-reply';
      this.onReply(reply);
      return;
    }
    if (!this.current) {
      // Paused while waiting for a reply (page error, lost connection): keep waiting.
      if (this.watch) this.note = 'after-sleep';
      this.set('waiting-reply', { kind: 'resumed', text: 'Resumed.' });
      return;
    }
    this.set('acting', { kind: 'resumed', text: rerun ? 'Running it again.' : 'Resumed.' });
    void this.advance();
  }

  /**
   * After the computer slept, the reply stopped growing: press the page's stop button, then
   * act on what came through and ask the chat to continue (`onInterrupted`). From a pause
   * that's the user's click, so Bridge may send the continuation on its own again.
   */
  stopAndContinue(): void {
    const paused = this.state === 'paused' && this.reason === 'stalled';
    if (!paused && this.state !== 'waiting-reply') return;
    if (paused) {
      const config = this.deps.config();
      if (!config || config.mode !== 'full-auto') return;
      this.continued = false;
    }
    if (!this.deps.page.stopReply()) {
      if (!paused) this.pause('stalled');
      return;
    }
    if (this.watch) this.watch.changedAt = this.deps.now();
    this.reason = undefined;
    this.note = undefined;
    this.set('waiting-reply', {
      kind: 'resumed',
      text: 'Stopped the stuck reply. Bridge acts on what came through and asks the chat to continue.'
    });
  }

  /** The page's own Continue generating, for a cut-off reply: it keeps the same reply. */
  continueReply(): void {
    if (this.state !== 'paused' || this.reason !== 'interrupted') return;
    if (this.deps.config()?.mode !== 'full-auto' || !this.deps.page.continueReply()) return;
    this.continued = true;
    this.current = null;
    this.reason = undefined;
    this.set('waiting-reply', { kind: 'resumed', text: 'Continuing the same reply.' });
  }

  /** Skip for a command sleep interrupted: the follow-up says it was skipped, and on we go. */
  skipRun(): void {
    const step = this.current;
    if (this.state !== 'paused' || this.reason !== 'command-interrupted' || !step) return;
    if (this.deps.config()?.mode !== 'full-auto') return;
    const run = step.actions.runs[step.runIndex];
    if (run) {
      step.runs.push({ command: run.command, skipped: true });
      step.runIndex += 1;
    }
    this.reason = undefined;
    this.set('acting', { kind: 'resumed', text: `Skipped ${run?.command ?? 'the command'}.` });
    void this.advance();
  }

  /** After the step limit: allow another `stepLimit` sends (or no limit), then carry on. */
  continueFor(): void {
    if (this.state !== 'paused' || this.reason !== 'step-limit') return;
    const more = this.deps.config()?.stepLimit;
    this.limit = more === null || this.limit === null ? null : this.limit + (more ?? 1);
    this.reason = undefined;
    this.set('acting', {
      kind: 'resumed',
      text:
        this.limit === null
          ? 'Continuing, with no step limit.'
          : `Continuing, up to ${this.limit} messages.`
    });
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
      // Waking, the reply may still be streaming: keep waiting, and pick up any reply once
      // the app is back (see `onReply`).
      if (this.state === 'waiting-reply' && this.watch && this.inWakeWindow()) return;
      if (this.active && this.state !== 'paused') this.pause('disconnected');
      return;
    }
    this.catchUp = config.catchUpAfterSleep;
    const restarted = this.instance !== null && config.instance !== this.instance;
    this.instance = config.instance;
    if (restarted && this.active) {
      // The app came back as a new launch, in Manual. The run waits for the user.
      this.interrupt('app-restarted');
      return;
    }
    // Paused because the app restarted: it stays paused until Full auto is back and Resume.
    if (this.state === 'paused' && this.reason === 'app-restarted') return;
    if (config.mode !== 'full-auto' && this.state !== 'idle') {
      this.generation += 1;
      this.current = null;
      this.reason = undefined;
      if (this.active) this.deps.cancelRun();
      this.clearCatchUp();
      this.set('idle', { kind: 'stopped', text: 'Full auto was turned off.' });
      return;
    }
    if (
      this.state === 'paused' &&
      this.reason === 'disconnected' &&
      this.resumeOnConnect &&
      config.mode === 'full-auto'
    ) {
      // Back after sleep, same launch, still Full auto: carry on without a Resume.
      this.resumeOnConnect = false;
      this.resume();
    }
  }

  /**
   * The computer woke from sleep. Catching up (the default), Full auto syncs with the chat:
   * it keeps waiting for a reply that's still streaming (and notices one that's stuck), acts
   * on one that finished, picks a half-done step up again once the app is back, and asks
   * about a command that was running. Otherwise a step that was half done waits for Resume.
   */
  onWake(): void {
    const config = this.deps.config();
    if (config) this.catchUp = config.catchUpAfterSleep;
    if (!this.catchUp) {
      if (this.state === 'acting' || this.state === 'sending') this.interrupt('slept');
      return;
    }
    const now = this.deps.now();
    this.wokeAt = now;
    if (this.state === 'acting' && this.running !== null) {
      this.detail = this.running;
      this.interrupt('command-interrupted');
      return;
    }
    const waiting =
      this.state === 'waiting-reply' ||
      (this.state === 'paused' && this.reason === 'disconnected' && !this.current);
    if (waiting) this.watch = { length: this.deps.page.replyLength(), changedAt: now, stops: 0 };
    if (this.state === 'paused' && this.reason === 'disconnected') {
      this.resumeOnConnect = true;
      if (config?.mode === 'full-auto') this.onConfig(config);
      return;
    }
    if (this.state === 'waiting-reply') {
      this.note = 'after-sleep';
      this.report({ kind: 'resumed', text: 'Woke from sleep. Waiting for the chat to finish.' });
    }
    // Acting or sending: the step carries on by itself. If the connection went, its pause
    // for that resumes once the app is back (see `pause`).
  }

  /** Pauses from outside the step, dropping whatever it was waiting on. */
  private interrupt(reason: PauseReason): void {
    this.generation += 1;
    this.deps.cancelRun();
    this.pause(reason);
  }

  private inWakeWindow(): boolean {
    return this.wokeAt !== null && this.deps.now() - this.wokeAt < WAKE_WINDOW_MS;
  }

  private clearCatchUp(): void {
    this.watch = null;
    this.note = undefined;
    this.deferred = null;
    this.resumeOnConnect = false;
  }

  /**
   * Called about once a second while waiting for a reply. After waking, a reply that shows
   * as streaming with no new text for `STALL_MS` is stuck. An error banner pauses the loop,
   * unless it's over a reply that was cut off: that reply comes to `onReply` as interrupted.
   */
  tick(): void {
    if (this.state !== 'waiting-reply') {
      this.errorSince = null;
      return;
    }
    const { page } = this.deps;
    const now = this.deps.now();
    const status = page.replyStatus();
    if (this.watch && status === 'streaming') {
      const length = page.replyLength();
      if (length !== this.watch.length) {
        this.watch.length = length;
        this.watch.changedAt = now;
      } else if (now - this.watch.changedAt >= STALL_MS) {
        this.onStall();
      }
      return;
    }
    if (!page.error()) {
      this.errorSince = null;
      return;
    }
    if (status === 'interrupted') {
      this.errorSince ??= now;
      if (now - this.errorSince < INTERRUPT_GRACE_MS) return;
    }
    this.errorSince = null;
    this.pause('page-error');
  }

  /** The reply stopped growing after sleep: Stop & continue on its own once, then pause. */
  private onStall(): void {
    const watch = this.watch;
    if (!watch) return;
    if (watch.stops > 0) {
      this.pause('stalled');
      return;
    }
    watch.stops += 1;
    this.emit({ kind: 'paused', text: 'The chat seems stuck after sleep.' });
    this.stopAndContinue();
  }

  private async advance(): Promise<void> {
    // Work from an older generation (before a Stop or a pause from outside) may still be
    // unwinding; it drops its results, so it doesn't block this one.
    const generation = this.generation;
    if (this.working === generation) return;
    this.working = generation;
    try {
      await this.work(generation);
    } finally {
      if (this.working === generation) this.working = null;
    }
  }

  /**
   * Runs the current step from its phase until it sends, pauses or ends. The files the
   * reply asked for are read before anything can pause the step, so they go out with the
   * follow-up whatever else needs the user.
   */
  private async work(generation: number): Promise<void> {
    const step = this.current;
    if (!step) return;
    const stale = () => generation !== this.generation || this.current !== step;
    const { actions } = step;

    if (step.phase === 'edits') {
      // Where the dev servers' logs are now: errors after this point are the edits' doing.
      if (step.cursor === null && actions.logCursor) {
        step.cursor = await actions.logCursor();
        if (stale()) return;
      }
      await actions.applyEdits(this.loopId);
      if (stale()) return;
      const { applied, held } = actions.edits();
      if (applied.length > 0) {
        step.editedAt = this.deps.now();
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
      if (!step.guarded) {
        step.guarded = true;
        const repeated = this.repeatedWrite(actions);
        if (repeated) {
          this.detail = repeated;
          this.pause('stuck');
          return;
        }
      }
    }

    if (step.phase === 'reads') {
      if (actions.reads.length > 0) {
        const read = await actions.readFiles();
        if (stale()) return;
        if (read.disconnected) {
          this.pause('disconnected');
          return;
        }
        step.files = read.files;
        step.images = read.images ?? [];
        step.refused = read.refused;
      }
      // A format reminder only answers the reads; the rest waits for the redone reply.
      step.phase = step.reminder ? 'build' : 'review';
    }

    if (step.phase === 'review') {
      // What needs the user, once each. Resume carries on from here.
      const held = actions.edits().held[0];
      if (held && !step.editsReviewed) {
        step.editsReviewed = true;
        this.pause(HOLD_REASON[held.hold]);
        return;
      }
      if (!step.changesReviewed) {
        step.changesReviewed = true;
        // Deletes and renames wait for a click unless "Also approve automatically" applied them.
        if (actions.changes().pending.length > 0) {
          this.pause('needs-click');
          return;
        }
      }
      if (!step.downloadsReviewed) {
        step.downloadsReviewed = true;
        // Downloads always wait for a click, whatever the settings.
        if ((actions.downloads?.().pending.length ?? 0) > 0) {
          this.pause('download');
          return;
        }
      }
      const starts = (actions.processes ?? []).filter((p) => p.kind === 'start');
      if (
        !step.disallowedReviewed &&
        [...actions.runs, ...starts].some((action) => action.refusal() !== null)
      ) {
        step.disallowedReviewed = true;
        this.pause('not-allowed');
        return;
      }
      step.phase = 'processes';
    }

    if (step.phase === 'processes') {
      const processes = actions.processes ?? [];
      while (step.processIndex < processes.length) {
        const process = processes[step.processIndex]!;
        const refusal = process.refusal();
        if (refusal !== null) {
          step.processes.push({ command: process.command, refused: refusal });
          step.processIndex += 1;
          continue;
        }
        this.running = process.command;
        let outcome: FollowUpProcess | { disconnected: true };
        try {
          outcome = await process.act(this.loopId);
        } finally {
          if (this.running === process.command) this.running = null;
        }
        if (stale()) return;
        if ('disconnected' in outcome) {
          this.pause('disconnected');
          return;
        }
        step.processes.push(outcome);
        step.processIndex += 1;
        this.emit({
          kind: 'ran',
          text:
            'started' in outcome
              ? `${outcome.restarted ? 'Restarted' : 'Started'} ${process.command}${outcome.url ? ` at ${outcome.url}` : ''}.`
              : 'stopped' in outcome
                ? `${outcome.stopped ? 'Stopped' : 'Not running:'} ${process.command}.`
                : 'exited' in outcome
                  ? `${process.command} ${outcome.exited}.`
                  : `Didn’t start ${process.command}.`
        });
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
        // Running it again after sleep: wait for the interrupted run to finish cancelling.
        const until = this.deps.now() + RERUN_WAIT_MS;
        while (run.busy?.() && this.deps.now() < until) {
          await this.deps.sleep(SEND_POLL_MS);
          if (stale()) return;
        }
        this.running = run.command;
        let outcome: RunOutcome;
        try {
          outcome = await run.run(this.loopId);
        } finally {
          if (this.running === run.command) this.running = null;
        }
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
        if (this.repeatedFailure(run.command, outcome.result, passed)) {
          this.detail = run.command;
          this.pause('stuck');
          return;
        }
        if (!passed && this.deps.config()?.pauseOnFailure) {
          this.pause('failure');
          return;
        }
      }
      step.phase = 'logs';
    }

    if (step.phase === 'logs') {
      step.logs = [];
      for (const logs of actions.logs ?? []) {
        const read = await logs.read();
        if (stale()) return;
        if ('disconnected' in read) {
          this.pause('disconnected');
          return;
        }
        if ('refused' in read) step.processes.push({ command: logs.command, stopped: false });
        else step.logs.push(read);
      }
      // Errors the dev servers printed after the edits, once they've had a moment to rebuild.
      if (
        step.cursor &&
        step.cursor.length > 0 &&
        step.editedAt !== null &&
        actions.processErrors
      ) {
        const wait = step.editedAt + PROCESS_SETTLE_MS - this.deps.now();
        if (wait > 0) {
          await this.deps.sleep(wait);
          if (stale()) return;
        }
        step.errors = await actions.processErrors(step.cursor);
        if (stale()) return;
        if (step.errors.length > 0) {
          this.emit({
            kind: 'ran',
            text: `Errors from ${step.errors.map((e) => e.command).join(', ')} go with the next message.`
          });
        }
      }
      step.phase = 'build';
    }

    if (
      step.phase === 'build' &&
      step.reminder &&
      step.files.length + step.images.length + step.refused.length === 0
    ) {
      step.message = FORMAT_REMINDER;
      step.phase = 'send';
    }

    if (step.phase === 'build') {
      const { applied, held } = step.reminder ? { applied: [], held: [] } : actions.edits();
      const changes = step.reminder ? { applied: [], pending: [] } : actions.changes();
      const downloads = step.reminder ? null : actions.downloads?.();
      const built = buildFollowUp({
        ...(step.reminder && { reminder: FORMAT_REMINDER }),
        applied: [...applied, ...changes.applied, ...(downloads?.applied ?? [])],
        skipped: [
          ...held.map(({ path, reason }) => ({ path, reason })),
          ...changes.pending.map((path) => ({ path, reason: 'not confirmed' })),
          ...(downloads?.pending ?? []).map((path) => ({ path, reason: 'not downloaded' }))
        ],
        files: step.files,
        refused: step.refused,
        runs: step.runs,
        processes: step.processes,
        logs: step.logs,
        errors: step.errors,
        attached: step.images.map((image) => image.path),
        ...(step.continuation && { continuation: step.continuation })
      });
      if (!built) {
        this.pause('too-big');
        return;
      }
      step.message = built.text;
      step.redacted = built.redacted;
      step.phase = 'send';
    }

    if (step.phase === 'send') await this.send(step, stale);
  }

  /**
   * The loop guard for edits: a file written with the same content in
   * `LOOP_GUARD_REPEATS` replies of one run means the chat is going round in circles.
   * Returns that file, or null.
   */
  private repeatedWrite(actions: ReplyActions): string | null {
    let repeated: string | null = null;
    for (const { path, hash } of actions.fingerprints ?? []) {
      const key = `${path}\u0000${hash}`;
      const count = (this.writes.get(key) ?? 0) + 1;
      this.writes.set(key, count);
      if (count >= LOOP_GUARD_REPEATS) repeated ??= path;
    }
    return repeated;
  }

  /**
   * The loop guard for commands: the same command failing the same way (`failureSignature`)
   * `LOOP_GUARD_REPEATS` times in a row. A pass, or a different failure, starts it over.
   */
  private repeatedFailure(command: string, result: RunResult, passed: boolean): boolean {
    if (passed) {
      this.failures.delete(command);
      return false;
    }
    const exit = result.status === 'exited' ? `exit ${result.exitCode}` : result.status;
    const signature = failureSignature(exit, result.output);
    const last = this.failures.get(command);
    const count = last?.signature === signature ? last.count + 1 : 1;
    this.failures.set(command, { signature, count });
    return count >= LOOP_GUARD_REPEATS;
  }

  private async send(step: Step, stale: () => boolean): Promise<void> {
    const { page } = this.deps;
    if (step.sentFrom === null) {
      if (this.limit !== null && this.step >= this.limit) {
        this.pause('step-limit');
        return;
      }
      // A cut-off reply's own error banner is why this step asks the chat to continue.
      if (page.error() && !step.continuation) {
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
        if (step.images.length > 0 && !page.attach(step.images)) {
          this.pause('send-failed');
          return;
        }
      }
      step.sentFrom = before;
      if (!(await this.pressSend(stale, step.images.length > 0))) {
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
      if (!(await this.pressSend(stale, step.images.length > 0))) {
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
    if (step.reminder) step.actions.markReminded();
    // A reminder carries the files the reply asked for too, when it asked for any.
    if (!step.reminder || step.files.length + step.images.length + step.refused.length > 0) {
      step.actions.markReadsSent();
    }
    this.current = null;
    this.reason = undefined;
    this.note = undefined;
    const sent = `Sent message ${this.step}${this.limit === null ? '' : ` of ${this.limit}`}`;
    this.set('waiting-reply', {
      kind: 'sent',
      // Redactions don't stop the send; the log says how many.
      text: step.reminder
        ? `${sent}: a format reminder (${this.reminders} of ${MAX_FORMAT_REMINDERS}).`
        : step.redacted > 0
          ? `${sent}, with ${step.redacted} likely ${step.redacted === 1 ? 'secret' : 'secrets'} redacted.`
          : `${sent}.`
    });
  }

  /**
   * Clicks send, waiting for the button: the page shows (or enables) it only once it has
   * rendered the text just inserted (and uploaded any images), so it may not be there yet.
   */
  private async pressSend(stale: () => boolean, attached = false): Promise<boolean> {
    const deadline = this.deps.now() + (attached ? ATTACH_SEND_WAIT_MS : SEND_BUTTON_WAIT_MS);
    while (!this.deps.page.submit()) {
      if (stale() || this.deps.now() >= deadline) return false;
      await this.deps.sleep(SEND_POLL_MS);
    }
    return true;
  }

  private pause(reason: PauseReason): void {
    this.reason = reason;
    this.note = undefined;
    // Lost while catching up after sleep: the sleep's doing, so it resumes on reconnect.
    if (reason === 'disconnected' && this.catchUp && this.inWakeWindow()) {
      this.resumeOnConnect = true;
    }
    if (reason !== 'interrupted' && reason !== 'command-interrupted' && reason !== 'stuck') {
      this.detail = undefined;
    }
    if (reason !== 'interrupted') this.pageContinue = false;
    this.set('paused', { kind: 'paused', text: pauseReasonText(reason, this.detail) });
  }

  private finish(text: string): void {
    this.generation += 1;
    this.current = null;
    this.reason = undefined;
    this.clearCatchUp();
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
      limit: this.limit === null ? null : Math.max(1, this.limit),
      ...(this.state === 'paused' && this.reason && { reason: this.reason }),
      ...(this.state === 'paused' && this.detail && { detail: this.detail.slice(0, 300) }),
      ...(this.state === 'paused' &&
        this.reason === 'interrupted' && { pageContinue: this.pageContinue }),
      ...(this.note && { note: this.note }),
      ...(event && { event: { ...event, text: event.text.slice(0, 300) } })
    });
  }
}
