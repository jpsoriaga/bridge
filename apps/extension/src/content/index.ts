import { parseFileBlocks, type ConnectionStatus } from '@bridge/shared';
import type { WorkerRequest } from '../messages';

console.log('[Bridge] content script loaded');

// Proves the shared parser is bundled into the content script. Real DOM scanning is Phase 3.
parseFileBlocks('');

// The content script never talks to the desktop itself. It asks the service worker.
void chrome.runtime
  .sendMessage<WorkerRequest, ConnectionStatus>({ type: 'get-status' })
  .then((status) => console.log('[Bridge] status:', status))
  .catch(() => console.log('[Bridge] status: unavailable'));
