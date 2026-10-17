import { parseChat, type BridgeConfig, type ChatParse, type RunResult } from '@bridge/shared';
import type {
  CardRecord,
  ChatSyncReply,
  DiffCardRecord,
  ReadCardRecord,
  SessionState,
  WorkerRequest
} from '../../messages';
import { messageToText } from './adapter';
import { DiffCard, type Ask } from './cards/diff-card';
import { loadFonts } from './cards/host';
import { LoopChip } from './cards/loop-chip';
import { MessageBar } from './cards/message-bar';
import { ReadCard } from './cards/read-card';
import { RunCard } from './cards/run-card';
import { blockKey, contentHash } from './keys';
import { FullAutoLoop, type EditHold, type EditSummary, type ReplyActions } from './loop';
import { livePage } from './page';
import {
  all,
  assistantMessages,
  checkLayout,
  closest,
  first,
  SELECTORS,
  conversationIdFrom,
  findConversation,
  isMessageComplete,
  messageBody,
  messageIdOf,
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

/** One assistant message's cards. */
interface MessageView {
  element: Element;
  text: string;
  parse: ChatParse;
  cards: DiffCard[];
  /** For each card, the index of its code block among the message's `<pre>`s. */
  fences: number[];
  read: ReadCard | null;
  runs: RunCard[];
  bar: MessageBar | null;
  /** Every card has read what it needs. */
  ready: Promise<unknown>;
}

type RunEvent = { type: 'output'; chunk: string } | { type: 'exit'; result: RunResult };

/**
 * Applies a reply's edits by the Auto-apply rules: in order, leaving partial, conflicting,
 * blocked, gated and oversized files on their cards for a click.
 */
export async function autoApply(cards: readonly DiffCard[], loopId?: string): Promise<void> {
  for (const card of cards) {
    await card.ready();
    if (card.state !== 'pending' || !card.applicable) continue;
    await card.apply({ trigger: 'auto', ...(loopId && { loopId }) });
  }
}

/** Where a reply's edits stand: applied, or left on their card and why. */
export function editSummary(cards: readonly DiffCard[]): EditSummary {
  const applied: string[] = [];
  const held: EditSummary['held'] = [];
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

  constructor(private readonly ask: Ask) {
    this.chip = new LoopChip(() => this.loop.stop());
    this.loop = new FullAutoLoop({
      page: livePage,
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
    setInterval(() => this.poll(), POLL_MS);
    this.attach();
  }

  /** The service worker says the session for this tab started or ended. */
  setSession(session: SessionState | null): void {
    this.session = session;
    for (const view of this.views.values()) this.setViewDisabled(view, session !== 'active');
    if (session !== 'active' && this.loop.active) this.loop.stop();
    this.renderChip();
    this.schedule();
  }

  /** The app's mode and allowlist changed, or the connection came or went (null). */
  setConfig(config: BridgeConfig | null): void {
    this.config = config;
    for (const view of this.views.values()) {
      for (const card of view.cards) card.setMode(config?.mode ?? null);
      for (const run of view.runs) run.setConfig(config);
    }
    this.loop.onConfig(config);
    this.renderChip();
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
        parsed: {
          edits: parsed.edits.map((e) => e.path),
          reads: parsed.reads,
          runs: parsed.runs,
          done: parsed.done
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
      bridgeHosts: all(document, [`[data-bridge-host]`]).length
    };
  }

  /** Stop, Resume or Continue from the side panel or the app. */
  loopControl(action: 'stop' | 'resume' | 'continue'): void {
    if (action === 'stop') this.loop.stop();
    else if (action === 'resume') this.loop.resume();
    else this.loop.continueFor();
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
    const on = this.session === 'active' && this.config?.mode === 'full-auto';
    const { state, step, limit, reason } = this.loop;
    this.chip.render(
      on || state !== 'idle'
        ? {
            state,
            step,
            limit: Math.max(limit, this.config?.stepLimit ?? 1),
            ...(reason && { reason })
          }
        : null
    );
  }

  private async sync(): Promise<void> {
    const start = this.firstSync;
    this.firstSync = false;
    const reply = await this.ask<ChatSyncReply>({
      type: 'chat-sync',
      conversationId: this.conversationId,
      layout: this.layout,
      ...(start && { start: true })
    });
    if (!reply) console.info('[Bridge] The extension didn’t answer. Reload this tab.');
    this.setConfig(reply?.config ?? null);
    this.setSession(reply?.session ?? null);
  }

  private poll(): void {
    const id = conversationIdFrom(location.href);
    if (id !== this.conversationId) {
      // Another conversation (or a new chat): drop this one's cards and bind again.
      this.loop.onNavigate(id);
      this.conversationId = id;
      this.history = null;
      this.clear();
      void this.sync();
    }
    this.loop.tick();

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
      if (!isMessageComplete(element)) continue;
      const id = messageIdOf(element, index);
      const { text, codeBlocks } = messageToText(element);
      const existing = this.views.get(id);
      if (existing && existing.element === element && existing.text === text) {
        this.mount(existing, element, codeBlocks);
        continue;
      }
      if (this.session !== 'active') continue;
      // New, or its text changed (regenerated or edited): rebuild its cards.
      if (existing) this.remove(existing);
      const view = await this.build(conversationId, id, element, text);
      if (this.conversationId !== conversationId) return;
      this.views.set(id, view);
      this.mount(view, element, codeBlocks);
      // Only a reply that wasn't on the page when it loaded is acted on.
      if (!this.history.has(id)) void this.act(view);
    }
  }

  /** What the app's mode does with a new reply. */
  private async act(view: MessageView): Promise<void> {
    if (this.session !== 'active') return;
    await view.ready;
    switch (this.config?.mode) {
      case 'auto-apply':
        await autoApply(view.cards);
        break;
      case 'full-auto':
        this.loop.onReply(this.actionsOf(view));
        break;
      default:
        break;
    }
  }

  private actionsOf(view: MessageView): ReplyActions {
    const { parse } = view;
    return {
      hasActions: view.cards.length + parse.reads.length + view.runs.length > 0,
      done: parse.done,
      applyEdits: (loopId) => autoApply(view.cards, loopId),
      edits: () => editSummary(view.cards),
      reads: parse.reads,
      readFiles: async () => {
        if (!view.read) return { files: [], refused: [], disconnected: false };
        await view.read.ready();
        return view.read.contents();
      },
      markReadsSent: () => view.read?.markSent(),
      runs: view.runs.map((card) => ({
        command: card.command,
        refusal: () => card.refusal(),
        run: (loopId) => card.run({ trigger: 'auto', loopId })
      }))
    };
  }

  private async build(
    conversationId: string,
    messageId: string,
    element: Element,
    text: string
  ): Promise<MessageView> {
    const parse = parseChat(text);
    const { edits, reads, runs } = parse;
    const view: MessageView = {
      element,
      text,
      parse,
      cards: [],
      fences: edits.map((edit) => edit.fence),
      read: null,
      runs: [],
      bar: null,
      ready: Promise.resolve()
    };
    if (edits.length > 0 || reads.length > 0 || runs.length > 0) loadFonts();

    const keys = await Promise.all(
      edits.map(async (edit, i) =>
        blockKey(conversationId, messageId, i, await contentHash(edit.path, edit.content))
      )
    );
    const readKey =
      reads.length > 0
        ? blockKey(conversationId, messageId, 'read', await contentHash('', reads.join('\n')))
        : null;
    const wanted = readKey ? [...keys, readKey] : keys;
    const records =
      wanted.length > 0
        ? ((await this.ask<Record<string, CardRecord>>({ type: 'card-get', keys: wanted })) ?? {})
        : {};
    const diffRecord = (key: string | undefined) => {
      const record = key ? records[key] : undefined;
      return record && !('card' in record) ? (record satisfies DiffCardRecord) : undefined;
    };

    const changed = () => view.bar?.render();
    view.cards = edits.map((edit, i) => new DiffCard(keys[i] ?? '', edit, this.ask, changed));
    if (view.cards.length >= 2) view.bar = new MessageBar(view.cards);
    const loading: Promise<unknown>[] = [];
    for (const [i, card] of view.cards.entries()) {
      card.setMode(this.config?.mode ?? null);
      loading.push(card.init(diffRecord(keys[i])));
    }
    view.bar?.render();

    if (readKey) {
      const record = records[readKey];
      view.read = new ReadCard(readKey, reads, this.ask, (paths) => {
        void this.ask({ type: 'chat-sent', paths });
      });
      loading.push(
        view.read.init(record && 'card' in record ? (record satisfies ReadCardRecord) : undefined)
      );
    }

    view.runs = runs.map(
      (command) => new RunCard(command, this.ask, (runId, card) => this.registerRun(runId, card))
    );
    for (const card of view.runs) card.setConfig(this.config);
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
    // READ and RUN cards go at the end, in that order.
    const tail = [view.read?.host, ...view.runs.map((r) => r.host)].filter(
      (host): host is HTMLElement => host !== undefined
    );
    const inPlace = tail.every((host, i) => {
      const fromEnd = body.children[body.children.length - tail.length + i];
      return fromEnd === host;
    });
    if (!inPlace) body.append(...tail);
  }

  private setViewDisabled(view: MessageView, disabled: boolean): void {
    for (const card of view.cards) card.setDisabled(disabled);
    view.read?.setDisabled(disabled);
    for (const run of view.runs) run.setDisabled(disabled);
    view.bar?.render();
  }

  private remove(view: MessageView): void {
    for (const card of view.cards) card.host.remove();
    view.read?.host.remove();
    for (const run of view.runs) run.host.remove();
    view.bar?.host.remove();
  }

  private clear(): void {
    for (const view of this.views.values()) this.remove(view);
    this.views.clear();
  }
}

/** Sends a request to the service worker. Undefined if it refused or isn't there. */
export const askWorker: Ask = async <R>(request: WorkerRequest) => {
  try {
    return (await chrome.runtime.sendMessage<WorkerRequest, R>(request)) ?? undefined;
  } catch {
    return undefined;
  }
};
