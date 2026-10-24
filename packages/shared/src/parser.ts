import type { FileEdit } from './types';

/**
 * A marker line: `@@FILE path@@`, `@@READ path@@`, `@@CONTEXT path@@`, `@@RUN command@@`,
 * `@@START command@@`, `@@STOP command@@`, `@@LOGS command@@` or `@@ASSET path@@`.
 * Checked after removing inline-code backticks and a list bullet, so `` `@@FILE a.ts@@` ``
 * and `- @@READ a.ts@@` both count.
 */
const MARKER =
  /^@@(FILE|READ|CONTEXT|RUN|START|STOP|LOGS|ASSET)\s+((?!@@)[^\s`](?:(?!@@)[^`])*?)\s*@@$/;
/** `@@DONE@@`: the chat says the task is finished. Ends a Full auto run. */
const DONE = /^@@DONE\s*@@$/;
/** `@@DELETE path@@`: remove a file. No fence follows. */
const DELETE = /^@@DELETE\s+((?!@@)[^\s`](?:(?!@@)[^`])*?)\s*@@$/;
/** `@@RENAME old/path -> new/path@@` (or `→`): move a file. No fence follows. */
const RENAME =
  /^@@RENAME\s+((?!@@)[^\s`](?:(?!@@|->|→)[^`])*?)\s*(?:->|→)\s*([^\s`](?:(?!@@)[^`])*?)\s*@@$/;
/** `@@DOWNLOAD https://… -> public/logo.svg@@` (or `→`): fetch a file into the project. */
const DOWNLOAD =
  /^@@DOWNLOAD\s+((?!@@)[^\s`](?:(?!@@|->|→)[^`\s])*?)\s*(?:->|→)\s*([^\s`](?:(?!@@)[^`])*?)\s*@@$/;
/**
 * The same markers with the closing `@@` missing (or half there), as the chat sometimes
 * writes them: `` `@@RUN npm test` ``. Only tried inside an inline-code span that holds
 * nothing else, so prose that happens to start with `@@` never counts.
 */
const LOOSE_MARKER =
  /^@@(FILE|READ|RUN|START|STOP|LOGS|ASSET)\s+((?!@@|@$)[^\s`](?:(?!@@)[^`])*?)\s*@?$/;
const LOOSE_DONE = /^@@DONE\s*@?$/;
const LOOSE_DELETE = /^@@DELETE\s+((?!@@|@$)[^\s`](?:(?!@@)[^`])*?)\s*@?$/;
const LOOSE_RENAME =
  /^@@RENAME\s+((?!@@|@$)[^\s`](?:(?!@@|->|→)[^`])*?)\s*(?:->|→)\s*((?!@$)[^\s`](?:(?!@@)[^`])*?)\s*@?$/;
const LOOSE_DOWNLOAD =
  /^@@DOWNLOAD\s+((?!@@|@$)[^\s`](?:(?!@@|->|→)[^`\s])*?)\s*(?:->|→)\s*((?!@$)[^\s`](?:(?!@@)[^`])*?)\s*@?$/;
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
  /** The marker was missing its closing `@@`; Bridge read it anyway. */
  formatFixed?: true;
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
  /** Files to delete with `@@DELETE path@@`, without repeats, in order. */
  deletes: string[];
  /** Files to move with `@@RENAME from -> to@@`, without repeats, in order. */
  renames: FileRename[];
  /** Background commands to start with `@@START command@@`, as written, without repeats. */
  starts: string[];
  /** Background commands to stop with `@@STOP command@@`. */
  stops: string[];
  /** Background commands whose recent log the chat asked for with `@@LOGS command@@`. */
  logs: string[];
  /**
   * Where to save images the chat made, `@@ASSET path@@`, in order. The n-th one goes with
   * the n-th image in the reply.
   */
  assets: string[];
  /** Files to fetch with `@@DOWNLOAD url -> path@@`, without repeats, in order. */
  downloads: FileDownload[];
  /**
   * Markers Bridge read although their closing `@@` was missing. Their cards say "format
   * fixed". Edits carry `formatFixed` themselves.
   */
  fixed: FixedMarkers;
  /** Lines that look meant for Bridge but that it couldn't read. See `FormatIssue`. */
  issues: FormatIssue[];
  /**
   * Every marker Bridge read, in the reply's order and in its strict form
   * (`@@FILE src/app.ts@@`, `@@RUN npm test@@`). A FILE marker counts once its block closed.
   */
  markers: string[];
  /** A `@@FILE` marker whose code block never closed (a reply cut off mid-file), or null. */
  unclosed: string | null;
  /** Nothing but blank lines follows the last `@@FILE` block. */
  endsInBlock: boolean;
}

export interface FixedMarkers {
  reads: string[];
  runs: string[];
  deletes: string[];
  renames: FileRename[];
  starts: string[];
  stops: string[];
  logs: string[];
  assets: string[];
  downloads: FileDownload[];
  done: boolean;
}

/**
 * Something in a reply that looks meant for Bridge but isn't in its format:
 * - `bad-marker`: a marker with a typo (`@@RUNS`, `@@ FILE`, `@RUN`, lower case), one that
 *   isn't on its own line, or a plain one missing its closing `@@`
 * - `no-marker`: a code block with a file path just above it but no `@@FILE` marker
 * - `no-block`: a `@@FILE` marker with no code block after it
 * - `placeholder`: an edit with a "rest unchanged"-style comment in it
 */
export type FormatIssueKind = 'bad-marker' | 'no-marker' | 'no-block' | 'placeholder';

export interface FormatIssue {
  kind: FormatIssueKind;
  /** The line (or, for a placeholder, the path) it's about, cut to 120 characters. */
  text: string;
}

export interface FileRename {
  from: string;
  to: string;
}

export interface FileDownload {
  url: string;
  path: string;
}

type MarkerKind = 'FILE' | 'READ' | 'CONTEXT' | 'RUN' | 'START' | 'STOP' | 'LOGS' | 'ASSET';
type Marker = { kind: MarkerKind; path: string; fixed?: true };

/** One-line markers that name a command or a path and take no block. */
const LINE_MARKERS = ['RUN', 'START', 'STOP', 'LOGS', 'ASSET'] as const;
type LineMarker = (typeof LINE_MARKERS)[number];

/** The inline-code span that is the whole line (bar a list bullet), or null. */
function codeSpan(line: string): string | null {
  const code = /^(`+)(.*)\1$/.exec(line.trim().replace(BULLET, ''));
  return code ? (code[2] ?? '').trim() : null;
}

/** The line without a list bullet and inline-code backticks around the whole of it. */
function unwrap(line: string): string {
  return codeSpan(line) ?? line.trim().replace(BULLET, '');
}

/**
 * A marker on its own line, or, inside an inline-code span, one missing its closing `@@`
 * (`fixed`). `@@CONTEXT` is Bridge's own, so it's never read loosely.
 */
function markerOf(line: string): Marker | null {
  const match = MARKER.exec(unwrap(line));
  if (match?.[1] && match[2]) return { kind: match[1] as Marker['kind'], path: match[2] };
  const loose = LOOSE_MARKER.exec(codeSpan(line) ?? '');
  if (!loose?.[1] || !loose[2]) return null;
  return { kind: loose[1] as Marker['kind'], path: loose[2], fixed: true };
}

/** A strict match on the unwrapped line, else a loose one inside an inline-code span. */
function matchMarker(
  line: string,
  strict: RegExp,
  loose: RegExp
): { match: RegExpExecArray; fixed: boolean } | null {
  const match = strict.exec(unwrap(line));
  if (match) return { match, fixed: false };
  const code = codeSpan(line);
  const fixed = code === null ? null : loose.exec(code);
  return fixed ? { match: fixed, fixed: true } : null;
}

const MARKER_WORDS = [
  'FILE',
  'READ',
  'RUN',
  'DELETE',
  'RENAME',
  'DONE',
  'START',
  'STOP',
  'LOGS',
  'ASSET',
  'DOWNLOAD'
];

const sorted = (word: string) => [...word].sort().join('');

/**
 * True if `word` is a marker name give or take a letter: RUNS, DELET, FILR, FIEL (swapped),
 * or `file` (any case).
 */
function nearMarkerWord(word: string): boolean {
  const upper = word.toUpperCase();
  return MARKER_WORDS.some(
    (name) =>
      upper.startsWith(name) ||
      (upper.length >= 3 && name.startsWith(upper)) ||
      (upper.length === name.length &&
        ([...upper].filter((c, i) => c !== name[i]).length === 1 || sorted(upper) === sorted(name)))
  );
}

/**
 * A line Bridge didn't read that looks like a marker attempt: it (or the inline-code span
 * it starts with) begins with `@@` and a marker-like word, or with one `@` and a marker
 * name exactly (`@RUN npm test`), so `@readonly` or an `@user` mention don't count. Prose
 * that only mentions a marker mid-sentence doesn't count either.
 */
function looksLikeMarker(line: string): boolean {
  const text = line.trim().replace(BULLET, '');
  const lead = /^(`+)(.*?)\1/.exec(text)?.[2]?.trim() ?? text;
  const fuzzy = /^@{2,3}\s*([A-Za-z]+)/.exec(lead)?.[1];
  if (fuzzy !== undefined) return nearMarkerWord(fuzzy);
  const single = /^@([A-Z]+)(?=[\s@]|$)/.exec(lead)?.[1];
  return single !== undefined && MARKER_WORDS.includes(single);
}

/** A file path and nothing else: has a folder or an extension, and no spaces. */
const PATH = /^(?=[^\s]*(?:\/|\.[A-Za-z0-9]{1,10}$))[\w@~+-][\w@~+.\-/]*$/;

/**
 * True if `line` names a file the way the chat labels a code block it forgot to mark:
 * `src/app.ts`, `**src/app.ts**`, `### src/app.ts`, `File: src/app.ts`, or prose ending in
 * one in inline code, like "Update `src/app.ts`:".
 */
function looksLikePathLabel(line: string): boolean {
  const text = line.trim().replace(BULLET, '');
  const ending = /`([^`\s]+)`\s*:?$/.exec(text)?.[1];
  if (ending && PATH.test(ending)) return true;
  const bare = text
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:__|_|\*\*)(.*)(?:__|_|\*\*)$/, '$1')
    .replace(/:$/, '')
    .replace(/^(?:file|path|filename)\s*:\s*/i, '')
    .replace(/^`+(.*?)`+$/, '$1')
    .trim();
  return PATH.test(bare);
}

/** The nearest non-blank line above `index`, at most `MAX_GAP` blank lines up. */
function lineAbove(lines: readonly string[], index: number): string | null {
  for (let j = index - 1; j >= 0 && index - j <= MAX_GAP + 1; j -= 1) {
    if (lines[j]?.trim()) return lines[j] ?? null;
  }
  return null;
}

const clip = (text: string) => text.trim().slice(0, 120);

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
 *   `@@DELETE relative/old.ts@@`
 *   `@@RENAME relative/a.ts -> relative/b.ts@@`
 *   `@@DONE@@`
 *
 * The marker may be plain or in inline code, and the fence may follow it after up to two
 * blank lines. A fence closes on a line of the same character at least as long as the
 * opener, so a file that contains ``` can be wrapped in ````. A fence that never closes
 * ends parsing: that's a reply still streaming or cut off. Fences without a marker, and
 * `@@CONTEXT` blocks (files sent to the chat), are skipped, so a marker line inside them
 * (an example, or a file that mentions `@@RUN`) is never an edit, a request or a command.
 * Paths and commands are returned as written; checking them is the desktop's job.
 *
 * The chat sometimes drops a marker's closing `@@`. Inside an inline-code span that holds
 * only the marker, that's read anyway (a FILE one only when a code block follows) and
 * listed in `fixed`. What still looks meant for Bridge but can't be read is in `issues`.
 */
export function parseChat(text: string): ChatParse {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const edits: ParsedEdit[] = [];
  const reads: string[] = [];
  const runs: string[] = [];
  const deletes: string[] = [];
  const renames: FileRename[] = [];
  const downloads: FileDownload[] = [];
  const lists: Record<LineMarker, string[]> = {
    RUN: runs,
    START: [],
    STOP: [],
    LOGS: [],
    ASSET: []
  };
  const fixed: FixedMarkers = {
    reads: [],
    runs: [],
    deletes: [],
    renames: [],
    starts: [],
    stops: [],
    logs: [],
    assets: [],
    downloads: [],
    done: false
  };
  const fixedLists: Record<LineMarker, string[]> = {
    RUN: fixed.runs,
    START: fixed.starts,
    STOP: fixed.stops,
    LOGS: fixed.logs,
    ASSET: fixed.assets
  };
  const issues: FormatIssue[] = [];
  const markers: string[] = [];
  let unclosed: string | null = null;
  let lastBlockEnd = -1;
  let done = false;
  let fences = 0;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const marker = markerOf(line);

    const requested =
      marker?.kind === 'READ' ? [marker.path] : readsOn(line.trim().replace(BULLET, ''));
    if (requested.length > 0) {
      for (const path of requested) {
        markers.push(`@@READ ${path}@@`);
        if (reads.includes(path)) continue;
        reads.push(path);
        if (marker?.fixed) fixed.reads.push(path);
      }
      i += 1;
      continue;
    }

    if (marker && (LINE_MARKERS as readonly string[]).includes(marker.kind)) {
      const kind = marker.kind as LineMarker;
      markers.push(`@@${kind} ${marker.path}@@`);
      // Two images may well go to the same path; every other kind is listed once.
      if (kind === 'ASSET' || !lists[kind].includes(marker.path)) {
        lists[kind].push(marker.path);
        if (marker.fixed) fixedLists[kind].push(marker.path);
      }
      i += 1;
      continue;
    }

    const downloadMarker = matchMarker(line, DOWNLOAD, LOOSE_DOWNLOAD);
    const [, url, saveTo] = downloadMarker?.match ?? [];
    if (downloadMarker && url && saveTo) {
      markers.push(`@@DOWNLOAD ${url} -> ${saveTo}@@`);
      if (!downloads.some((d) => d.url === url && d.path === saveTo)) {
        downloads.push({ url, path: saveTo });
        if (downloadMarker.fixed) fixed.downloads.push({ url, path: saveTo });
      }
      i += 1;
      continue;
    }

    const doneMarker = matchMarker(line, DONE, LOOSE_DONE);
    if (doneMarker) {
      // A strict DONE anywhere in the reply means the format was fine for it.
      fixed.done = done ? fixed.done && doneMarker.fixed : doneMarker.fixed;
      done = true;
      markers.push('@@DONE@@');
      i += 1;
      continue;
    }

    const deleteMarker = matchMarker(line, DELETE, LOOSE_DELETE);
    const deleted = deleteMarker?.match[1];
    if (deleteMarker && deleted) {
      markers.push(`@@DELETE ${deleted}@@`);
      if (!deletes.includes(deleted)) {
        deletes.push(deleted);
        if (deleteMarker.fixed) fixed.deletes.push(deleted);
      }
      i += 1;
      continue;
    }

    const renameMarker = matchMarker(line, RENAME, LOOSE_RENAME);
    const [, from, to] = renameMarker?.match ?? [];
    if (renameMarker && from && to) {
      markers.push(`@@RENAME ${from} -> ${to}@@`);
      if (from !== to && !renames.some((r) => r.from === from && r.to === to)) {
        renames.push({ from, to });
        if (renameMarker.fixed) fixed.renames.push({ from, to });
      }
      i += 1;
      continue;
    }

    if (marker) {
      let open = i + 1;
      while (open < lines.length && open - i <= MAX_GAP && !lines[open]?.trim()) open += 1;
      if (!FENCE_OPEN.test(lines[open]?.trim() ?? '')) {
        // A marker with no fence after it isn't a block. A FILE one should have had one.
        if (marker.kind === 'FILE') issues.push({ kind: 'no-block', text: clip(line) });
        i += 1;
        continue;
      }
      const block = readFence(lines, open);
      if (!block) {
        if (marker.kind === 'FILE') unclosed = marker.path;
        break;
      }
      if (marker.kind === 'FILE') {
        markers.push(`@@FILE ${marker.path}@@`);
        lastBlockEnd = block.close;
        const content = block.body.length > 0 ? `${block.body.join('\n')}\n` : '';
        const suspectedPartial = looksPartial(content);
        edits.push({
          path: marker.path,
          content,
          suspectedPartial,
          fence: fences,
          ...(marker.fixed && { formatFixed: true as const })
        });
        if (suspectedPartial) issues.push({ kind: 'placeholder', text: clip(marker.path) });
      }
      fences += 1;
      i = block.close + 1;
      continue;
    }

    if (FENCE_OPEN.test(line.trim())) {
      const block = readFence(lines, i);
      if (!block) break;
      const above = lineAbove(lines, i);
      if (
        above !== null &&
        looksLikePathLabel(above) &&
        block.body.filter((l) => l.trim()).length >= 2
      ) {
        issues.push({ kind: 'no-marker', text: clip(above) });
      }
      fences += 1;
      i = block.close + 1;
      continue;
    }

    if (looksLikeMarker(line)) issues.push({ kind: 'bad-marker', text: clip(line) });
    i += 1;
  }

  const endsInBlock =
    lastBlockEnd >= 0 && lines.slice(lastBlockEnd + 1).every((line) => !line.trim());
  return {
    edits,
    reads,
    runs,
    done,
    deletes,
    renames,
    starts: lists.START,
    stops: lists.STOP,
    logs: lists.LOGS,
    assets: lists.ASSET,
    downloads,
    fixed,
    issues,
    markers,
    unclosed,
    endsInBlock
  };
}

/** Where a reply that was cut off stopped, for the continuation prompt. */
export interface Interruption {
  /** The last marker that came through whole, or null if none did. */
  marker: string | null;
  /** The file being written when it stopped, which Bridge doesn't apply, or null. */
  cutOff: string | null;
}

/**
 * Where an interrupted reply stopped. A block that never closed was cut off. So was the
 * last `@@FILE` block when nothing follows it: the page draws an unfinished code block as a
 * whole one, so Bridge can't tell it finished. Anything after a block means it did.
 */
export function interruptionOf(parse: ChatParse): Interruption {
  if (parse.unclosed !== null) {
    return { marker: parse.markers.at(-1) ?? null, cutOff: parse.unclosed };
  }
  const last = parse.edits.at(-1);
  if (parse.endsInBlock && last) {
    const index = parse.markers.lastIndexOf(`@@FILE ${last.path}@@`);
    return { marker: parse.markers[index - 1] ?? null, cutOff: last.path };
  }
  return { marker: parse.markers.at(-1) ?? null, cutOff: null };
}

/**
 * What in `text` looks meant for Bridge but isn't in its format (see `FormatIssue`).
 * Markers Bridge read anyway, missing their closing `@@`, aren't issues.
 */
export function findFormatIssues(text: string): FormatIssue[] {
  return parseChat(text).issues;
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
