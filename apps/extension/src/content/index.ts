import { base64ToBytes } from '../binary';
import { TabMessage, type AttachResult, type InsertResult } from '../messages';
import { attachToComposer, insertIntoComposer } from './chat/composer';
import { ChatController, createAskWorker } from './chat/controller';

// The content script holds no secrets and never talks to the desktop. File reads and
// writes go through the service worker, which checks this tab has an active session.
// If the extension is reloaded or updated, this script can't reach it any more: the
// controller takes its UI off the page and asks for a reload.
const controller: ChatController = new ChatController(
  createAskWorker(() => controller.invalidate())
);
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
    case 'bridge-config':
      controller.setConfig(message.config);
      return false;
    case 'run-output':
      controller.runEvent(message.runId, { type: 'output', chunk: message.chunk });
      return false;
    case 'run-exit':
      controller.runEvent(message.result.runId, { type: 'exit', result: message.result });
      return false;
    case 'loop-control':
      controller.loopControl(message.action);
      return false;
    case 'files-changed':
      controller.filesChanged(message.paths, message.overflow);
      return false;
    case 'reveal-request':
      controller.reveal(message.id);
      return false;
    case 'locate':
      sendResponse(controller.locate());
      return false;
    case 'diagnose':
      sendResponse(controller.diagnose());
      return false;
    case 'attach-files': {
      const files = message.files.map(
        ({ name, mime, data }) => new File([base64ToBytes(data)], name, { type: mime })
      );
      sendResponse(attachToComposer(files) satisfies AttachResult);
      return false;
    }
    default:
      return false;
  }
});
