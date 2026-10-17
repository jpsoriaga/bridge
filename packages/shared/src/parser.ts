import type { FileEdit } from './types';

/**
 * A marker line: `@@FILE path@@`, `@@READ path@@`, `@@CONTEXT path@@` or `@@RUN command@@`.
 * Checked after removing inline-code backticks and a list bullet, so `` `@@FILE a.ts@@` ``
 * and `- @@READ a.ts@@` both count.
 */
const MARKER = /^@@(FILE|READ|CONTEXT|RUN)\s+((?:(?!@@)[^`])+?)\s*@@$/;
/** `@@DONE@@`: the chat says the task is finished. Ends a Full auto run. */
const DONE = /^@@DONE\s*@@$/;
const FENCE_OPEN = /^(`{3,}|~{3,})[^`]*$/;
const BULLET = /^(?:[-*+]|\d{1,3}[.)])\s+/;
/** A line made only of `@@READ path@@` markers, for when line breaks were lost. */
const READ_LINE = /^(?:`*@@READ\s+[^@`]+?\s*@@`*[\s,]*)+$/;
const READ_EACH = /@@READ\s+([^@`]+?)\s*@@/g;
/** How many blank lines may sit between a marker and its fence. */
const MAX_GAP = 2;

/** One `@@FILE` block, as parsed. */
export interface ParsedEdit extends FileEdit {
  /**
   * The content has a placeholder such as `// ...rest unchanged` or `// existing code`,
   * so it's probably not the whole file.
   */
  suspectedPartial: boolean;
  /** Which fenced block in the text holds the content, counting every fence from 0. */
  fence: number;
}

export interface ChatParse {
  /** Whole-file edits, in order. */
  edits: ParsedEdit[];
  /** Paths the chat asked to see with `@@READ path@@`, without repeats, in order. */
  reads: string[];
  /**
   * Commands the chat asked to run with `@@RUN command@@`, one per marker, as written and
   * without repeats, in order. Turning them into argv (and refusing shell syntax) is
   * `parseCommand`'s job; allowing them is the desktop's.
   */
  runs: string[];
  /** The reply has a `@@DONE@@` line. */
  done: boolean;
}

type Marker = { kind: 'FILE' | 'READ' | 'CONTEXT' | 'RUN'; path: string };

/** The line without a list bullet and inline-code backticks around the whole of it. */
function unwrap(line: string): string {
  const text = line.trim().replace(BULLET, '');
  const code = /^(`+)(.*)\1$/.exec(text);
  return code ? (code[2] ?? '').trim() : text;
}

function markerOf(line: string): Marker | null {
  const match = MARKER.exec(unwrap(line));
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1] as Marker['kind'], path: match[2] };
}

function readsOn(line: string): string[] {
  if (!READ_LINE.test(line)) return [];
  return [...line.matchAll(READ_EACH)].map((match) => (match[1] ?? '').trim()).filter(Boolean);
}

function isClosingFence(line: string, fence: string): boolean {
  const char = fence.charAt(0);
  return line.length >= fence.length && [...line].every((c) => c === char);
}

/** Lines of the fenced block opening at `open`, and the index of its closing line. */
function readFence(lines: string[], open: number): { body: string[]; close: number } | null {
  const fence = FENCE_OPEN.exec(lines[open]?.trim() ?? '')?.[1];
  if (!fence) return null;
  const body: string[] = [];
  for (let j = open + 1; j < lines.length; j += 1) {
    const line = lines[j] ?? '';
    if (isClosingFence(line.trim(), fence)) return { body, close: j };
    body.push(line);
  }
  return null;
}

/**
 * Parses chat text (an assistant message, as `messageToText` in the extension renders it,
 * or the raw markdown) in this format:
 *
 *   `@@FILE relative/path.ts@@`
 *   ```ts
 *   ...the whole file...
 *   ```
 *
 *   `@@READ relative/path.ts@@`
 *   `@@RUN pnpm test@@`
 *   `@@DONE@@`
 *
 * The marker may be plain or in inline code, and the fence may follow it after up to two
 * blank lines. A fence closes on a line of the same character at least as long as the
 * opener, so a file that contains ``` can be wrapped in ````. A fence that never closes
 * ends parsing: that's a reply still streaming or cut off. Fences without a marker, and
 * `@@CONTEXT` blocks (files sent to the chat), are skipped, so a marker line inside them
 * (an example, or a file that mentions `@@RUN`) is never an edit, a request or a command.
 * Paths and commands are returned as written; checking them is the desktop's job.
 */
export function parseChat(text: string): ChatParse {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const edits: ParsedEdit[] = [];
  const reads: string[] = [];
  const runs: string[] = [];
  let done = false;
  let fences = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const marker = markerOf(line);

    const requested =
      marker?.kind === 'READ' ? [marker.path] : readsOn(line.trim().replace(BULLET, ''));
    if (requested.length > 0) {
      for (const path of requested) if (!reads.includes(path)) reads.push(path);
      i += 1;
      continue;
    }

    if (marker?.kind === 'RUN') {
      if (!runs.includes(marker.path)) runs.push(marker.path);
      i += 1;
      continue;
    }

    if (DONE.test(unwrap(line))) {
      done = true;
      i += 1;
      continue;
    }

    if (marker) {
      let open = i + 1;
      while (open < lines.length && open - i <= MAX_GAP && !lines[open]?.trim()) open += 1;
      if (!FENCE_OPEN.test(lines[open]?.trim() ?? '')) {
        // A marker with no fence after it isn't a block. Ignore the line.
        i += 1;
        continue;
      }
      const block = readFence(lines, open);
      if (!block) break;
      if (marker.kind === 'FILE') {
        const content = block.body.length > 0 ? `${block.body.join('\n')}\n` : '';
        edits.push({
          path: marker.path,
          content,
          suspectedPartial: looksPartial(content),
          fence: fences
        });
      }
      fences += 1;
      i = block.close + 1;
      continue;
    }

    if (FENCE_OPEN.test(line.trim())) {
      const block = readFence(lines, i);
      if (!block) break;
      fences += 1;
      i = block.close + 1;
      continue;
    }

    i += 1;
  }

  return { edits, reads, runs, done };
}

/** The `@@FILE` edits in `text`. See `parseChat`. */
export function parseFileBlocks(text: string): ParsedEdit[] {
  return parseChat(text).edits;
}

/** A line that is only a comment, in most languages. Placeholders hide in these. */
const COMMENT = /^\s*(?:\/\/|\/\*|\{\/\*|\*|#|--|;|<!--|%)\s*(.*)$/;
const PLACEHOLDERS = [
  // "// ...", "# … (rest unchanged)", "/* ... */"
  /^(?:\.{3}|…)/,
  /(?:\.{3}|…)\s*rest\b/i,
  /\bexisting code\b/i,
  /\brest of (?:the )?(?:file|code|component|function|class|module|implementation)\b/i,
  /\b(?:remains?|stays?|is|are) (?:unchanged|the same)\b/i
];

/**
 * True if any comment line looks like a placeholder for code the chat left out. Only
 * comments are checked, so `const { a, ...rest } = b` and Python's `...` don't count.
 */
export function looksPartial(content: string): boolean {
  for (const line of content.split('\n')) {
    const comment = COMMENT.exec(line)?.[1];
    if (comment !== undefined && PLACEHOLDERS.some((re) => re.test(comment))) return true;
  }
  return false;
}
