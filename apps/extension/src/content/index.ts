import { parseFileBlocks, type ParsedFileChange } from '@bridge/shared';

console.log('[Bridge Extension] Content script active');

/**
 * Scans page DOM for text content containing @@FILE blocks.
 */
export function scanPageForFileBlocks(): ParsedFileChange[] {
  const codeElements = document.querySelectorAll('pre, code, .markdown, [class*="message"]');
  const allChanges: ParsedFileChange[] = [];
  const seenPaths = new Set<string>();

  codeElements.forEach((el) => {
    const text = el.textContent || '';
    if (text.includes('@@FILE')) {
      const parsed = parseFileBlocks(text);
      for (const change of parsed.changes) {
        if (!seenPaths.has(change.path)) {
          seenPaths.add(change.path);
          allChanges.push(change);
        }
      }
    }
  });

  return allChanges;
}

// Listen for scan requests from popup
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'SCAN_BLOCKS') {
    const changes = scanPageForFileBlocks();
    sendResponse({ changes });
    return true;
  }
  return false;
});
