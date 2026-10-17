import { z } from 'zod';
import { ConversationId, LayoutHealth, type ChatPanelState, type SessionState } from '../messages';
import type { CardStore } from './cards';
import { Serial, type KeyValueArea } from './store';

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const SessionRecord = z.object({
  startedAt: z.number(),
  endedAt: z.number().optional(),
  filesSent: z.array(z.string()).max(1000)
});
type SessionRecord = z.infer<typeof SessionRecord>;

const TabRecord = z.object({ conversationId: ConversationId.nullable(), layout: LayoutHealth });
type TabRecord = z.infer<typeof TabRecord>;

const SESSIONS = 'sessions';
const PENDING = 'pendingSessions';
const TABS = 'chatTabs';

function records<T>(raw: unknown, schema: z.ZodType<T>): Record<string, T> {
  const out: Record<string, T> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

const stateOf = (record: SessionRecord): SessionState =>
  record.endedAt === undefined ? 'active' : 'ended';

/**
 * Chat sessions. A session belongs to one conversation (by its `/c/<id>`) and lives in
 * `chrome.storage.local`, so it survives reloads. A session started in a new chat has no
 * id yet: it waits on the tab (in `chrome.storage.session`) and binds to the conversation
 * when the tab's URL gets one. Also tracks which chatgpt.com tabs have the content script
 * running, from their `chat-sync` messages.
 */
export class Sessions {
  private readonly serial = new Serial();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly local: KeyValueArea,
    private readonly session: KeyValueArea,
    private readonly cards: CardStore,
    private readonly now: () => number = Date.now
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private async load() {
    const [sessions, pending, tabs] = await Promise.all([
      this.local.get(SESSIONS).then((raw) => records(raw, SessionRecord)),
      this.session.get(PENDING).then((raw) => records(raw, SessionRecord)),
      this.session.get(TABS).then((raw) => records(raw, TabRecord))
    ]);
    return { sessions, pending, tabs };
  }

  /** The content script reports its tab's conversation and whether it can read the page. */
  sync(tabId: number, conversationId: string | null, layout: TabRecord['layout']) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const key = String(tabId);
      const before = JSON.stringify(tabs[key]);
      tabs[key] = { conversationId, layout };
      let bound = false;
      const waiting = pending[key];
      if (conversationId && waiting) {
        // The new chat got its id: the session waiting on this tab now belongs to it.
        sessions[conversationId] = waiting;
        delete pending[key];
        bound = true;
        await Promise.all([this.saveSessions(sessions), this.session.set(PENDING, pending)]);
      }
      await this.session.set(TABS, tabs);
      if (bound || before !== JSON.stringify(tabs[key])) this.changed();
      return this.resolve(key, tabs, sessions, pending)?.state ?? null;
    });
  }

  /** Starts (or restarts) the session for the tab's conversation, or for its new chat. */
  start(tabId: number) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const record: SessionRecord = { startedAt: this.now(), filesSent: [] };
      const conversationId = tabs[String(tabId)]?.conversationId;
      if (conversationId) {
        sessions[conversationId] = record;
        await this.saveSessions(sessions);
      } else {
        pending[String(tabId)] = record;
        await this.session.set(PENDING, pending);
      }
      this.changed();
    });
  }

  /** Ends the tab's session. Cards stay on the page but are disabled. */
  end(tabId: number) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const key = String(tabId);
      const conversationId = tabs[key]?.conversationId;
      if (pending[key]) {
        delete pending[key];
        await this.session.set(PENDING, pending);
      } else if (conversationId && sessions[conversationId]) {
        sessions[conversationId].endedAt ??= this.now();
        await this.saveSessions(sessions);
      }
      this.changed();
    });
  }

  /** Records files sent to the chat in the tab's active session. */
  addSent(tabId: number, paths: readonly string[]) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const found = this.resolve(String(tabId), tabs, sessions, pending);
      if (!found || found.state !== 'active') return;
      const sent = found.record.filesSent;
      for (const path of paths) if (!sent.includes(path)) sent.push(path);
      if (found.conversationId) await this.saveSessions(sessions);
      else await this.session.set(PENDING, pending);
      this.changed();
    });
  }

  async stateFor(tabId: number): Promise<SessionState | null> {
    const { sessions, pending, tabs } = await this.load();
    return this.resolve(String(tabId), tabs, sessions, pending)?.state ?? null;
  }

  /** The conversation the tab last reported, if it has an active session. */
  async activeConversation(tabId: number): Promise<string | null> {
    const { sessions, pending, tabs } = await this.load();
    const found = this.resolve(String(tabId), tabs, sessions, pending);
    return found?.state === 'active' ? found.conversationId : null;
  }

  async isActive(tabId: number): Promise<boolean> {
    return (await this.stateFor(tabId)) === 'active';
  }

  /** Tabs whose content script has reported in. */
  async tabIds(): Promise<number[]> {
    const { tabs } = await this.load();
    return Object.keys(tabs).map(Number).filter(Number.isInteger);
  }

  async tab(tabId: number): Promise<TabRecord | null> {
    const { tabs } = await this.load();
    return tabs[String(tabId)] ?? null;
  }

  /** Forgets a closed tab, and a session still waiting on it. */
  removeTab(tabId: number) {
    return this.serial.run(async () => {
      const { pending, tabs } = await this.load();
      const key = String(tabId);
      if (!tabs[key] && !pending[key]) return;
      delete tabs[key];
      delete pending[key];
      await Promise.all([this.session.set(TABS, tabs), this.session.set(PENDING, pending)]);
      this.changed();
    });
  }

  async panelState(tabId: number | null): Promise<Omit<ChatPanelState, 'loop'>> {
    if (tabId === null) return { tab: null, session: null };
    const { sessions, pending, tabs } = await this.load();
    const key = String(tabId);
    const tab = tabs[key] ?? null;
    const found = this.resolve(key, tabs, sessions, pending);
    if (!found) return { tab, session: null };
    const counts = found.conversationId
      ? await this.cards.counts(found.conversationId)
      : { applied: 0, pending: 0 };
    return {
      tab,
      session: {
        state: found.state,
        conversationId: found.conversationId,
        startedAt: found.record.startedAt,
        filesSent: [...found.record.filesSent],
        ...counts
      }
    };
  }

  private resolve(
    key: string,
    tabs: Record<string, TabRecord>,
    sessions: Record<string, SessionRecord>,
    pending: Record<string, SessionRecord>
  ): { record: SessionRecord; conversationId: string | null; state: SessionState } | null {
    const conversationId = tabs[key]?.conversationId ?? null;
    if (conversationId) {
      const record = sessions[conversationId];
      return record ? { record, conversationId, state: stateOf(record) } : null;
    }
    const waiting = pending[key];
    return waiting ? { record: waiting, conversationId: null, state: 'active' } : null;
  }

  private saveSessions(sessions: Record<string, SessionRecord>): Promise<void> {
    const cutoff = this.now() - SESSION_MAX_AGE_MS;
    const kept = Object.fromEntries(
      Object.entries(sessions).filter(([, s]) => (s.endedAt ?? s.startedAt) >= cutoff)
    );
    return this.local.set(SESSIONS, kept);
  }
}
