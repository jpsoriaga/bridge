import { insertIntoComposer } from './composer';
import type { LoopPage } from './loop';
import {
  conversationIdFrom,
  findComposer,
  findSendButton,
  pageError,
  userMessageCount
} from './selectors';

/**
 * The live chat page for the Full auto loop. Sending is a click on the page's own send
 * button, the same thing a person does; nothing else in Bridge ever sends.
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
  submit: () => {
    const button = findSendButton();
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;
  },
  error: () => pageError()
};
