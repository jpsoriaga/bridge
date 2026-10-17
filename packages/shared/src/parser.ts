import type { FileEdit } from './types';

const HEADER = /^@@FILE\s+(.+?)\s*@@\s*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})[^`]*$/;

/**
 * Extracts whole-file edits from assistant output in this format:
 *
 *   @@FILE relative/path.ts@@
 *   ```ts
 *   ...full file contents...
 *   ```
 *
 * The fence must start on the line after the header. It closes on a line made of
 * the same fence character, at least as long as the opener, so a file that itself
 * contains ``` can be wrapped in ````. Blocks whose fence never closes are ignored.
 * Paths are returned as written; validating them is the desktop app's job.
 */
export function parseFileBlocks(text: string): FileEdit[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const edits: FileEdit[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = HEADER.exec(lines[i]?.trim() ?? '');
    const open = header ? FENCE_OPEN.exec(lines[i + 1]?.trim() ?? '') : null;
    if (!header?.[1] || !open?.[1]) {
      i += 1;
      continue;
    }

    const fence = open[1];
    const body: string[] = [];
    let j = i + 2;
    let closed = false;
    for (; j < lines.length; j += 1) {
      const line = lines[j] ?? '';
      if (isClosingFence(line.trim(), fence)) {
        closed = true;
        break;
      }
      body.push(line);
    }

    if (!closed) break;
    edits.push({ path: header[1], content: body.length > 0 ? `${body.join('\n')}\n` : '' });
    i = j + 1;
  }

  return edits;
}

function isClosingFence(line: string, fence: string): boolean {
  const char = fence.charAt(0);
  return line.length >= fence.length && [...line].every((c) => c === char);
}
