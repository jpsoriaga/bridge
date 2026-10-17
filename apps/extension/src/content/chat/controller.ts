import { parseChat } from '@bridge/shared';
import type { CardRecord, ChatSyncReply, SessionState, WorkerRequest } from '../../messages';
import { messageToText } from './adapter';
import { ApplyAllBar } from './cards/apply-all';
import { DiffCard, type Ask } from './cards/diff-card';
import { loadFonts } from './cards/host';
import { ReadCard } from './cards/read-card';
import { blockKey, contentHash } from './keys';
import {
  assistantMessages,
  checkLayout,
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

/** One assistant message's cards. */
interface MessageView {
  element: Element;
  text: string;
  cards: DiffCard[];
  /** For each card, the index of its code block among the message's `<pre>`s. */
  fences: number[];
  read: ReadCard | null;
  applyAll: ApplyAllBar | null;
}

/**
 * Watches the conversation and puts a card under each `@@FILE` block of each finished
 * assistant message, while this conversation has an active session. Cards are re-inserted
 * when the page's re-renders drop them, and rebuilt when a message's text changes
 * (regenerate, edit).
 */
export class ChatController {
  private conversationId: string | null = null;
  private session: SessionState | null = null;
  private layout: LayoutHealth = 'ok';
  private layoutStrikes = 0;
  private readonly views = new Map<string, MessageView>();
  private observer: MutationObserver | null = null;
  private observed: Element | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning = false;
  private rescan = false;

  constructor(private readonly ask: Ask) {}

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
    this.schedule();
  }

  private async sync(): Promise<void> {
    const reply = await this.ask<ChatSyncReply>({
      type: 'chat-sync',
      conversationId: this.conversationId,
      layout: this.layout
    });
    this.setSession(reply?.session ?? null);
  }

  private poll(): void {
    const id = conversationIdFrom(location.href);
    if (id !== this.conversationId) {
      // Another conversation (or a new chat): drop this one's cards and bind again.
      this.conversationId = id;
      this.clear();
      void this.sync();
    }

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
    }
  }

  private async build(
    conversationId: string,
    messageId: string,
    element: Element,
    text: string
  ): Promise<MessageView> {
    const { edits, reads } = parseChat(text);
    const view: MessageView = {
      element,
      text,
      cards: [],
      fences: edits.map((edit) => edit.fence),
      read: null,
      applyAll: null
    };
    if (edits.length > 0 || reads.length > 0) loadFonts();

    const keys = await Promise.all(
      edits.map(async (edit, i) =>
        blockKey(conversationId, messageId, i, await contentHash(edit.path, edit.content))
      )
    );
    const records =
      keys.length > 0
        ? ((await this.ask<Record<string, CardRecord>>({ type: 'card-get', keys })) ?? {})
        : {};

    const changed = () => view.applyAll?.render();
    view.cards = edits.map((edit, i) => new DiffCard(keys[i] ?? '', edit, this.ask, changed));
    if (view.cards.length >= 2) view.applyAll = new ApplyAllBar(view.cards);
    for (const [i, card] of view.cards.entries()) void card.init(records[keys[i] ?? '']);
    view.applyAll?.render();

    if (reads.length > 0) {
      view.read = new ReadCard(reads, this.ask, (paths) => {
        void this.ask({ type: 'chat-sent', paths });
      });
      void view.read.init();
    }
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
    if (view.applyAll) placeAfter(view.applyAll.host, last);
    if (view.read && body.lastElementChild !== view.read.host) body.append(view.read.host);
  }

  private setViewDisabled(view: MessageView, disabled: boolean): void {
    for (const card of view.cards) card.setDisabled(disabled);
    view.read?.setDisabled(disabled);
    view.applyAll?.render();
  }

  private remove(view: MessageView): void {
    for (const card of view.cards) card.host.remove();
    view.read?.host.remove();
    view.applyAll?.host.remove();
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
