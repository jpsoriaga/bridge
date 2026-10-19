import { z } from 'zod';
import { MAX_WATCHED_PATHS } from '@bridge/shared';
import {
  ConversationId,
  LayoutHealth,
  SentFile,
  type ChatPanelState,
  type ContextEntry,
  type SessionState
} from '../messages';
import type { CardStore } from './cards';
import { Serial, type KeyValueArea } from './store';

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Most files one session remembers sending. */
const MAX_CONTEXT_FILES = 1000;

const ContextFile = SentFile.extend({
  stale: z.literal(true).optional(),
  missing: z.literal(true).optional()
});
type ContextFile = z.infer<typeof ContextFile>;

const SessionRecord = z.object({
  startedAt: z.number(),
  endedAt: z.number().optional(),
  /** The tab the session belongs to. Other tabs on the same conversation see `elsewhere`. */
  tabId: z.number().int().optional(),
  /** Files sent to the chat, oldest first. */
  files: z.array(ContextFile).max(MAX_CONTEXT_FILES).optional(),
  /** Before files had sizes and hashes: just the paths. Read once into `files`. */
  filesSent: z.array(z.string()).max(MAX_CONTEXT_FILES).optional()
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

/** The record's files, from either format. */
function filesOf(record: SessionRecord): ContextFile[] {
  record.files ??= (record.filesSent ?? []).map((path) => ({ path, chars: 0 }));
  delete record.filesSent;
  return record.files;
}

const toEntry = (file: ContextFile): ContextEntry => ({
  path: file.path,
  chars: file.chars,
  ...(file.hash && { hash: file.hash }),
  stale: file.stale === true,
  missing: file.missing === true
});

interface Found {
  record: SessionRecord;
  conversationId: string | null;
  state: SessionState;
}

/**
 * Chat sessions. A session belongs to one conversation (by its `/c/<id>`) and lives in
 * `chrome.storage.local`, so it survives reloads and the app restarting. It also belongs
 * to one tab: another tab showing the same conversation sees `elsewhere` until the user
 * moves the session there (or the owning tab leaves the conversation). A session started
 * in a new chat has no id yet: it waits on the tab (in `chrome.storage.session`) and binds
 * to the conversation when the tab's URL gets one. Also tracks which chatgpt.com tabs have
 * the content script running, from their `chat-sync` messages, and the files in context.
 */
export class Sessions {
  private readonly serial = new Serial();
  private readonly listeners = new Set<() => void>();
  private readonly endedListeners = new Set<(conversationId: string) => void>();

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

  /** A tab left the conversation whose session it owned, which ended that session. */
  onEnded(listener: (conversationId: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => this.endedListeners.delete(listener);
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

  /**
   * The content script reports its tab's conversation and whether it can read the page.
   * A tab claims its conversation's session if no other tab still shows it. A tab that moved
   * to another conversation or a new chat ends the session it owned in the one it left.
   */
  sync(tabId: number, conversationId: string | null, layout: TabRecord['layout']) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const key = String(tabId);
      const before = JSON.stringify(tabs[key]);
      const left = tabs[key]?.conversationId ?? null;
      tabs[key] = { conversationId, layout };
      let saved = false;
      let ended: string | null = null;
      const owned = left === null ? undefined : sessions[left];
      if (
        left !== null &&
        left !== conversationId &&
        owned?.endedAt === undefined &&
        owned?.tabId === tabId
      ) {
        owned.endedAt = this.now();
        ended = left;
        saved = true;
      }
      const waiting = pending[key];
      if (conversationId && waiting) {
        // The new chat got its id: the session waiting on this tab now belongs to it.
        sessions[conversationId] = { ...waiting, tabId };
        delete pending[key];
        saved = true;
        await this.session.set(PENDING, pending);
      }
      const record = conversationId ? sessions[conversationId] : undefined;
      if (record && record.endedAt === undefined && record.tabId !== tabId) {
        const owner = record.tabId === undefined ? undefined : tabs[String(record.tabId)];
        if (owner?.conversationId !== conversationId) {
          // The owning tab is gone or shows something else: this tab takes over.
          record.tabId = tabId;
          saved = true;
        }
      }
      if (saved) await this.saveSessions(sessions);
      await this.session.set(TABS, tabs);
      if (saved || before !== JSON.stringify(tabs[key])) this.changed();
      if (ended !== null) for (const listener of this.endedListeners) listener(ended);
      return this.resolve(key, tabs, sessions, pending)?.state ?? null;
    });
  }

  /** Starts (or restarts) the session for the tab's conversation, or for its new chat. */
  start(tabId: number) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const record: SessionRecord = { startedAt: this.now(), tabId, files: [] };
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

  /**
   * Gives the tab's conversation's session to this tab. Returns the tab that had it, to be
   * told, or null.
   */
  moveHere(tabId: number) {
    return this.serial.run(async () => {
      const { sessions, tabs } = await this.load();
      const conversationId = tabs[String(tabId)]?.conversationId;
      const record = conversationId ? sessions[conversationId] : undefined;
      if (!record || record.endedAt !== undefined || record.tabId === tabId) return null;
      const previous = record.tabId ?? null;
      record.tabId = tabId;
      await this.saveSessions(sessions);
      this.changed();
      return previous;
    });
  }

  /** Tabs other than `tabId` showing `conversationId`, which see the session as elsewhere. */
  async otherTabs(tabId: number, conversationId: string): Promise<number[]> {
    const { tabs } = await this.load();
    return Object.entries(tabs)
      .filter(([key, tab]) => key !== String(tabId) && tab.conversationId === conversationId)
      .map(([key]) => Number(key));
  }

  /** Records files sent to the chat in the tab's active session, as fresh. */
  addSent(tabId: number, files: readonly SentFile[]) {
    return this.editContext(tabId, (list) => {
      for (const file of files) {
        const at = list.findIndex((f) => f.path === file.path);
        if (at !== -1) list.splice(at, 1);
        list.push({ ...file });
      }
      return true;
    });
  }

  /** Drops a file from the tab's files in context. */
  removeContext(tabId: number, path: string) {
    return this.editContext(tabId, (list) => {
      const at = list.findIndex((f) => f.path === path);
      if (at === -1) return false;
      list.splice(at, 1);
      return true;
    });
  }

  /**
   * The chat changed a file itself (applied an edit, deleted or renamed it), so what it
   * knows is the new version: the file in context follows instead of turning stale.
   */
  noteChanged(
    tabId: number,
    change:
      | { kind: 'write'; path: string; hash: string; chars: number }
      | { kind: 'delete'; path: string }
      | { kind: 'rename'; from: string; to: string }
  ) {
    return this.editContext(tabId, (list) => {
      const path = change.kind === 'rename' ? change.from : change.path;
      const file = list.find((f) => f.path === path);
      if (!file) return false;
      if (change.kind === 'delete') list.splice(list.indexOf(file), 1);
      else if (change.kind === 'rename') file.path = change.to;
      else {
        file.hash = change.hash;
        file.chars = change.chars;
        delete file.stale;
        delete file.missing;
      }
      return true;
    });
  }

  /**
   * What a changed file looks like on disk now (its hash, or null if it's gone), for every
   * active session that sent it. Marks it stale or missing, or fresh again. Returns whether
   * anything changed.
   */
  noteDisk(path: string, hash: string | null) {
    return this.serial.run(async () => {
      const { sessions, pending } = await this.load();
      let touched = false;
      const visit = (record: SessionRecord) => {
        if (record.endedAt !== undefined) return false;
        const file = filesOf(record).find((f) => f.path === path);
        if (!file) return false;
        const before = JSON.stringify(file);
        if (hash === null) {
          file.missing = true;
          delete file.stale;
        } else {
          delete file.missing;
          if (file.hash !== undefined && file.hash !== hash) file.stale = true;
          else delete file.stale;
        }
        return before !== JSON.stringify(file);
      };
      let local = false;
      for (const record of Object.values(sessions)) if (visit(record)) local = touched = true;
      let waiting = false;
      for (const record of Object.values(pending)) if (visit(record)) waiting = touched = true;
      if (local) await this.saveSessions(sessions);
      if (waiting) await this.session.set(PENDING, pending);
      if (touched) this.changed();
      return touched;
    });
  }

  /** Every file in context in an active session, for the app to poll and to re-check. */
  async contextPaths(): Promise<string[]> {
    const { sessions, pending } = await this.load();
    const paths = new Set<string>();
    for (const record of [...Object.values(sessions), ...Object.values(pending)]) {
      if (record.endedAt !== undefined) continue;
      for (const file of filesOf(record)) paths.add(file.path);
    }
    return [...paths].slice(0, MAX_WATCHED_PATHS);
  }

  /** The tab's files in context. */
  async context(tabId: number): Promise<ContextEntry[]> {
    const { sessions, pending, tabs } = await this.load();
    const found = this.resolve(String(tabId), tabs, sessions, pending);
    return found ? filesOf(found.record).map(toEntry) : [];
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

  /** The session is active, and this tab owns it. */
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

  async panelState(tabId: number | null): Promise<Pick<ChatPanelState, 'tab' | 'session'>> {
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
        context: filesOf(found.record).map(toEntry),
        ...counts
      }
    };
  }

  /** Changes the tab's own session's file list. `edit` returns whether it changed it. */
  private editContext(tabId: number, edit: (files: ContextFile[]) => boolean) {
    return this.serial.run(async () => {
      const { sessions, pending, tabs } = await this.load();
      const found = this.resolve(String(tabId), tabs, sessions, pending);
      if (!found || found.state !== 'active') return;
      const files = filesOf(found.record);
      if (!edit(files)) return;
      if (files.length > MAX_CONTEXT_FILES) files.splice(0, files.length - MAX_CONTEXT_FILES);
      if (found.conversationId) await this.saveSessions(sessions);
      else await this.session.set(PENDING, pending);
      this.changed();
    });
  }

  private resolve(
    key: string,
    tabs: Record<string, TabRecord>,
    sessions: Record<string, SessionRecord>,
    pending: Record<string, SessionRecord>
  ): Found | null {
    const conversationId = tabs[key]?.conversationId ?? null;
    if (conversationId) {
      const record = sessions[conversationId];
      if (!record) return null;
      if (record.endedAt !== undefined) return { record, conversationId, state: 'ended' };
      const owner = record.tabId;
      const elsewhere =
        owner !== undefined &&
        String(owner) !== key &&
        tabs[String(owner)]?.conversationId === conversationId;
      return { record, conversationId, state: elsewhere ? 'elsewhere' : 'active' };
    }
    const waiting = pending[key];
    return waiting ? { record: waiting, conversationId: null, state: 'active' } : null;
  }

  private saveSessions(sessions: Record<string, SessionRecord>): Promise<void> {
    const cutoff = this.now() - SESSION_MAX_AGE_MS;
    const kept = Object.fromEntries(
      Object.entries(sessions)
        .filter(([, s]) => (s.endedAt ?? s.startedAt) >= cutoff)
        .map(([id, s]) => {
          filesOf(s);
          return [id, s];
        })
    );
    return this.local.set(SESSIONS, kept);
  }
}
