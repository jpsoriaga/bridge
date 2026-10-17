import {
  CONTENT_SCRIPT_REQUESTS,
  SIDE_PANEL_PORT,
  WorkerRequest,
  type StatusUpdate
} from '../messages';
import { Connection, type ConnectionStorage } from './connection';

// Clicking the toolbar icon opens the side panel.
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

const storage: ConnectionStorage = {
  async getToken() {
    const { token } = await chrome.storage.local.get('token');
    return typeof token === 'string' ? token : null;
  },
  async setToken(token) {
    if (token === null) await chrome.storage.local.remove('token');
    else await chrome.storage.local.set({ token });
  },
  async getPort() {
    const { port } = await chrome.storage.local.get('port');
    return Number.isInteger(port) ? (port as number) : null;
  },
  async setPort(port) {
    await chrome.storage.local.set({ port });
  }
};

// The connection lives here, not in the content script, so chatgpt.com's CSP and
// local-network rules never apply and the Origin is chrome-extension://<id>.
const connection = new Connection({
  storage,
  fetch: (input, init) => fetch(input, init),
  createSocket: (url) => new WebSocket(url),
  randomId: () => crypto.randomUUID()
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
