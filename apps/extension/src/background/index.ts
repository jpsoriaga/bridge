import {
  buildContextMessage,
  buildSessionPrompt,
  FILE_ERROR_LABELS,
  summarizeTree,
  type FileErrorCode
} from '@bridge/shared';
import {
  PanelHello,
  SIDE_PANEL_PORT,
  TabMessage,
  WorkerRequest,
  type ChatSyncReply,
  type InsertResult,
  type RequestOutcome,
  type SendFilesResult,
  type SessionError,
  type SessionPreview,
  type SessionStartResult,
  type StatusUpdate,
  type WorkerRequestOf
} from '../messages';
import { CardStore } from './cards';
import { Connection, type ConnectionStorage, type ReconnectAlarm } from './connection';
import { indexedDbKeyStore, migratingKeyStore } from './key-store';
import { classifySender, isAllowed, type Sender } from './senders';
import { Sessions } from './sessions';
import { chromeArea } from './store';

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// The pairing key is in the worker's IndexedDB, out of content scripts' reach. Earlier
// versions kept it in chrome.storage.local; it moves over once and is deleted there.
const keys = migratingKeyStore(indexedDbKeyStore(indexedDB), chrome.storage.local);

const storage: ConnectionStorage = {
  getTokenHash: () => keys.get(),
  setTokenHash: (tokenHash) => keys.set(tokenHash),
  async getPort() {
    const { port } = await chrome.storage.local.get('port');
    return Number.isInteger(port) ? (port as number) : null;
  },
  async setPort(port) {
    await chrome.storage.local.set({ port });
  }
};

// A stopped worker has no timers. The alarm wakes it once a minute to reconnect, and only
// runs while paired and disconnected.
const RECONNECT_ALARM = 'reconnect';
const alarm: ReconnectAlarm = {
  set() {
    // create() would restart an existing alarm's period, so only create it once.
    void chrome.alarms.get(RECONNECT_ALARM).then((existing) => {
      if (!existing) void chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
    });
  },
  clear() {
    void chrome.alarms.clear(RECONNECT_ALARM);
  }
};

// The connection lives here, not in the content script, so chatgpt.com's CSP and
// local-network rules never apply and the Origin is chrome-extension://<id>.
const connection = new Connection({
  storage,
  fetch: (input, init) => fetch(input, init),
  createSocket: (url) => new WebSocket(url),
  randomId: () => crypto.randomUUID(),
  alarm
});

const cards = new CardStore(chromeArea(chrome.storage.local));
const sessions = new Sessions(
  chromeArea(chrome.storage.local),
  chromeArea(chrome.storage.session),
  cards
);
void cards.prune();

// Registered at the top level so the alarm can wake a stopped worker.
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === RECONNECT_ALARM) void connection.connect();
});

const extensionPage = chrome.runtime.getURL('');

/**
 * The active tab in the side panel's own window: the one the panel sits next to. Not the
 * last focused window, which may be DevTools or another browser window.
 */
async function activeTabId(windowId: number | null): Promise<number | null> {
  if (windowId === null) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  return tab?.id ?? null;
}

function tellTab(tabId: number, message: TabMessage): Promise<unknown> {
  // frameId 0: only the top frame's content script gets it.
  return chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
}

async function insertIntoChat(tabId: number, text: string): Promise<InsertResult> {
  const result = (await tellTab(tabId, { type: 'insert-text', text })) as InsertResult | undefined;
  return result ?? { ok: false, error: 'no-composer' };
}

/** The chatgpt.com tab next to the side panel, if Bridge can use it. */
async function chatTab(
  windowId: number
): Promise<{ ok: true; tabId: number } | { ok: false; error: SessionError }> {
  if (connection.current !== 'connected') return { ok: false, error: 'not-connected' };
  if (!connection.project) return { ok: false, error: 'no-project' };
  const tabId = await activeTabId(windowId);
  const tab = tabId === null ? null : await sessions.tab(tabId);
  if (tabId === null || !tab) return { ok: false, error: 'no-chat-tab' };
  if (tab.layout !== 'ok') return { ok: false, error: 'layout-unknown' };
  return { ok: true, tabId };
}

async function sessionPrompt(): Promise<
  { ok: true; text: string; total: number; shown: number } | { ok: false; error: SessionError }
> {
  const project = connection.project;
  if (!project) return { ok: false, error: 'no-project' };
  const tree = await connection.request('tree', {});
  if (!tree.ok)
    return { ok: false, error: tree.error.code === 'no-project' ? 'no-project' : 'failed' };
  const { entries, truncated } = tree.result;
  const { total, shown } = summarizeTree(entries);
  return {
    ok: true,
    text: buildSessionPrompt({ projectName: project.name, tree: entries, truncated }),
    total,
    shown
  };
}

async function previewSession(windowId: number): Promise<SessionPreview> {
  const tab = await chatTab(windowId);
  if (!tab.ok) return tab;
  const prompt = await sessionPrompt();
  if (!prompt.ok) return prompt;
  return { ok: true, chars: prompt.text.length, total: prompt.total, shown: prompt.shown };
}

async function startSession(windowId: number): Promise<SessionStartResult> {
  const tab = await chatTab(windowId);
  if (!tab.ok) return tab;
  const prompt = await sessionPrompt();
  if (!prompt.ok) return prompt;
  const inserted = await insertIntoChat(tab.tabId, prompt.text);
  if (!inserted.ok) return inserted;
  await sessions.start(tab.tabId);
  void tellTab(tab.tabId, { type: 'session-changed', session: 'active' });
  return { ok: true, chars: inserted.chars };
}

async function endSession(windowId: number): Promise<void> {
  const tabId = await activeTabId(windowId);
  if (tabId === null) return;
  await sessions.end(tabId);
  void tellTab(tabId, { type: 'session-changed', session: 'ended' });
}

async function sendFiles(paths: string[], windowId: number): Promise<SendFilesResult> {
  const tab = await chatTab(windowId);
  if (!tab.ok) return tab;
  if (!(await sessions.isActive(tab.tabId))) return { ok: false, error: 'no-session' };
  const files: { path: string; content: string }[] = [];
  const refused: { path: string; code: FileErrorCode }[] = [];
  for (const path of paths) {
    const read = await connection.request('read', { path });
    if (read.ok) files.push({ path, content: read.result.content });
    else if (read.error.code === 'not-connected' || read.error.code === 'timeout') {
      return { ok: false, error: 'not-connected' };
    } else if (read.error.code !== 'bad-response' && read.error.code !== 'no-session') {
      refused.push({ path, code: read.error.code });
    }
  }
  if (files.length === 0) return { ok: true, chars: 0, sent: [], refused };
  const text = buildContextMessage(
    files,
    refused.map(({ path, code }) => ({ path, reason: FILE_ERROR_LABELS[code] }))
  );
  const inserted = await insertIntoChat(tab.tabId, text);
  if (!inserted.ok) return inserted;
  const sent = files.map((f) => f.path);
  await sessions.addSent(tab.tabId, sent);
  return { ok: true, chars: inserted.chars, sent, refused };
}

/** File requests from a card in the chat. Refused unless that tab's session is active. */
async function chatFile(
  tabId: number,
  request: WorkerRequestOf<'chat-read' | 'chat-write' | 'chat-undo'>
): Promise<RequestOutcome<unknown>> {
  if (!(await sessions.isActive(tabId))) {
    return { ok: false, error: { code: 'no-session', message: 'No Bridge session in this chat.' } };
  }
  // A card's message may be what woke the worker. Give the connection one try first.
  if (connection.current !== 'connected') await connection.connect();
  switch (request.type) {
    case 'chat-read':
      return connection.request('read', { path: request.path });
    case 'chat-write':
      return connection.request('write', {
        path: request.path,
        content: request.content,
        ...(request.baseHash !== undefined && { baseHash: request.baseHash }),
        source: 'chat'
      });
    case 'chat-undo':
      return connection.request('undo', { opId: request.opId });
  }
}

async function handleChat(
  tabId: number,
  request: WorkerRequestOf<
    'chat-sync' | 'chat-read' | 'chat-write' | 'chat-undo' | 'chat-sent' | 'card-get' | 'card-set'
  >
): Promise<unknown> {
  switch (request.type) {
    case 'chat-sync': {
      void connection.connect();
      const session = await sessions.sync(tabId, request.conversationId, request.layout);
      return { connected: connection.current === 'connected', session } satisfies ChatSyncReply;
    }
    case 'chat-read':
    case 'chat-write':
    case 'chat-undo':
      return chatFile(tabId, request);
    case 'chat-sent':
      await sessions.addSent(tabId, request.paths);
      return null;
    case 'card-get':
      return cards.get(request.keys);
    case 'card-set': {
      // A tab may only record cards for the conversation it has a session in.
      const conversationId = await sessions.activeConversation(tabId);
      if (!conversationId || !request.key.startsWith(`${conversationId}:`)) return false;
      await cards.set(request.key, request.record);
      notifyPanels();
      return true;
    }
  }
}

async function handlePanel(
  request: Exclude<WorkerRequest, WorkerRequestOf<Parameters<typeof handleChat>[1]['type']>>
): Promise<unknown> {
  switch (request.type) {
    case 'get-status':
      void connection.connect();
      return connection.current;
    case 'pair':
      return connection.pair(request.code);
    case 'unpair':
      await connection.unpair();
      return null;
    case 'retry':
      await connection.retry();
      return null;
    case 'session-preview':
      return previewSession(request.windowId);
    case 'session-start':
      return startSession(request.windowId);
    case 'session-end':
      await endSession(request.windowId);
      return null;
    case 'reload-tab': {
      const tabId = await activeTabId(request.windowId);
      if (tabId !== null) await chrome.tabs.reload(tabId).catch(() => undefined);
      return null;
    }
    case 'get-tree':
      return connection.request('tree', {});
    case 'send-files':
      return sendFiles(request.paths, request.windowId);
    case 'dev-file': {
      // The side panel's test field only exists in dev builds, and so does this path.
      if (!import.meta.env.DEV) return undefined;
      const file = request.request;
      return file.type === 'tree'
        ? connection.request('tree', file.payload)
        : file.type === 'read'
          ? connection.request('read', file.payload)
          : file.type === 'write'
            ? connection.request('write', file.payload)
            : connection.request('undo', file.payload);
    }
  }
}

function route(sender: Sender, request: WorkerRequest): Promise<unknown> {
  if (sender.kind === 'chat-tab') {
    return handleChat(sender.tabId, request as Parameters<typeof handleChat>[1]);
  }
  return handlePanel(request as Parameters<typeof handlePanel>[0]);
}

// Side panels: push status, project and the active tab's session on every change.
const panelPushers = new Set<() => void>();
function notifyPanels(): void {
  for (const push of panelPushers) push();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDE_PANEL_PORT || !port.sender?.url?.startsWith(extensionPage)) {
    port.disconnect();
    return;
  }
  let version = 0;
  // Until the panel says which window it's in, it sees no chat tab.
  let windowId: number | null = null;
  port.onMessage.addListener((raw: unknown) => {
    const hello = PanelHello.safeParse(raw);
    if (!hello.success) return;
    windowId = hello.data.windowId;
    push();
  });
  const push = () => {
    const mine = ++version;
    void activeTabId(windowId)
      .then((tabId) => sessions.panelState(tabId))
      .then((chat) => {
        // A slower, older push must not overwrite a newer one.
        if (mine !== version) return;
        port.postMessage({
          type: 'status',
          status: connection.current,
          project: connection.project,
          chat
        } satisfies StatusUpdate);
      })
      .catch(() => undefined);
  };
  push();
  panelPushers.add(push);
  const unsubscribers = [connection.onStatus(push), connection.onProject(push)];
  port.onDisconnect.addListener(() => {
    panelPushers.delete(push);
    unsubscribers.forEach((off) => off());
  });
  // The panel opening is a good moment to try again without waiting out the backoff.
  if (connection.current !== 'connected') void connection.retry();
});

sessions.onChange(notifyPanels);
chrome.tabs.onActivated.addListener(notifyPanels);
chrome.windows.onFocusChanged.addListener(notifyPanels);
chrome.tabs.onRemoved.addListener((tabId) => void sessions.removeTab(tabId));

chrome.runtime.onMessage.addListener((raw: unknown, messageSender, sendResponse) => {
  const sender = classifySender(messageSender, chrome.runtime.id, extensionPage);
  if (!sender) return false;
  const parsed = WorkerRequest.safeParse(raw);
  if (!parsed.success || !isAllowed(sender, parsed.data.type)) return false;
  void route(sender, parsed.data)
    .then(sendResponse)
    .catch(() => sendResponse(undefined));
  return true;
});

void connection.connect();
