import { structuredPatch } from 'diff';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its `+`/`-`/space prefix, or the `@@ … @@` header for a hunk. */
  text: string;
}

export interface FileDiff {
  /** `new`: no file there yet. `unchanged`: same text once line endings are ignored. */
  status: 'new' | 'modified' | 'unchanged';
  added: number;
  removed: number;
  /** A unified diff with 3 lines of context, hunk headers included. */
  lines: DiffLine[];
}

const CONTEXT_LINES = 3;
/** Past this the diff gives up and shows the whole file replaced. */
const DIFF_TIMEOUT_MS = 1_000;

const toLf = (text: string) => text.replace(/\r\n?/g, '\n');

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Every line of `text` with one kind, for a create or a diff that timed out. */
function allLines(text: string, kind: 'add' | 'del'): DiffLine[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => ({ kind, text: line }));
}

/**
 * Compares a proposed whole file with what's on disk. `before` is null when the file
 * doesn't exist. Line endings are normalised first: the desktop keeps a file's own EOL
 * style when it writes, so CRLF vs LF alone is never a change.
 */
export function diffFile(before: string | null, after: string): FileDiff {
  const next = toLf(after);
  if (before === null) {
    return { status: 'new', added: lineCount(next), removed: 0, lines: allLines(next, 'add') };
  }
  const prev = toLf(before);
  if (prev === next) return { status: 'unchanged', added: 0, removed: 0, lines: [] };

  const patch = structuredPatch('a', 'b', prev, next, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS
  });
  if (!patch) {
    const lines = [...allLines(prev, 'del'), ...allLines(next, 'add')];
    return { status: 'modified', added: lineCount(next), removed: lineCount(prev), lines };
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    lines.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
    });
    for (const line of hunk.lines) {
      const prefix = line.charAt(0);
      const text = line.slice(1);
      if (prefix === '+') {
        added += 1;
        lines.push({ kind: 'add', text });
      } else if (prefix === '-') {
        removed += 1;
        lines.push({ kind: 'del', text });
      } else if (prefix === ' ') {
        lines.push({ kind: 'ctx', text });
      }
      // "\ No newline at end of file" is dropped: the counts already show the change.
    }
  }
  return { status: 'modified', added, removed, lines };
}
