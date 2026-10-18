/**
 * `next` with the trailing newline `current` has: a file that ended without one keeps
 * ending without one, and one that ended with one keeps it. The chat format always ends a
 * block's content with a newline, so without this every write would add one. A new or
 * empty file (`current` null or '') takes `next` as it is.
 */
export function matchTrailingNewline(next: string, current: string | null): string {
  if (current === null || current === '' || next === '') return next;
  const had = current.endsWith('\n');
  const has = next.endsWith('\n');
  if (had && !has) return `${next}\n`;
  if (!had && has) return next.endsWith('\r\n') ? next.slice(0, -2) : next.slice(0, -1);
  return next;
}

/** Content with a NUL character can't be a text file Bridge writes. */
export const looksBinary = (content: string): boolean => content.includes('\u0000');
