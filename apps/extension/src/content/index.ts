import { TabMessage, type InsertResult } from '../messages';
import { insertIntoComposer } from './chat/composer';
import { askWorker, ChatController } from './chat/controller';

// The content script holds no secrets and never talks to the desktop. File reads and
// writes go through the service worker, which checks this tab has an active session.
const controller = new ChatController(askWorker);
controller.start();

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  // Only the extension's own service worker (no tab) may drive the page.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  const parsed = TabMessage.safeParse(raw);
  if (!parsed.success) return false;
  const message = parsed.data;
  switch (message.type) {
    case 'insert-text':
      sendResponse(insertIntoComposer(message.text) satisfies InsertResult);
      return false;
    case 'session-changed':
      controller.setSession(message.session);
      sendResponse(null);
      return false;
  }
});
