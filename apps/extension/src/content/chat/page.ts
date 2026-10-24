import { attachmentFiles } from './cards/read-card';
import { attachToComposer, insertIntoComposer } from './composer';
import type { LoopPage } from './loop';
import {
  assistantMessages,
  conversationIdFrom,
  findComposer,
  findContinueButton,
  findConversation,
  findSendButton,
  findStopButton,
  messageBody,
  pageError,
  replyStatus,
  userMessageCount
} from './selectors';

/** The newest assistant message on the page, or null. */
export function newestReply(doc: Document = document): Element | null {
  return assistantMessages(findConversation(doc) ?? doc).at(-1) ?? null;
}

/** Clicks a page button if it's there and enabled. */
function press(button: HTMLButtonElement | null): boolean {
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
  button.click();
  return true;
}

/**
 * The live chat page for the Full auto loop. Sending is a click on the page's own send
 * button, the same thing a person does; nothing else in Bridge ever sends. The stop and
 * Continue generating buttons are pressed only to catch up with a reply after sleep.
 */
export const livePage: LoopPage = {
  conversationId: () => conversationIdFrom(location.href),
  userTurns: () => userMessageCount(),
  composerText: () => {
    const composer = findComposer();
    if (!composer) return '';
    return composer instanceof HTMLTextAreaElement ? composer.value : (composer.textContent ?? '');
  },
  insert: (text) => insertIntoComposer(text),
  attach: (images) => attachToComposer(attachmentFiles(images)).ok,
  submit: () => press(findSendButton()),
  error: () => pageError(),
  replyStatus: () => {
    const reply = newestReply();
    return reply ? replyStatus(reply, document, true) : 'none';
  },
  replyLength: () => {
    const reply = newestReply();
    return reply ? (messageBody(reply).textContent ?? '').length : 0;
  },
  stopReply: () => press(findStopButton()),
  continueReply: () => press(findContinueButton()),
  online: () => navigator.onLine
};
