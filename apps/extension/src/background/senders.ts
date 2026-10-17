import { CONTENT_SCRIPT_REQUESTS, EXTENSION_PAGE_REQUESTS, type WorkerRequest } from '../messages';

export const CHAT_ORIGIN = 'https://chatgpt.com';

export type Sender =
  | { kind: 'extension-page' }
  /** The content script in the top frame of a chatgpt.com tab. */
  | { kind: 'chat-tab'; tabId: number };

/**
 * Who sent a `chrome.runtime` message. Only two senders count: the extension's own pages
 * (the side panel), and the content script in the top frame of an https://chatgpt.com tab.
 * Anything else, including another extension or a chatgpt.com subframe, is null.
 */
export function classifySender(
  sender: chrome.runtime.MessageSender,
  runtimeId: string,
  extensionOrigin: string
): Sender | null {
  if (sender.id !== runtimeId || typeof sender.url !== 'string') return null;
  // `extensionOrigin` ends in "/", so this can't match a longer lookalike id.
  if (sender.url.startsWith(extensionOrigin)) return { kind: 'extension-page' };
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  const tabId = sender.tab?.id;
  if (url.origin === CHAT_ORIGIN && typeof tabId === 'number' && (sender.frameId ?? 0) === 0) {
    return { kind: 'chat-tab', tabId };
  }
  return null;
}

/** Whether `sender` may make `request`. Content scripts get only the chat requests. */
export function isAllowed(sender: Sender, type: WorkerRequest['type']): boolean {
  return sender.kind === 'extension-page'
    ? EXTENSION_PAGE_REQUESTS.has(type)
    : CONTENT_SCRIPT_REQUESTS.has(type);
}
