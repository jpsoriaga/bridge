// Every assumption about chatgpt.com's markup lives here. The page changes without notice,
// so each lookup has fallbacks, and `checkLayout` reports when the key ones stop matching.

export const SELECTORS = {
  /** Wraps every turn. Observed for changes. */
  conversation: ['main', '[role="main"]'],
  /** One assistant message. Only these are parsed, never user messages. */
  assistantMessage: ['[data-message-author-role="assistant"]'],
  /** Any message, to tell "no messages yet" from "can't find messages". */
  anyMessage: ['[data-message-author-role]'],
  /** One turn (a user or assistant message plus its action buttons). */
  turn: [
    'article[data-testid^="conversation-turn-"]',
    '[data-testid^="conversation-turn-"]',
    'article'
  ],
  /** The rendered markdown inside a message. */
  markdown: ['.markdown', '[class*="markdown"]'],
  /** Present on a message while it streams. */
  streaming: ['.result-streaming', '[data-is-streaming="true"]', '.streaming-animation'],
  /** The page's stop button, shown while any reply streams. */
  stopButton: ['[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]'],
  /** Copy / thumbs buttons under a finished reply. */
  turnActions: [
    '[data-testid="copy-turn-action-button"]',
    '[data-testid="good-response-turn-action-button"]',
    '[data-testid="voice-play-turn-action-button"]',
    'button[aria-label="Copy"]'
  ],
  /** The ProseMirror composer, or the older textarea. */
  composer: [
    '#prompt-textarea[contenteditable="true"]',
    'div.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][data-virtualkeyboard="true"]',
    'textarea#prompt-textarea',
    'form textarea'
  ]
} as const;

/** The message element's own id attribute. Falls back to the position on the page. */
export const MESSAGE_ID_ATTRIBUTE = 'data-message-id';

/** Marks Bridge's own injected hosts so the adapter and observer skip them. */
export const BRIDGE_HOST_ATTRIBUTE = 'data-bridge-host';

export function first(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  return null;
}

export function all(root: ParentNode, selectors: readonly string[]): Element[] {
  for (const selector of selectors) {
    const found = root.querySelectorAll(selector);
    if (found.length > 0) return [...found];
  }
  return [];
}

export function closest(element: Element, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    const found = element.closest(selector);
    if (found) return found;
  }
  return null;
}

export function findConversation(doc: Document = document): Element | null {
  return first(doc, SELECTORS.conversation);
}

export function findComposer(doc: Document = document): HTMLElement | null {
  const found = first(doc, SELECTORS.composer);
  return found instanceof HTMLElement ? found : null;
}

export function assistantMessages(root: ParentNode): Element[] {
  return all(root, SELECTORS.assistantMessage);
}

/** The message's id, or its position among assistant messages if it has none. */
export function messageIdOf(message: Element, index: number): string {
  const id = message.getAttribute(MESSAGE_ID_ATTRIBUTE);
  return id && /^[\w-]{1,128}$/.test(id) ? id : `pos-${index}`;
}

/** The element to walk for a message's text: its markdown body, or the message itself. */
export function messageBody(message: Element): Element {
  return first(message, SELECTORS.markdown) ?? message;
}

/**
 * A message is finished when nothing marks it as streaming and its turn shows the action
 * buttons. If the page no longer has any action buttons we can recognise, fall back to
 * "no stop button on the page".
 */
export function isMessageComplete(message: Element, doc: Document = document): boolean {
  if (closest(message, SELECTORS.streaming) || first(message, SELECTORS.streaming)) return false;
  const turn = closest(message, SELECTORS.turn);
  if (turn && first(turn, SELECTORS.turnActions)) return true;
  if (first(doc, SELECTORS.turnActions)) return false;
  return first(doc, SELECTORS.stopButton) === null;
}

export type LayoutHealth = 'ok' | 'unknown';

/**
 * `unknown` when a chat page has turns or a composer slot but the selectors Bridge relies
 * on find nothing. `ok` before a conversation has messages, as long as the composer is found.
 */
export function checkLayout(doc: Document = document): LayoutHealth {
  if (!findConversation(doc) || !findComposer(doc)) return 'unknown';
  const turns = all(doc, SELECTORS.turn).length;
  if (turns > 0 && all(doc, SELECTORS.anyMessage).length === 0) return 'unknown';
  return 'ok';
}

/** The conversation id from `/c/<id>` (also under `/g/<gpt>/c/<id>`), or null. */
export function conversationIdFrom(url: string): string | null {
  try {
    const match = /\/c\/([A-Za-z0-9-]{8,64})(?:\/|$)/.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
