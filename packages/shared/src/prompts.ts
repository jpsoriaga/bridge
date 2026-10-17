import { CHAT_OUTPUT_CHARS, formatArgv, truncateMiddle } from './commands';
import type { TreeEntry } from './files';
import type { RunResult } from './protocol';

// Text Bridge puts into the chat composer. The chat reads these, so they're plain prose,
// and nothing here names the chat's vendor.

/** About how many tree entries the session prompt lists before summarising folders. */
export const SESSION_TREE_MAX_ENTRIES = 1_500;
/** Above this many characters the chat may turn a paste into an attachment or cut it. */
export const COMPOSER_WARN_CHARS = 30_000;

/** A backtick fence longer than any run of backticks in `content`, and at least 3. */
export function pickFence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** A short info string for a fence, from the file extension. Empty if none fits. */
function fenceLanguage(path: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1];
  return ext ? ext.toLowerCase() : '';
}

/** One file as the chat should read it: a `@@CONTEXT` marker and a fenced block. */
export function formatContextBlock(path: string, content: string): string {
  const fence = pickFence(content);
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `\`@@CONTEXT ${path}@@\`\n${fence}${fenceLanguage(path)}\n${body}${fence}`;
}

export interface ContextFile {
  path: string;
  content: string;
}

export interface RefusedFile {
  path: string;
  /** A few words, e.g. "protected file". */
  reason: string;
}

/** Files sent to the chat, plus a line for any Bridge refused to send. */
export function buildContextMessage(files: ContextFile[], refused: RefusedFile[] = []): string {
  const parts: string[] = [];
  if (files.length > 0) {
    parts.push(
      files.length === 1
        ? 'Here is a file from the project, for reference only (not an edit):'
        : `Here are ${files.length} files from the project, for reference only (not edits):`
    );
    for (const file of files) parts.push(formatContextBlock(file.path, file.content));
  }
  if (refused.length > 0) {
    parts.push(
      `Bridge could not send: ${refused.map((f) => `${f.path} (${f.reason})`).join(', ')}.`
    );
  }
  return parts.join('\n\n');
}

export interface TreeSummary {
  /** One line per entry, indented two spaces per level. Folders end in `/`. */
  lines: string[];
  /** Entries in the tree. */
  total: number;
  /** Entries listed by name. The rest are counted under their folder. */
  shown: number;
}

const depthOf = (path: string) => path.split('/').length - 1;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Lists the tree as an indented outline, at most about `max` entries. When the tree is
 * bigger, it lists every entry down to the deepest level that fits, and each folder below
 * that shows how many entries it holds instead. Entries must be in `tree` order (sorted,
 * depth-first), which keeps each folder's contents right after it.
 */
export function summarizeTree(
  entries: readonly TreeEntry[],
  max = SESSION_TREE_MAX_ENTRIES
): TreeSummary {
  const perDepth: number[] = [];
  for (const entry of entries) {
    const depth = depthOf(entry.path);
    perDepth[depth] = (perDepth[depth] ?? 0) + 1;
  }
  // The deepest level whose entries, with everything above, fit in `max`.
  let limit = -1;
  let running = 0;
  for (let depth = 0; depth < perDepth.length; depth += 1) {
    running += perDepth[depth] ?? 0;
    if (running > max) break;
    limit = depth;
  }

  const hidden = new Map<string, number>();
  if (limit < perDepth.length - 1) {
    for (const entry of entries) {
      const parts = entry.path.split('/');
      if (parts.length - 1 <= limit) continue;
      const folder = parts.slice(0, limit + 1).join('/');
      hidden.set(folder, (hidden.get(folder) ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  let shown = 0;
  for (const entry of entries) {
    const depth = depthOf(entry.path);
    // Even the top level is too big: list the first `max` and count the rest.
    if (depth > limit && limit >= 0) continue;
    if (limit < 0 && (depth > 0 || shown >= max)) continue;
    const indent = '  '.repeat(depth);
    let line = `${indent}${nameOf(entry.path)}${entry.type === 'dir' ? '/' : ''}`;
    if (entry.collapsed) line += ' (not listed)';
    const more = hidden.get(entry.path);
    if (more) line += ` (${more} more ${more === 1 ? 'entry' : 'entries'})`;
    lines.push(line);
    shown += 1;
  }
  if (limit < 0 && entries.length > shown) {
    lines.push(`(${entries.length - shown} more entries not listed)`);
  }
  return { lines, total: entries.length, shown };
}

export interface SessionPromptInput {
  projectName: string;
  tree: readonly TreeEntry[];
  /** The desktop stopped listing early (its own cap). */
  truncated?: boolean;
  /** The commands the user allowed in the app. Empty: the chat is told not to ask for any. */
  allowlist?: readonly string[];
}

function commandRules(allowlist: readonly string[]): string {
  if (allowlist.length === 0) {
    return "7. Bridge can't run commands in this project. Don't ask it to; tell me what to run instead.";
  }
  return [
    '7. To run a command, write one marker per command on its own line, then wait for my reply with the output:',
    '',
    '`@@RUN pnpm test@@`',
    '',
    'Only these commands are allowed, optionally with extra arguments after them. Bridge refuses anything else, and any shell syntax (pipes, &&, ;, redirects, $, wildcards, VAR=value):',
    '',
    ...allowlist.map((entry) => `- \`${entry}\``),
    '',
    '8. When the task is finished and you need nothing more from me, end your reply with:',
    '',
    '`@@DONE@@`'
  ].join('\n');
}

/** The instructions "Start session" puts in the composer. */
export function buildSessionPrompt({
  projectName,
  tree,
  truncated,
  allowlist = []
}: SessionPromptInput): string {
  const summary = summarizeTree(tree);
  const listing = summary.lines.join('\n');
  const fence = pickFence(listing);
  const trimmed =
    summary.shown < summary.total || truncated
      ? ' Some folders are summarised; ask for what you need.'
      : '';
  return [
    `You're helping me edit my project "${projectName}". I use a tool called Bridge that applies your file edits to my computer after I review them.`,
    'Rules for editing files:',
    [
      '1. For each file you create or change, write a marker line in inline code, then one fenced code block with the complete new file:',
      '',
      '`@@FILE src/app.ts@@`',
      '```ts',
      '// the whole file, every line',
      '```',
      '',
      '2. Always send the complete file. Never send partial files, diffs, or placeholders like "// ...rest unchanged" or "// existing code". Bridge replaces the whole file with what you send.',
      '3. Use paths relative to the project root, with forward slashes. One block per file, and only for files that change.',
      '4. If a file itself contains ``` lines, use a longer fence such as ```` for its block.',
      "5. Don't guess what a file contains. To see files, ask for them with one marker per line, then wait for my reply:",
      '',
      '`@@READ src/app.ts@@`',
      '`@@READ package.json@@`',
      '',
      "6. I'll send files as `@@CONTEXT path@@` blocks. Those are for reading, not edits.",
      commandRules(allowlist)
    ].join('\n'),
    `Project files (${summary.total} ${summary.total === 1 ? 'entry' : 'entries'}${truncated ? ', list cut short' : ''}).${trimmed}`,
    `${fence}\n${listing}\n${fence}`,
    'Reply with a short confirmation and wait for my first request. Ask for any files you need with @@READ before you edit them.'
  ].join('\n\n');
}

/** How a command's run reads in the chat: the command, how it ended, and its output. */
export function formatRunResult(
  result: Pick<RunResult, 'argv' | 'status' | 'exitCode' | 'signal' | 'durationMs' | 'output'>,
  maxOutput = CHAT_OUTPUT_CHARS
): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const ended =
    result.status === 'timed-out'
      ? `timed out after ${seconds}s`
      : result.status === 'cancelled'
        ? `cancelled after ${seconds}s`
        : result.status === 'failed'
          ? "couldn't start"
          : result.exitCode !== null
            ? `exit ${result.exitCode}, ${seconds}s`
            : `ended by ${result.signal ?? 'a signal'}, ${seconds}s`;
  const output = truncateMiddle(result.output.trimEnd(), maxOutput);
  const fence = pickFence(output);
  return `Output of \`${formatArgv(result.argv)}\` (${ended}):\n${fence}text\n${output || '(no output)'}\n${fence}`;
}

/** One command the loop dealt with: its result, or why it didn't run. */
export type FollowUpRun =
  | {
      command: string;
      result: Pick<RunResult, 'argv' | 'status' | 'exitCode' | 'signal' | 'durationMs' | 'output'>;
    }
  | { command: string; refused: string };

export interface FollowUpInput {
  applied: readonly string[];
  /** Edits left on their cards, with a few words on why. */
  skipped: readonly RefusedFile[];
  files: readonly ContextFile[];
  refused: readonly RefusedFile[];
  runs: readonly FollowUpRun[];
}

/** Below this, command output in a trimmed follow-up is cut harder. */
const TRIMMED_OUTPUT_CHARS = 2_000;

function followUpText(input: FollowUpInput, outputChars: number, withFiles: boolean): string {
  const parts: string[] = [];
  const summary: string[] = [];
  if (input.applied.length > 0) summary.push(`Applied: ${input.applied.join(', ')}.`);
  if (input.skipped.length > 0) {
    summary.push(`Not applied: ${input.skipped.map((f) => `${f.path} (${f.reason})`).join(', ')}.`);
  }
  if (summary.length > 0) parts.push(summary.join('\n'));
  if (withFiles) {
    const context = buildContextMessage([...input.files], [...input.refused]);
    if (context) parts.push(context);
  } else if (input.files.length > 0 || input.refused.length > 0) {
    const paths = input.files.map((f) => f.path).join(', ');
    parts.push(
      `Bridge left out the files you asked for (${paths}) to keep this message small. Ask for fewer at a time with @@READ.`
    );
  }
  for (const run of input.runs) {
    parts.push(
      'refused' in run
        ? `Bridge didn't run \`${run.command}\`: ${run.refused}`
        : formatRunResult(run.result, outputChars)
    );
  }
  return parts.join('\n\n');
}

/**
 * The message Full auto sends after acting on a reply: what was applied, the files the
 * chat asked for, and command results. If it's over `budget` characters, command output
 * is cut harder, then the files are left out with a note. Null if even that won't fit.
 */
export function buildFollowUp(
  input: FollowUpInput,
  budget = COMPOSER_WARN_CHARS
): { text: string; trimmed: boolean } | null {
  const full = followUpText(input, CHAT_OUTPUT_CHARS, true);
  if (full.length <= budget) return { text: full, trimmed: false };
  const note = '\n\n(Bridge trimmed this message to fit.)';
  for (const [chars, files] of [
    [TRIMMED_OUTPUT_CHARS, true],
    [TRIMMED_OUTPUT_CHARS, false]
  ] as const) {
    const text = followUpText(input, chars, files) + note;
    if (text.length <= budget) return { text, trimmed: true };
  }
  return null;
}
