// Every assumption about chatgpt.com's markup lives here. The page changes without notice,
// so each lookup has fallbacks, and `checkLayout` reports when the key ones stop matching.

export const SELECTORS = {
  /** Wraps every turn. Observed for changes. */
  conversation: ['main', '[role="main"]'],
  /** One assistant message. Only these are parsed, never user messages. */
  assistantMessage: ['[data-message-author-role="assistant"]'],
  /** Any message, to tell "no messages yet" from "can't find messages". */
  anyMessage: ['[data-message-author-role]'],
  /** One user message. Full auto counts these to see that its send went through. */
  userMessage: ['[data-message-author-role="user"]'],
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
  ],
  /** The composer's send button. Full auto clicks it; nothing else does. */
  sendButton: [
    '[data-testid="send-button"]',
    'button#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'form button[type="submit"]'
  ],
  /**
   * Where the page shows an error or a usage limit. Full auto pauses when one of these is
   * visible and its text reads like an error (`ERROR_TEXT`). Best guesses from the page's
   * markup; check them against the live site (see the fixtures README).
   */
  errorBanner: [
    '[data-testid="conversation-error"]',
    '[data-testid*="error-message"]',
    '.text-token-text-error',
    '[class*="text-red"]',
    '[role="alert"]'
  ]
} as const;

/** Text that marks an error or limit banner, so a stray red element doesn't pause the loop. */
export const ERROR_TEXT =
  /something went wrong|error (?:in|generating|occurred)|network error|you['’]ve reached|usage (?:limit|cap)|rate limit|too many requests|try again later|message (?:limit|cap)/i;

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

export function findSendButton(doc: Document = document): HTMLButtonElement | null {
  const found = first(doc, SELECTORS.sendButton);
  return found instanceof HTMLButtonElement ? found : null;
}

export function userMessageCount(doc: Document = document): number {
  const root = findConversation(doc) ?? doc;
  return all(root, SELECTORS.userMessage).length;
}

/** The text of a visible error or limit banner, or null. */
export function pageError(doc: Document = document): string | null {
  for (const selector of SELECTORS.errorBanner) {
    for (const element of doc.querySelectorAll(selector)) {
      if (element.closest(`[${BRIDGE_HOST_ATTRIBUTE}]`)) continue;
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text && ERROR_TEXT.test(text)) return text.slice(0, 200);
    }
  }
  return null;
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
