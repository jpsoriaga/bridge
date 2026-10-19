import type { SessionError, WorkerRequest } from '../messages';

/** Sends a request to the service worker. */
export function request<R>(message: WorkerRequest): Promise<R> {
  return chrome.runtime.sendMessage<WorkerRequest, R>(message);
}

let windowId: Promise<number> | null = null;

/** The window this side panel belongs to. Its active tab is the chat the panel acts on. */
export function panelWindowId(): Promise<number> {
  windowId ??= chrome.windows.getCurrent().then((w) => w.id ?? chrome.windows.WINDOW_ID_NONE);
  return windowId;
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

const SESSION_ERRORS: Record<SessionError, string> = {
  'not-connected': 'The Bridge app isn’t connected.',
  'no-project': 'Open a project folder in the Bridge app first.',
  'no-chat-tab':
    'Open a chat in this tab (reload it if it was open before Bridge), then try again.',
  'layout-unknown': 'Bridge can’t read this page layout.',
  'no-composer': 'Bridge can’t find the message box on this page.',
  'not-inserted': 'Bridge couldn’t insert the text. Click in the message box and try again.',
  'no-session': 'Start a session first.',
  failed: 'Something went wrong. Try again.'
};

export const sessionErrorText = (error: SessionError) => SESSION_ERRORS[error];

/** " N likely secrets were replaced with [redacted]." when any were, else nothing. */
export const redactedText = (count: number): string =>
  count > 0
    ? ` ${count} likely ${count === 1 ? 'secret was' : 'secrets were'} replaced with [redacted].`
    : '';
