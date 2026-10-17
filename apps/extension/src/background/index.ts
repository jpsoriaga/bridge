import {
  CONTENT_SCRIPT_REQUESTS,
  SIDE_PANEL_PORT,
  WorkerRequest,
  type StatusUpdate
} from '../messages';
import { Connection, type ConnectionStorage, type ReconnectAlarm } from './connection';
import { sha256Hex } from './proof';

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const storage: ConnectionStorage = {
  async getTokenHash() {
    const { tokenHash, token } = await chrome.storage.local.get(['tokenHash', 'token']);
    if (typeof tokenHash === 'string') return tokenHash;
    // Phase 2 stored the raw token. Swap it for its hash once, then forget it.
    if (typeof token === 'string') {
      const hash = await sha256Hex(token);
      await chrome.storage.local.set({ tokenHash: hash });
      await chrome.storage.local.remove('token');
      return hash;
    }
    return null;
  },
  async setTokenHash(tokenHash) {
    if (tokenHash === null) await chrome.storage.local.remove(['tokenHash', 'token']);
    else await chrome.storage.local.set({ tokenHash });
  },
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

// Registered at the top level so the alarm can wake a stopped worker.
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === RECONNECT_ALARM) void connection.connect();
});

const extensionPage = chrome.runtime.getURL('');

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SIDE_PANEL_PORT || !port.sender?.url?.startsWith(extensionPage)) {
    port.disconnect();
    return;
  }
  const push = (status: StatusUpdate['status']) =>
    port.postMessage({ type: 'status', status } satisfies StatusUpdate);
  push(connection.current);
  const unsubscribe = connection.onStatus(push);
  port.onDisconnect.addListener(unsubscribe);
  // The panel opening is a good moment to try again without waiting out the backoff.
  if (connection.current !== 'connected') void connection.retry();
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = WorkerRequest.safeParse(raw);
  if (!parsed.success) return false;
  const request = parsed.data;
  // Anything not from our own pages is the content script on chatgpt.com: it may only
  // read status.
  const fromExtensionPage = sender.url?.startsWith(extensionPage) ?? false;
  if (!fromExtensionPage && !CONTENT_SCRIPT_REQUESTS.has(request.type)) return false;

  switch (request.type) {
    case 'get-status':
      void connection.connect();
      sendResponse(connection.current);
      return false;
    case 'pair':
      void connection.pair(request.code).then(sendResponse);
      return true;
    case 'unpair':
      void connection.unpair().then(() => sendResponse(null));
      return true;
    case 'retry':
      void connection.retry().then(() => sendResponse(null));
      return true;
  }
});

void connection.connect();
