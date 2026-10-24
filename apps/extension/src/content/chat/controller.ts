import {
  errorLines,
  formatArgv,
  interruptionOf,
  parseChat,
  type BackgroundLogs,
  type BridgeConfig,
  type ChatParse,
  type Interruption,
  type ProcessLines,
  type RunResult
} from '@bridge/shared';
import type {
  BinaryCardRecord,
  CardRecord,
  ChatSyncReply,
  DiffCardRecord,
  LoopAction,
  PendingRequest,
  ReadCardRecord,
  SessionState,
  RequestOutcome,
  TabLocation,
  WorkerRequest
} from '../../messages';
import { messageToText } from './adapter';
import { AssetCard } from './cards/asset-card';
import { ChangeCard, type FileChange } from './cards/change-card';
import { DiffCard, type Ask } from './cards/diff-card';
import { DownloadCard } from './cards/download-card';
import { FormatCard } from './cards/format-card';
import { loadFonts } from './cards/host';
import { InterruptCard } from './cards/interrupt-card';
import { LoopChip } from './cards/loop-chip';
import { MessageBar } from './cards/message-bar';
import { PageNotice } from './cards/page-notice';
import { ProcessCard, type ProcessKind } from './cards/process-card';
import { ReadCard } from './cards/read-card';
import { RunCard } from './cards/run-card';
import { blockKey, contentHash } from './keys';
import {
  FullAutoLoop,
  type ChangeSummary,
  type EditHold,
  type EditSummary,
  type LogCursor,
  type ReplyActions
} from './loop';
import { livePage, newestReply } from './page';
import {
  all,
  assistantMessages,
  checkLayout,
  closest,
  composerArea,
  first,
  SELECTORS,
  conversationIdFrom,
  conversationMissing,
  findContinueButton,
  findConversation,
  generatedImages,
  isMessageComplete,
  messageBody,
  messageIdOf,
  replyStatus,
  type LayoutHealth
} from './selectors';

/** Mutations settle for this long before a scan. */
export const SCAN_DEBOUNCE_MS = 250;
/** How often the URL and layout are checked (client-side navigation fires no event here). */
const POLL_MS = 1_000;
/** A layout must look wrong this many polls in a row before the side panel hears of it. */
const LAYOUT_STRIKES = 5;
/** Run events that arrive before their card knows its run id are kept this long. */
const MAX_EARLY_EVENTS = 200;
/**
 * A poll this late means the computer slept. Background tabs' timers can be held back to
 * once a minute, so anything shorter could just be throttling.
 */
export const WAKE_GAP_MS = 150_000;
/** The page must say "not found" this many polls in a row before the session ends. */
const MISSING_STRIKES = 3;

/** One assistant message's cards. */
interface MessageView {
  /** The message's id on the page. */
  id: string;
  element: Element;
  text: string;
  parse: ChatParse;
  cards: DiffCard[];
  /** For each card, the index of its code block among the message's `<pre>`s. */
  fences: number[];
  read: ReadCard | null;
  runs: RunCard[];
  /** DELETE then RENAME cards, in the reply's order. */
  changes: ChangeCard[];
  /** START, STOP and LOGS cards, in the reply's order. */
  processes: ProcessCard[];
  /** DOWNLOAD cards. Always a click. */
  downloads: DownloadCard[];
  /** Save to project, one under each image the chat made in this reply. */
  assets: AssetCard[];
  /** How many images the chat made in this reply, when the cards were built. */
  images: number;
  bar: MessageBar | null;
  /** What in the reply missed Bridge's format, with **Send format reminder**. */
  format: FormatCard | null;
  /** The reply was cut off: where, and the card that offers a way on. */
  interruption: Interruption | null;
  interrupt: InterruptCard | null;
  /** The card of the file the cut fell in. Never applied on its own; not in Full auto's step. */
  cutOff: DiffCard | null;
  /** Every card has read what it needs. */
  ready: Promise<unknown>;
}

type RunEvent = { type: 'output'; chunk: string } | { type: 'exit'; result: RunResult };

/**
 * Applies a reply's edits by the Auto-apply rules: in order, leaving partial, conflicting,
 * blocked, gated and oversized files on their cards for a click (a partial one is applied
 * when Full auto's "Also approve automatically" allows it). A path the reply edits more
 * than once gets only its last version. Deletes and renames are never in here.
 */
export async function autoApply(
  cards: readonly DiffCard[],
  loopId?: string,
  options: { approvePartial?: boolean } = {}
): Promise<void> {
  for (const card of cards) {
    await card.ready();
    if (card.state !== 'pending' || !card.applicable || card.duplicate === 'earlier') continue;
    await card.apply({
      trigger: 'auto',
      ...(loopId && { loopId }),
      ...(options.approvePartial && { approvePartial: true })
    });
  }
}

/** Saves the images a reply named with `@@ASSET`, for Auto-apply and Full auto. */
export async function autoSave(cards: readonly AssetCard[], loopId?: string): Promise<void> {
  for (const card of cards) {
    if (card.automatic) await card.save({ trigger: 'auto', ...(loopId && { loopId }) });
  }
}

/** Marks edits to the same path in one reply: every one but the last is `earlier`. */
export function markDuplicates(cards: readonly DiffCard[]): void {
  const last = new Map<string, DiffCard>();
  const count = new Map<string, number>();
  for (const card of cards) {
    last.set(card.edit.path, card);
    count.set(card.edit.path, (count.get(card.edit.path) ?? 0) + 1);
  }
  for (const card of cards) {
    const repeated = (count.get(card.edit.path) ?? 0) > 1;
    card.setDuplicate(!repeated ? null : last.get(card.edit.path) === card ? 'later' : 'earlier');
  }
}

/** Where a reply's deletes and renames stand. */
export function changeSummary(cards: readonly ChangeCard[]): ChangeSummary {
  return {
    applied: cards.filter((c) => c.state === 'applied').map((c) => c.summary),
    pending: cards.filter((c) => c.state === 'pending').map((c) => c.summary)
  };
}

/** Where a reply's edits stand: applied, or left on their card and why. Images too. */
export function editSummary(
  cards: readonly DiffCard[],
  assets: readonly AssetCard[] = []
): EditSummary {
  const applied: string[] = [];
  const held: EditSummary['held'] = [];
  for (const asset of assets) {
    if (asset.state === 'applied') applied.push(asset.summary);
    else if (asset.state === 'pending' && asset.suggested !== null && asset.path.trim()) {
      held.push({ path: asset.summary, hold: 'blocked', reason: 'not saved' });
    }
  }
  for (const card of cards) {
    if (card.state === 'applied') applied.push(card.edit.path);
    else if (card.state === 'rejected') {
      held.push({ path: card.edit.path, hold: 'blocked', reason: 'rejected' });
    } else if (card.state === 'pending' && (card.applicable || card.hold || card.autoHold())) {
      const hold: EditHold = card.hold ?? card.autoHold() ?? 'blocked';
      held.push({ path: card.edit.path, hold, reason: card.holdText });
    }
  }
  return { applied, held };
}

/**
 * Watches the conversation and puts a card under each `@@FILE` block, a READ card and a
 * RUN card per command at the end of each finished assistant message, while this
 * conversation has an active session. Cards are re-inserted when the page's re-renders
 * drop them, and rebuilt when a message's text changes (regenerate, edit).
 *
 * Replies already on the page when it loads are never acted on. A new reply is, by the
 * app's mode: Auto-apply applies its edits; Full auto hands it to the loop.
 */
export class ChatController {
  private conversationId: string | null = null;
  private session: SessionState | null = null;
  private config: BridgeConfig | null = null;
  private layout: LayoutHealth = 'ok';
  private layoutStrikes = 0;
  private readonly views = new Map<string, MessageView>();
  /** Messages on the page when this conversation was first scanned. Never acted on. */
  private history: Set<string> | null = null;
  private observer: MutationObserver | null = null;
  private observed: Element | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning = false;
  private rescan = false;
  private firstSync = true;
  private readonly runCards = new Map<string, RunCard>();
  private readonly earlyEvents = new Map<string, RunEvent[]>();
  private readonly loop: FullAutoLoop;
  private readonly chip: LoopChip;
  private readonly notice = new PageNotice();
  /** Replies already handed to the mode once. A remounted one is never acted on again. */
  private readonly acted = new Set<string>();
  /** Replies Bridge stopped because they were stuck after sleep: they count as cut off. */
  private readonly stopped = new Set<string>();
  private lastPoll = Date.now();
  /** Replies that finished while the app was out of reach: acted on once it's back. */
  private readonly unacted = new Set<MessageView>();
  /**
   * `@@ASSET` paths from the last reply that had no image of its own: the chat often makes
   * the image in the reply after the one that names it.
   */
  private orphanAssets: { conversationId: string; paths: string[] } | null = null;
  private missingStrikes = 0;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** The extension was reloaded or updated under this page: everything here is dead. */
  private invalid = false;
  private lastRequests = '';

  constructor(private readonly ask: Ask) {
    this.chip = new LoopChip(
      () => this.loop.stop(),
      (corner) => void this.ask({ type: 'chip-corner', corner }),
      () => composerArea()
    );
    this.loop = new FullAutoLoop({
      page: { ...livePage, stopReply: () => this.stopReply() },
      config: () => this.config,
      report: (report) => {
        void this.ask({ type: 'chat-loop', report });
        this.renderChip();
      },
      cancelRun: () => {
        for (const card of this.runCards.values()) if (card.running) void card.cancel();
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      newId: () => crypto.randomUUID()
    });
  }

  start(): void {
    this.conversationId = conversationIdFrom(location.href);
    void this.sync();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    // Client-side navigation. This isolated world can't wrap the page's own pushState, but
    // the Navigation API reports it (and replaceState) at once, popstate covers Back and
    // Forward, the poll is the fallback, and the worker asks (`locate`) before inserting.
    const follow = () => {
      if (!this.invalid) this.followUrl();
    };
    const navigation = (window as { navigation?: EventTarget }).navigation;
    navigation?.addEventListener('currententrychange', follow);
    window.addEventListener('popstate', follow);
    this.attach();
  }

  /** The service worker says the session for this tab started, ended or moved. */
  setSession(session: SessionState | null): void {
    if (this.invalid) return;
    this.session = session;
    for (const view of this.views.values()) this.setViewDisabled(view, session !== 'active');
    if (session !== 'active' && this.loop.active) this.loop.stop();
    this.notice.render(
      session === 'elsewhere'
        ? {
            text: 'This chat’s Bridge session is active in another tab.',
            action: { label: 'Move here', onClick: () => void this.moveHere() }
          }
        : null
    );
    this.renderChip();
    this.reportRequests();
    this.schedule();
  }

  private async moveHere(): Promise<void> {
    const state = await this.ask<SessionState | null>({ type: 'chat-move-here' });
    if (state !== undefined) this.setSession(state);
  }

  /**
   * The extension was reloaded or updated, so this script can't reach it any more ("Extension
   * context invalidated"). Takes every card and the chip off the page and leaves a one-line
   * notice: only a page reload brings Bridge back here.
   */
  invalidate(): void {
    if (this.invalid) return;
    this.invalid = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.timer);
    this.observer?.disconnect();
    this.loop.stop();
    this.clear();
    this.chip.render(null);
    this.chip.host.remove();
    this.notice.render({
      text: 'Bridge was updated or reloaded. Reload the page to use it here.',
      tone: 'warning',
      action: { label: 'Reload', onClick: () => location.reload() }
    });
  }

  /** Files changed on disk: pending cards on them check again. */
  filesChanged(paths: readonly string[], overflow: boolean): void {
    const changed = new Set(paths);
    const hit = (path: string) => overflow || changed.has(path);
    for (const view of this.views.values()) {
      for (const card of view.cards) if (hit(card.edit.path)) void card.refresh();
      for (const card of view.changes) if (card.paths.some(hit)) void card.refresh();
    }
  }

  /** "Show" in the side panel: scroll a pending READ, RUN, START or DOWNLOAD card into view. */
  reveal(id: string): void {
    for (const view of this.views.values()) {
      if (view.read?.key === id) view.read.reveal();
      view.runs.forEach((run, i) => {
        if (runRequestId(view, i) === id) run.reveal();
      });
      view.processes.forEach((card, i) => {
        if (`start:${view.id}:${i}` === id) card.reveal();
      });
      for (const card of view.downloads) if (card.key === id) card.reveal();
    }
  }

  /** The app's mode and allowlist changed, or the connection came or went (null). */
  setConfig(config: BridgeConfig | null): void {
    if (this.invalid) return;
    this.config = config;
    for (const view of this.views.values()) {
      for (const card of view.cards) card.setMode(config?.mode ?? null);
      for (const card of view.changes) card.setMode(config?.mode ?? null);
      for (const run of view.runs) run.setConfig(config);
      for (const card of view.processes) card.setConfig(config);
      for (const card of view.downloads) card.setMode(config?.mode ?? null);
      for (const card of view.assets) card.setMode(config?.mode ?? null);
    }
    this.loop.onConfig(config);
    this.renderChip();
    this.reportRequests();
    // Replies that finished while the app was away get their turn now.
    if (config) {
      for (const view of [...this.unacted]) {
        this.unacted.delete(view);
        if (this.views.get(view.id) === view) void this.act(view);
      }
    }
  }

  /** Output or the exit of a command a RUN card here started. */
  runEvent(runId: string, event: RunEvent): void {
    const card = this.runCards.get(runId);
    if (!card) {
      // The event beat the reply with the run id. Hold it for the card.
      const queue = this.earlyEvents.get(runId) ?? [];
      queue.push(event);
      this.earlyEvents.set(runId, queue);
      if (this.earlyEvents.size > MAX_EARLY_EVENTS) {
        this.earlyEvents.delete(this.earlyEvents.keys().next().value!);
      }
      return;
    }
    this.deliver(card, runId, event);
  }

  /**
   * What this script sees on the page, for fixing selectors when chatgpt.com changes. Tag
   * names, test ids, labels and counts only: no message text beyond the last reply's
   * Bridge markers.
   */
  diagnose(): Record<string, unknown> {
    const messages = this.observed ? assistantMessages(this.observed) : [];
    const last = messages.at(-1) ?? null;
    const describe = (el: Element) =>
      el.tagName.toLowerCase() +
      (el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : '') +
      (el.id ? `#${el.id}` : '');
    const ancestors: string[] = [];
    for (
      let el = last;
      el && el !== document.body && ancestors.length < 12;
      el = el.parentElement
    ) {
      ancestors.push(describe(el));
    }
    const turn = last ? closest(last, SELECTORS.turn) : null;
    const lastText = last ? messageToText(last).text : '';
    const parsed = parseChat(lastText);
    const match = (selectors: readonly string[]) =>
      selectors.map((s) => `${s} → ${document.querySelectorAll(s).length}`);
    return {
      url: location.pathname,
      conversationId: this.conversationId,
      session: this.session,
      mode: this.config?.mode ?? null,
      layout: this.layout,
      conversationFound: this.observed !== null,
      assistantMessages: messages.length,
      views: this.views.size,
      history: this.history?.size ?? null,
      last: last && {
        id: messageIdOf(last, messages.length - 1),
        complete: isMessageComplete(last),
        ancestors,
        turn: turn ? describe(turn) : null,
        turnButtons: turn
          ? [...turn.querySelectorAll('button')]
              .slice(0, 15)
              .map(
                (b) =>
                  `${b.getAttribute('data-testid') ?? ''}|${b.getAttribute('aria-label') ?? ''}`
              )
          : [],
        markers: lastText
          .split('\n')
          .filter((line) => line.includes('@@'))
          .slice(0, 10),
        body: describe(messageBody(last)),
        codeBlocks: [...last.querySelectorAll('pre, code')]
          .filter((el) => el.tagName === 'PRE' || (el.textContent ?? '').includes('\n'))
          .slice(0, 5)
          .map((el) => {
            const chain: string[] = [];
            for (
              let p: Element | null = el;
              p && p !== last && chain.length < 6;
              p = p.parentElement
            ) {
              chain.push(shapeOf(p));
            }
            return { lines: (el.textContent ?? '').split('\n').length, chain };
          }),
        parsed: {
          edits: parsed.edits.map((e) => e.path),
          reads: parsed.reads,
          runs: parsed.runs,
          starts: parsed.starts,
          stops: parsed.stops,
          logs: parsed.logs,
          assets: parsed.assets,
          downloads: parsed.downloads.map((d) => d.path),
          images: last ? generatedImages(last).length : 0,
          done: parsed.done,
          issues: parsed.issues.map((issue) => issue.kind)
        }
      },
      selectors: {
        turn: match(SELECTORS.turn),
        turnActions: match(SELECTORS.turnActions),
        streaming: match(SELECTORS.streaming),
        stopButton: match(SELECTORS.stopButton),
        composer: match(SELECTORS.composer),
        sendButton: match(SELECTORS.sendButton),
        userMessage: match(SELECTORS.userMessage)
      },
      anyTurnActions: first(document, SELECTORS.turnActions) !== null,
      bridgeHosts: all(document, [`[data-bridge-host]`]).length,
      ...pageShape()
    };
  }

  /** Stop, Resume, Continue and the sleep catch-up buttons, from the side panel or the app. */
  loopControl(action: LoopAction): void {
    switch (action) {
      case 'stop':
        return this.loop.stop();
      case 'resume':
        return this.loop.resume();
      case 'continue':
        return this.loop.continueFor();
      case 'skip':
        return this.loop.skipRun();
      case 'stop-continue':
        return this.loop.stopAndContinue();
      case 'continue-reply':
        return this.loop.continueReply();
    }
  }

  /** Presses the page's stop button for the newest reply, which then counts as cut off. */
  private stopReply(): boolean {
    const messages = this.observed ? assistantMessages(this.observed) : [];
    const newest = newestReply();
    if (!livePage.stopReply()) return false;
    if (newest) this.stopped.add(messageIdOf(newest, messages.length - 1));
    return true;
  }

  private deliver(card: RunCard, runId: string, event: RunEvent): void {
    if (event.type === 'output') card.onOutput(event.chunk);
    else {
      card.onExit(event.result);
      this.runCards.delete(runId);
    }
  }

  private registerRun(runId: string, card: RunCard): void {
    this.runCards.set(runId, card);
    const queued = this.earlyEvents.get(runId) ?? [];
    this.earlyEvents.delete(runId);
    for (const event of queued) this.deliver(card, runId, event);
  }

  private renderChip(): void {
    const mode = this.config?.mode;
    const { state, step, limit, reason, note } = this.loop;
    const fullAuto = mode === 'full-auto' || state !== 'idle';
    if (this.invalid || !mode || (this.session !== 'active' && state === 'idle')) {
      this.chip.render(null);
      return;
    }
    this.chip.render({
      mode,
      loop: fullAuto
        ? {
            state,
            step,
            limit:
              limit === null || this.config?.stepLimit === null
                ? null
                : Math.max(limit, this.config?.stepLimit ?? 1),
            ...(reason && { reason }),
            ...(note && { note })
          }
        : null
    });
  }

  /** Tells the side panel which READ and RUN cards still wait for a click here. */
  private reportRequests(): void {
    if (this.invalid) return;
    const requests: PendingRequest[] = [];
    if (this.session === 'active') {
      for (const view of this.views.values()) {
        if (view.read && !view.read.sent) {
          requests.push({
            id: view.read.key,
            kind: 'read',
            text: view.read.paths.join(', ').slice(0, 2_000),
            allowed: view.read.sendable
          });
        }
        view.runs.forEach((run, i) => {
          if (!run.waiting) return;
          requests.push({
            id: runRequestId(view, i),
            kind: 'run',
            text: run.command.slice(0, 2_000),
            allowed: run.refusal() === null
          });
        });
        view.processes.forEach((card, i) => {
          if (!card.waiting) return;
          requests.push({
            id: `start:${view.id}:${i}`,
            kind: 'start',
            text: card.command.slice(0, 2_000),
            allowed: card.refusal() === null
          });
        });
        for (const card of view.downloads) {
          if (!card.waiting) continue;
          requests.push({
            id: card.key,
            kind: 'download',
            text: `${card.download.url} → ${card.path}`.slice(0, 2_000),
            allowed: true
          });
        }
      }
    }
    const json = JSON.stringify(requests.slice(-100));
    if (json === this.lastRequests) return;
    this.lastRequests = json;
    void this.ask({ type: 'chat-requests', requests: requests.slice(-100) });
  }

  private async sync(wake = false): Promise<void> {
    const start = this.firstSync;
    this.firstSync = false;
    const reply = await this.ask<ChatSyncReply>({
      type: 'chat-sync',
      conversationId: this.conversationId,
      layout: this.layout,
      ...(start && { start: true }),
      ...(wake && { wake: true })
    });
    if (!reply) console.info('[Bridge] The extension didn’t answer. Reload this tab.');
    if (reply?.chipCorner) this.chip.setCorner(reply.chipCorner);
    this.setConfig(reply?.config ?? null);
    this.setSession(reply?.session ?? null);
  }

  private poll(): void {
    if (this.invalid) return;
    // After the extension reloads, this script lives on with a dead runtime.
    if (!chrome.runtime?.id) {
      this.invalidate();
      return;
    }
    const now = Date.now();
    const slept = now - this.lastPoll > WAKE_GAP_MS;
    this.lastPoll = now;
    if (slept) {
      // Timers stopped: the computer slept. Reconnect now, let the loop catch up (or pause,
      // with catching up off) and look at the conversation again.
      this.loop.onWake();
      void this.sync(true).then(() => this.schedule());
    }

    // A deleted conversation, or a 404: its session ends.
    if (this.conversationId && this.session === 'active' && conversationMissing()) {
      this.missingStrikes += 1;
      if (this.missingStrikes === MISSING_STRIKES) {
        void this.ask<SessionState | null>({ type: 'chat-gone' }).then((state) => {
          if (state !== undefined) this.setSession(state);
        });
      }
    } else this.missingStrikes = 0;

    this.followUrl();
    this.loop.tick();
    // Banners over the composer come and go; the chip stays clear of them.
    this.chip.place();

    const health = checkLayout();
    this.layoutStrikes = health === 'ok' ? 0 : this.layoutStrikes + 1;
    const next: LayoutHealth = this.layoutStrikes >= LAYOUT_STRIKES ? 'unknown' : 'ok';
    if (next !== this.layout) {
      this.layout = next;
      void this.sync();
    }

    // The page swaps out <main> on some navigations.
    if (!this.observed?.isConnected) this.attach();
  }

  /**
   * Another conversation (or a new chat) since the last look: drop this one's cards and
   * tell the worker, which ends the session this tab had in the one it left.
   */
  private followUrl(): void {
    const id = conversationIdFrom(location.href);
    if (id === this.conversationId) return;
    this.loop.onNavigate(id);
    this.conversationId = id;
    this.history = null;
    this.clear();
    void this.sync();
  }

  /** The worker asks where this tab is right now (before Start session). */
  locate(): TabLocation {
    if (!this.invalid) this.followUrl();
    return { conversationId: this.conversationId, layout: this.layout };
  }

  private attach(): void {
    this.observer?.disconnect();
    this.observed = findConversation();
    if (!this.observed) return;
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(this.observed, { childList: true, subtree: true, characterData: true });
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scan(), SCAN_DEBOUNCE_MS);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return;
    }
    this.scanning = true;
    try {
      await this.scanOnce();
    } finally {
      this.scanning = false;
      if (this.rescan) {
        this.rescan = false;
        this.schedule();
      }
    }
  }

  private async scanOnce(): Promise<void> {
    const conversationId = this.conversationId;
    if (!conversationId || !this.observed) return;
    const messages = assistantMessages(this.observed);
    // What's on the page the first time we look is history: shown, never acted on.
    this.history ??= new Set(messages.map((element, index) => messageIdOf(element, index)));
    for (const [index, element] of messages.entries()) {
      // A session that isn't active parses nothing new. Cards already shown stay put.
      if (this.session !== 'active' && !this.views.has(messageIdOf(element, index))) continue;
      const status = replyStatus(element, document, index === messages.length - 1);
      if (status === 'streaming') continue;
      const id = messageIdOf(element, index);
      const interrupted = status === 'interrupted' || this.stopped.has(id);
      const { text, codeBlocks } = messageToText(element);
      const images = generatedImages(element);
      const existing = this.views.get(id);
      // Same text: the same cards, even in a new element. Long conversations unmount old
      // messages and mount them again as they scroll back in; the cards move with them. An
      // image that finished generating since counts as a change.
      if (
        existing &&
        existing.text === text &&
        existing.images === images.length &&
        (existing.interruption !== null) === interrupted
      ) {
        this.mount(existing, element, codeBlocks);
        continue;
      }
      if (this.session !== 'active') continue;
      // New, or its text changed (regenerated or edited): rebuild its cards. Cards come
      // back from their stored state, so a rebuilt view shows what was applied.
      if (existing) this.remove(existing);
      const view = await this.build(conversationId, id, element, text, interrupted, images);
      if (this.conversationId !== conversationId || this.invalid) return;
      if (existing) this.unacted.delete(existing);
      this.views.set(id, view);
      this.mount(view, element, codeBlocks);
      // Only a reply that wasn't on the page when it loaded is acted on, and only once.
      const actedKey = `${id}:${text.length}:${images.length}${interrupted ? ':cut' : ''}`;
      if (!this.history.has(id) && !this.acted.has(actedKey)) {
        this.acted.add(actedKey);
        void this.act(view);
      }
    }
    this.reportRequests();
  }

  /**
   * What the app's mode does with a new reply. One that finishes while the app is out of
   * reach (a reconnect, after sleep) waits for it to be back instead of being dropped:
   * without the mode Bridge can't tell Full auto from Manual, and dropping it left the
   * files the reply asked for waiting on a click.
   */
  private async act(view: MessageView): Promise<void> {
    if (this.session !== 'active') return;
    await view.ready;
    if (this.views.get(view.id) !== view) return;
    if (!this.config) {
      this.unacted.add(view);
      return;
    }
    switch (this.config.mode) {
      case 'auto-apply':
        await autoApply(view.cards);
        await autoSave(view.assets);
        break;
      case 'full-auto':
        this.loop.onReply(this.actionsOf(view));
        break;
      default:
        break;
    }
  }

  /** The newest view for a message: a rebuilt one replaces the one a step started with. */
  private latest(view: MessageView): MessageView {
    return this.views.get(view.id) ?? view;
  }

  /** Where each running background process's log is now. */
  private async logCursor(): Promise<LogCursor> {
    const running = (this.config?.processes ?? []).filter((p) => p.state === 'running');
    const cursor: { command: string; next: number }[] = [];
    for (const proc of running) {
      const argv = this.argvOf(proc.command);
      if (!argv) continue;
      const logs = await this.ask<RequestOutcome<BackgroundLogs>>({
        type: 'chat-bg-logs',
        argv,
        tail: 0
      });
      if (logs?.ok) cursor.push({ command: proc.command, next: logs.result.next });
    }
    return cursor;
  }

  /** Error lines each process printed since `cursor`. */
  private async processErrors(cursor: LogCursor): Promise<ProcessLines[]> {
    const found: ProcessLines[] = [];
    for (const { command, next } of cursor) {
      const argv = this.argvOf(command);
      if (!argv) continue;
      const logs = await this.ask<RequestOutcome<BackgroundLogs>>({
        type: 'chat-bg-logs',
        argv,
        since: next
      });
      const lines = logs?.ok ? errorLines(logs.result.lines) : [];
      const url = this.config?.processes.find((p) => p.command === command)?.url ?? null;
      if (lines.length > 0) found.push({ command, lines, url });
    }
    return found;
  }

  /** A process's argv, from the card that started it (the app reports the command only). */
  private argvOf(command: string): string[] | null {
    for (const view of this.views.values()) {
      for (const card of view.processes) {
        if (card.parsed.ok && formatArgv(card.parsed.argv) === command) return card.parsed.argv;
      }
    }
    // Its command as the app formats it: plain words split on spaces.
    const words = command.split(' ').filter(Boolean);
    return words.length > 0 && !/["'\\]/.test(command) ? words : null;
  }

  private actionsOf(view: MessageView): ReplyActions {
    const { parse } = view;
    // A file the cut fell in isn't part of the step: the continuation asks for it again.
    const cards = view.cards.filter((card) => card !== view.cutOff);
    const approve = () =>
      this.config?.mode === 'full-auto'
        ? this.config.autoApprove
        : { changes: false, gated: false, partial: false };
    const lifecycle = view.processes.filter((card) => card.kind !== 'logs');
    return {
      hasActions:
        cards.length +
          parse.reads.length +
          view.runs.length +
          view.changes.length +
          view.processes.length +
          view.downloads.length +
          view.assets.filter((card) => card.automatic).length >
        0,
      done: parse.done,
      // A cut-off reply's broken tail isn't the chat ignoring the format.
      formatIssues: parse.issues.length > 0 && view.interruption === null,
      markReminded: () => view.format?.markAutoSent(),
      applyEdits: async (loopId) => {
        await autoApply(cards, loopId, { approvePartial: approve().partial });
        await autoSave(view.assets, loopId);
        await Promise.allSettled(view.changes.map((card) => card.ready()));
        if (approve().changes) {
          // "Also approve automatically → deletes and renames": the app checks it too.
          for (const card of view.changes) {
            if (card.applicable) await card.apply({ trigger: 'auto', ...(loopId && { loopId }) });
          }
        }
        await Promise.allSettled(view.downloads.map((card) => card.ready()));
      },
      edits: () => editSummary(cards, view.assets),
      changes: () => changeSummary(view.changes),
      fingerprints: cards
        .filter((card) => card.duplicate !== 'earlier')
        .map((card) => ({
          path: card.edit.path,
          hash: card.key.slice(card.key.lastIndexOf(':') + 1)
        })),
      reads: parse.reads,
      readFiles: async () => {
        // The newest version of this reply's READ card: a rebuilt reply has a new one.
        const read = this.latest(view).read;
        if (!read) return { files: [], refused: [], disconnected: false };
        await read.ready();
        return read.contents();
      },
      markReadsSent: () => {
        const latest = this.latest(view);
        for (const card of new Set([view.read, latest.read])) card?.markSent();
        view.interrupt?.markAutoSent();
      },
      runs: view.runs.map((card) => ({
        command: card.command,
        refusal: () => card.refusal(),
        run: (loopId) => card.run({ trigger: 'auto', loopId }),
        busy: () => card.running
      })),
      processes: lifecycle.map((card) => ({
        kind: card.kind as Exclude<ProcessKind, 'logs'>,
        command: card.command,
        refusal: () => (card.kind === 'start' ? card.refusal() : null),
        act: (loopId) =>
          card.kind === 'start'
            ? card.start({ trigger: 'auto', loopId })
            : card.stop({ trigger: 'auto' })
      })),
      logs: view.processes
        .filter((card) => card.kind === 'logs')
        .map((card) => ({ command: card.command, read: () => card.readLogs() })),
      downloads: () => ({
        applied: view.downloads.filter((c) => c.state === 'applied').map((c) => c.summary),
        pending: view.downloads.filter((c) => c.waiting).map((c) => c.path)
      }),
      logCursor: () => this.logCursor(),
      processErrors: (cursor) => this.processErrors(cursor),
      interruption: view.interruption && {
        ...view.interruption,
        pageContinue: view.element === newestReply() && findContinueButton() !== null
      }
    };
  }

  private async build(
    conversationId: string,
    messageId: string,
    element: Element,
    text: string,
    interrupted = false,
    images: HTMLImageElement[] = []
  ): Promise<MessageView> {
    const parse = parseChat(text);
    const { reads, runs, deletes, renames, fixed, issues, starts, stops, logs, downloads } = parse;
    // Each image takes the next `@@ASSET` path. Paths with no image wait for the next reply.
    let assetPaths = parse.assets;
    if (images.length === 0) {
      this.orphanAssets = assetPaths.length > 0 ? { conversationId, paths: assetPaths } : null;
    } else if (assetPaths.length === 0 && this.orphanAssets?.conversationId === conversationId) {
      assetPaths = this.orphanAssets.paths;
      this.orphanAssets = null;
    }
    // A reply that was cut off: where. A DONE got through, so nothing that matters was lost.
    const interruption = interrupted && !parse.done ? interruptionOf(parse) : null;
    // The page draws a cut-off code block as a whole one, so its file is marked partial:
    // never applied on its own, a second click by hand.
    const cutIndex = interruption?.cutOff && parse.unclosed === null ? parse.edits.length - 1 : -1;
    const edits = parse.edits.map((edit, i) =>
      i === cutIndex ? { ...edit, suspectedPartial: true } : edit
    );
    const view: MessageView = {
      id: messageId,
      element,
      text,
      parse,
      cards: [],
      fences: edits.map((edit) => edit.fence),
      read: null,
      runs: [],
      changes: [],
      processes: [],
      downloads: [],
      assets: [],
      images: images.length,
      bar: null,
      format: issues.length > 0 && interruption === null ? new FormatCard(issues) : null,
      interruption,
      interrupt: null,
      cutOff: null,
      ready: Promise.resolve()
    };
    if (interruption) {
      view.interrupt = new InterruptCard(interruption, {
        canContinue: () => view.element === newestReply() && findContinueButton() !== null,
        continueReply: () => livePage.continueReply(),
        insert: (text) => livePage.insert(text)
      });
    }
    const changes: FileChange[] = [
      ...deletes.map((path) => ({ kind: 'delete' as const, path })),
      ...renames.map((rename) => ({ kind: 'rename' as const, ...rename }))
    ];
    const processCards: { kind: ProcessKind; command: string; fixed: boolean }[] = [
      ...stops.map((command) => ({
        kind: 'stop' as const,
        command,
        fixed: fixed.stops.includes(command)
      })),
      ...starts.map((command) => ({
        kind: 'start' as const,
        command,
        fixed: fixed.starts.includes(command)
      })),
      ...logs.map((command) => ({
        kind: 'logs' as const,
        command,
        fixed: fixed.logs.includes(command)
      }))
    ];
    if (
      edits.length +
        reads.length +
        runs.length +
        changes.length +
        issues.length +
        processCards.length +
        downloads.length +
        images.length >
        0 ||
      interruption
    ) {
      loadFonts();
    }

    const keys = await Promise.all(
      edits.map(async (edit, i) =>
        blockKey(conversationId, messageId, i, await contentHash(edit.path, edit.content))
      )
    );
    const readKey =
      reads.length > 0
        ? blockKey(conversationId, messageId, 'read', await contentHash('', reads.join('\n')))
        : null;
    const changeKeys = await Promise.all(
      changes.map(async (change, i) =>
        change.kind === 'delete'
          ? blockKey(conversationId, messageId, `d${i}`, await contentHash(change.path, ''))
          : blockKey(conversationId, messageId, `r${i}`, await contentHash(change.from, change.to))
      )
    );
    const downloadKeys = await Promise.all(
      downloads.map(async (download, i) =>
        blockKey(conversationId, messageId, `w${i}`, await contentHash(download.url, download.path))
      )
    );
    const assetKeys = await Promise.all(
      images.map(async (_, i) =>
        blockKey(
          conversationId,
          messageId,
          `a${i}`,
          await contentHash(assetPaths[i] ?? '', String(i))
        )
      )
    );
    const wanted = [
      ...keys,
      ...(readKey ? [readKey] : []),
      ...changeKeys,
      ...downloadKeys,
      ...assetKeys
    ];
    const records =
      wanted.length > 0
        ? ((await this.ask<Record<string, CardRecord>>({ type: 'card-get', keys: wanted })) ?? {})
        : {};
    const diffRecord = (key: string | undefined) => {
      const record = key ? records[key] : undefined;
      return record && !('card' in record) ? (record satisfies DiffCardRecord) : undefined;
    };

    const changed = () => {
      view.bar?.render();
      this.reportRequests();
    };
    view.cards = edits.map((edit, i) => new DiffCard(keys[i] ?? '', edit, this.ask, changed));
    view.cutOff = view.cards[cutIndex] ?? null;
    markDuplicates(view.cards);
    if (view.cards.length >= 2) view.bar = new MessageBar(view.cards);
    const loading: Promise<unknown>[] = [];
    for (const [i, card] of view.cards.entries()) {
      card.setMode(this.config?.mode ?? null);
      loading.push(card.init(diffRecord(keys[i])));
    }
    view.bar?.render();

    view.changes = changes.map(
      (change, i) => new ChangeCard(changeKeys[i] ?? '', change, this.ask, changed)
    );
    for (const [i, card] of view.changes.entries()) {
      const { change } = card;
      card.formatFixed =
        change.kind === 'delete'
          ? fixed.deletes.includes(change.path)
          : fixed.renames.some((r) => r.from === change.from && r.to === change.to);
      card.setMode(this.config?.mode ?? null);
      const record = records[changeKeys[i] ?? ''];
      loading.push(
        card.init(record && 'card' in record && record.card === 'change' ? record : undefined)
      );
    }

    if (readKey) {
      const record = records[readKey];
      view.read = new ReadCard(readKey, reads, this.ask, (files) => {
        void this.ask({ type: 'chat-sent', files });
        this.reportRequests();
      });
      view.read.formatFixed = fixed.reads.length > 0;
      loading.push(
        view.read.init(
          record && 'card' in record && record.card === 'read'
            ? (record satisfies ReadCardRecord)
            : undefined
        )
      );
    }

    view.runs = runs.map(
      (command) =>
        new RunCard(command, this.ask, (runId, card) => {
          this.registerRun(runId, card);
          this.reportRequests();
        })
    );
    for (const card of view.runs) {
      card.formatFixed = fixed.runs.includes(card.command);
      card.setConfig(this.config);
    }

    view.processes = processCards.map(({ kind, command, fixed: formatFixed }) => {
      const card = new ProcessCard(kind, command, this.ask);
      card.formatFixed = formatFixed;
      card.setConfig(this.config);
      return card;
    });

    const binaryRecord = (key: string | undefined) => {
      const record = key ? records[key] : undefined;
      return record && 'card' in record && (record.card === 'asset' || record.card === 'download')
        ? (record satisfies BinaryCardRecord)
        : undefined;
    };
    view.downloads = downloads.map((download, i) => {
      const card = new DownloadCard(downloadKeys[i] ?? '', download, this.ask, changed);
      card.formatFixed = fixed.downloads.some(
        (d) => d.url === download.url && d.path === download.path
      );
      card.setMode(this.config?.mode ?? null);
      loading.push(card.init(binaryRecord(downloadKeys[i])));
      return card;
    });
    view.assets = images.map((image, i) => {
      const card = new AssetCard(
        assetKeys[i] ?? '',
        image,
        assetPaths[i] ?? null,
        this.ask,
        changed
      );
      card.setMode(this.config?.mode ?? null);
      card.init(binaryRecord(assetKeys[i]));
      return card;
    });
    view.ready = Promise.allSettled(loading);
    return view;
  }

  /** Puts each card right after its code block, again if a re-render removed it. */
  private mount(view: MessageView, element: Element, codeBlocks: Element[]): void {
    view.element = element;
    const body = messageBody(element);
    const placeAfter = (host: HTMLElement, anchor: Element | null) => {
      if (anchor?.isConnected) {
        if (anchor.nextElementSibling !== host) anchor.after(host);
      } else if (host.parentElement !== body || body.lastElementChild !== host) {
        body.append(host);
      }
    };
    let last: Element | null = null;
    for (const [i, card] of view.cards.entries()) {
      const anchor = codeBlocks[view.fences[i] ?? -1] ?? last;
      placeAfter(card.host, anchor);
      last = card.host;
    }
    if (view.bar) placeAfter(view.bar.host, last);
    // Save to project goes right after its image; the page may have drawn it anew.
    const images = generatedImages(element);
    view.assets.forEach((card, i) => {
      const image = images[i];
      if (!image) return;
      card.image = image;
      const anchor = image.closest('figure') ?? image;
      if (anchor.nextElementSibling !== card.host) anchor.after(card.host);
    });
    // DELETE, RENAME, DOWNLOAD, READ, RUN, process and format cards go at the end, in that order.
    const tail = [
      ...view.changes.map((c) => c.host),
      ...view.downloads.map((c) => c.host),
      view.read?.host,
      ...view.runs.map((r) => r.host),
      ...view.processes.map((c) => c.host),
      view.format?.host,
      view.interrupt?.host
    ].filter((host): host is HTMLElement => host !== undefined);
    const inPlace = tail.every((host, i) => {
      const fromEnd = body.children[body.children.length - tail.length + i];
      return fromEnd === host;
    });
    if (!inPlace) body.append(...tail);
  }

  private setViewDisabled(view: MessageView, disabled: boolean): void {
    for (const card of view.cards) card.setDisabled(disabled);
    for (const card of view.changes) card.setDisabled(disabled);
    view.read?.setDisabled(disabled);
    for (const run of view.runs) run.setDisabled(disabled);
    for (const card of view.processes) card.setDisabled(disabled);
    for (const card of view.downloads) card.setDisabled(disabled);
    for (const card of view.assets) card.setDisabled(disabled);
    view.format?.setDisabled(disabled);
    view.interrupt?.setDisabled(disabled);
    view.bar?.render();
  }

  private remove(view: MessageView): void {
    for (const card of view.cards) card.host.remove();
    for (const card of view.changes) card.host.remove();
    view.read?.host.remove();
    for (const run of view.runs) run.host.remove();
    for (const card of view.processes) card.host.remove();
    for (const card of view.downloads) card.host.remove();
    for (const card of view.assets) card.host.remove();
    view.format?.host.remove();
    view.interrupt?.host.remove();
    view.bar?.host.remove();
  }

  private clear(): void {
    for (const view of this.views.values()) this.remove(view);
    this.views.clear();
  }
}

/** A RUN card's id for the side panel: its message and its place there. */
const runRequestId = (view: MessageView, index: number) => `run:${view.id}:${index}`;

/** An element as tag, id, role, data-* attributes and up to 4 classes. No text. */
function shapeOf(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id) out += `#${el.id}`;
  const role = el.getAttribute('role');
  if (role) out += `[role=${role}]`;
  for (const attr of el.attributes) {
    if (
      attr.name.startsWith('data-') &&
      !attr.name.startsWith('data-start') &&
      !attr.name.startsWith('data-end')
    ) {
      out += `[${attr.name}=${attr.value.slice(0, 40)}]`;
    }
  }
  const classes = [...el.classList].slice(0, 4);
  if (classes.length > 0) out += `.${classes.join('.')}`;
  return out;
}

/** An element's subtree, a few levels deep: shapes, child counts and text sizes. No text. */
function treeShape(el: Element, depth: number, out: string[], indent = ''): void {
  if (out.length >= 80) return;
  const text = el.textContent ?? '';
  out.push(
    `${indent}${shapeOf(el)} (${el.children.length} children, ${text.length} chars, ${text.split('\n').length} lines)`
  );
  if (depth === 0) return;
  const children = [...el.children];
  for (const child of children.slice(0, 6)) treeShape(child, depth - 1, out, `${indent}  `);
  if (children.length > 6) out.push(`${indent}  … ${children.length - 6} more`);
}

/**
 * The newest `@@FILE` marker's block and the blocks after it (the code block should be the
 * next one), as subtree shapes: enough to see how this layout draws a code block.
 */
function fileBlockShape(): string[] | null {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let marker: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[contenteditable], [data-bridge-host], script, style')) continue;
    if ((node.nodeValue ?? '').includes('@@FILE')) marker = node;
  }
  const root = marker?.parentElement?.closest(SELECTORS.markdown.join(', '));
  if (!marker?.parentElement || !root) return null;
  let block: Element = marker.parentElement;
  // Climb until the next sibling holds more than a line of text: that's the code block.
  while (block.parentElement && block.parentElement !== root) {
    const next = block.nextElementSibling;
    if (next && (next.textContent ?? '').length > 40) break;
    block = block.parentElement;
  }
  const out: string[] = [`marker block: ${shapeOf(block)}`];
  let sibling = block.nextElementSibling;
  for (let i = 0; sibling && i < 2; i += 1, sibling = sibling.nextElementSibling) {
    treeShape(sibling, 7, out);
  }
  return out;
}

/**
 * Where the newest Bridge marker sits on the page and what surrounds it, plus which data-*
 * attributes and test ids the page uses: enough to write new selectors when the markup moves.
 */
function pageShape(): Record<string, unknown> {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let marker: Node | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('[contenteditable], [data-bridge-host], script, style')) continue;
    if (/@@(?:RUN|READ|FILE|DONE)/.test(node.nodeValue ?? '')) marker = node;
  }
  const chain: string[] = [];
  for (
    let el = marker?.parentElement ?? null;
    el && el !== document.body && chain.length < 18;
    el = el.parentElement
  ) {
    chain.push(shapeOf(el));
  }
  // The block that holds the marker's whole reply: its children, one level down.
  const reply = marker?.parentElement?.closest('[class*="markdown"], [class*="prose"]') ?? null;
  const attributes = new Map<string, number>();
  const testIds = new Map<string, number>();
  for (const el of document.body.querySelectorAll('*')) {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-'))
        attributes.set(attr.name, (attributes.get(attr.name) ?? 0) + 1);
    }
    const id = el.getAttribute('data-testid');
    if (id) testIds.set(id.replace(/\d+/g, 'N'), (testIds.get(id.replace(/\d+/g, 'N')) ?? 0) + 1);
  }
  const buttons = [...document.querySelectorAll('button[aria-label]')]
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((label, i, list) => list.indexOf(label) === i)
    .slice(0, 40);
  return {
    fileBlock: fileBlockShape(),
    markerFound: marker !== null,
    markerAncestors: chain,
    replyChildren: reply ? [...reply.children].slice(0, 12).map(shapeOf) : null,
    shadowHosts: [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length,
    iframes: document.querySelectorAll('iframe').length,
    dataAttributes: Object.fromEntries([...attributes].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    testIds: Object.fromEntries([...testIds].sort((a, b) => b[1] - a[1]).slice(0, 40)),
    buttonLabels: buttons
  };
}

/** The extension was reloaded or updated: this script's runtime is gone for good. */
export function isContextInvalidated(error: unknown): boolean {
  return (
    !chrome.runtime?.id || (error instanceof Error && /context invalidated/i.test(error.message))
  );
}

/**
 * Sends requests to the service worker. Undefined if it refused or isn't there. When the
 * extension itself is gone (reloaded or updated), `onInvalid` runs.
 */
export function createAskWorker(onInvalid: () => void): Ask {
  return async <R>(request: WorkerRequest) => {
    try {
      return (await chrome.runtime.sendMessage<WorkerRequest, R>(request)) ?? undefined;
    } catch (error) {
      if (isContextInvalidated(error)) onInvalid();
      return undefined;
    }
  };
}
