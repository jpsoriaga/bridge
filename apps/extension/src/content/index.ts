import { parseFileBlocks } from '@bridge/shared';

console.log('[Bridge] content script loaded');

// Proves the shared parser is bundled into the content script. Real DOM scanning is Phase 3.
parseFileBlocks('');
