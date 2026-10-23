import { CHAT_OUTPUT_CHARS, formatArgv, isInstallCommand, truncateMiddle } from './commands';
import type { TreeEntry } from './files';
import type { Interruption } from './parser';
import type { RunResult } from './protocol';
import { redactSecrets } from './redact';

// Text Bridge puts into the chat composer. The chat reads these, so they're plain prose,
// and nothing here names the chat's vendor.

/** About how many tree entries the session prompt lists before summarising folders. */
export const SESSION_TREE_MAX_ENTRIES = 1_500;
/** Above this many characters the chat may turn a paste into an attachment or cut it. */
export const COMPOSER_WARN_CHARS = 30_000;

/**
 * The last line of every message Bridge inserts on the chat's behalf (files, command
 * output, Full auto follow-ups), so the format stays in front of it.
 */
export const FORMAT_FOOTER =
  'Bridge format: @@FILE path@@ + full code block · @@READ path@@ · @@RUN cmd@@ · @@DONE@@. Markers start and end with @@, in backticks.';

/** What **Send format reminder** (and Full auto) inserts when a reply missed the format. */
export const FORMAT_REMINDER =
  "Please redo your last reply using Bridge's exact format: @@FILE path@@ followed by one complete code block, @@READ path@@, @@RUN cmd@@, @@DONE@@. Every marker starts and ends with @@ and is wrapped in backticks.";

const withFooter = (text: string) => (text ? `${text}\n\n${FORMAT_FOOTER}` : '');

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

/** One file as the chat reads it, with likely secrets redacted, and how many were. */
function contextBlock(path: string, content: string): { text: string; redacted: number } {
  const clean = redactSecrets(content);
  const fence = pickFence(clean.text);
  const body = clean.text.endsWith('\n') ? clean.text : `${clean.text}\n`;
  return {
    text: `\`@@CONTEXT ${path}@@\`\n${fence}${fenceLanguage(path)}\n${body}${fence}`,
    redacted: clean.count
  };
}

/**
 * One file as the chat should read it: a `@@CONTEXT` marker and a fenced block. Likely
 * secrets in it are already `[redacted]`.
 */
export function formatContextBlock(path: string, content: string): string {
  return contextBlock(path, content).text;
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

/**
 * Files sent to the chat, plus a line for any Bridge refused to send, then
 * `FORMAT_FOOTER`. Likely secrets are `[redacted]`; `redacted` says how many.
 */
export function buildContextMessage(
  files: ContextFile[],
  refused: RefusedFile[] = []
): { text: string; redacted: number } {
  const context = contextMessage(files, refused);
  return { text: withFooter(context.text), redacted: context.redacted };
}

/** `buildContextMessage` without the footer, for messages that hold more than files. */
function contextMessage(
  files: readonly ContextFile[],
  refused: readonly RefusedFile[]
): { text: string; redacted: number } {
  const parts: string[] = [];
  let redacted = 0;
  if (files.length > 0) {
    parts.push(
      files.length === 1
        ? 'Here is a file from the project, for reference only (not an edit):'
        : `Here are ${files.length} files from the project, for reference only (not edits):`
    );
    for (const file of files) {
      const block = contextBlock(file.path, file.content);
      parts.push(block.text);
      redacted += block.redacted;
    }
  }
  if (refused.length > 0) {
    parts.push(
      `Bridge could not send: ${refused.map((f) => `${f.path} (${f.reason})`).join(', ')}.`
    );
  }
  return { text: parts.join('\n\n'), redacted };
}

/**
 * Asks the chat to carry on after its reply was cut off: from the last marker that came
 * through, resending the file it was writing, without repeating finished ones.
 */
function continuationText({ marker, cutOff }: Interruption): string {
  return [
    marker
      ? `Your last reply was cut off after ${marker}.`
      : 'Your last reply was cut off before its first Bridge marker.',
    "Continue from there using Bridge's format.",
    ...(cutOff ? [`Resend ${cutOff} in full if it was cut off.`] : []),
    "Don't repeat files that were already complete."
  ].join(' ');
}

/** The continuation on its own (Resume outside Full auto), then `FORMAT_FOOTER`. */
export function buildContinuation(interruption: Interruption): string {
  return withFooter(continuationText(interruption));
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

function commandRule(allowlist: readonly string[]): string {
  if (allowlist.length === 0) {
    return "3. Bridge can't run commands in this project. Tell me what to run instead.";
  }
  const listed = allowlist.map((entry) => `\`${entry}\``).join(', ');
  const star = allowlist.some((entry) => entry.endsWith('*'))
    ? ' (`*`: you may add arguments there)'
    : '';
  const install = allowlist.find((entry) => isInstallCommand(entry.split(' ')));
  const after = install
    ? `\n   After changing package.json, run the install command: \`@@RUN ${install}@@\``
    : '';
  return `3. Run a command: \`@@RUN npm test@@\`. Only these are allowed: ${listed}${star}${after}`;
}

/** The instructions "Start session" puts in the composer: the rules first, then the tree. */
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
      ? ' (some folders are summarised; ask with @@READ for what you need)'
      : '';
  return [
    `You are connected to my local project "${projectName}" through Bridge. Bridge only understands the exact markers below. Anything else is ignored.`,
    [
      'RULES',
      '1. Edit or create a file: write the marker in backticks on its own line, then ONE code block with the COMPLETE file.',
      '   `@@FILE src/app.ts@@`',
      '   ```ts',
      '   ...the entire file...',
      '   ```',
      '   Never send partial files, diffs, or "rest unchanged" comments.',
      "2. See a file: `@@READ path@@` on its own line. Never guess what's in a file.",
      commandRule(allowlist),
      '4. Delete: `@@DELETE path@@`. Rename: `@@RENAME old/path -> new/path@@`',
      '5. When the task is finished: `@@DONE@@`',
      '6. Every marker starts AND ends with @@ and is wrapped in single backticks.',
      '7. Paths are relative to the project root. One code block per file.',
      "8. Files I send as `@@CONTEXT path@@` are for reference only. Don't edit them unless I ask."
    ].join('\n'),
    'Before every reply, check that each marker matches these formats exactly.',
    `PROJECT FILES${trimmed}\n${fence}\n${listing}\n${fence}`,
    'Reply with only "Ready." to this message.'
  ].join('\n\n');
}

/**
 * How a command's run reads in the chat: the command, how it ended, and its output, with
 * likely secrets `[redacted]` before it's cut to size. `redacted` says how many.
 */
export function formatRunResult(
  result: Pick<RunResult, 'argv' | 'status' | 'exitCode' | 'signal' | 'durationMs' | 'output'>,
  maxOutput = CHAT_OUTPUT_CHARS
): { text: string; redacted: number } {
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
  const clean = redactSecrets(result.output.trimEnd());
  const output = truncateMiddle(clean.text, maxOutput);
  const fence = pickFence(output);
  return {
    text: `Output of \`${formatArgv(result.argv)}\` (${ended}):\n${fence}text\n${output || '(no output)'}\n${fence}`,
    redacted: clean.count
  };
}

/** **Send output** on a RUN card: the result, then `FORMAT_FOOTER`. */
export function buildRunMessage(
  result: Pick<RunResult, 'argv' | 'status' | 'exitCode' | 'signal' | 'durationMs' | 'output'>
): { text: string; redacted: number } {
  const run = formatRunResult(result);
  return { text: withFooter(run.text), redacted: run.redacted };
}

/** One command the loop dealt with: its result, or why it didn't run. */
export type FollowUpRun =
  | {
      command: string;
      result: Pick<RunResult, 'argv' | 'status' | 'exitCode' | 'signal' | 'durationMs' | 'output'>;
    }
  | { command: string; refused: string }
  /** Running when the computer slept, and the user chose Skip. */
  | { command: string; skipped: true };

export interface FollowUpInput {
  applied: readonly string[];
  /** Edits left on their cards, with a few words on why. */
  skipped: readonly RefusedFile[];
  files: readonly ContextFile[];
  refused: readonly RefusedFile[];
  runs: readonly FollowUpRun[];
  /** The reply was cut off: ask the chat to carry on (`continuationText`). */
  continuation?: Interruption;
}

/** Below this, command output in a trimmed follow-up is cut harder. */
const TRIMMED_OUTPUT_CHARS = 2_000;

function followUpText(
  input: FollowUpInput,
  outputChars: number,
  withFiles: boolean
): { text: string; redacted: number } {
  const parts: string[] = [];
  let redacted = 0;
  const summary: string[] = [];
  if (input.applied.length > 0) summary.push(`Applied: ${input.applied.join(', ')}.`);
  if (input.skipped.length > 0) {
    summary.push(`Not applied: ${input.skipped.map((f) => `${f.path} (${f.reason})`).join(', ')}.`);
  }
  if (summary.length > 0) parts.push(summary.join('\n'));
  if (withFiles) {
    const context = contextMessage(input.files, input.refused);
    if (context.text) parts.push(context.text);
    redacted += context.redacted;
  } else if (input.files.length > 0 || input.refused.length > 0) {
    const paths = input.files.map((f) => f.path).join(', ');
    parts.push(
      `Bridge left out the files you asked for (${paths}) to keep this message small. Ask for fewer at a time with @@READ.`
    );
  }
  for (const run of input.runs) {
    if ('refused' in run) {
      parts.push(`Bridge didn't run \`${run.command}\`: ${run.refused}`);
      continue;
    }
    if ('skipped' in run) {
      parts.push(`The command \`${run.command}\` was interrupted and skipped.`);
      continue;
    }
    const output = formatRunResult(run.result, outputChars);
    parts.push(output.text);
    redacted += output.redacted;
  }
  if (input.continuation) parts.push(continuationText(input.continuation));
  return { text: parts.join('\n\n'), redacted };
}

/**
 * The message Full auto sends after acting on a reply: what was applied, the files the
 * chat asked for, and command results, then `FORMAT_FOOTER`. If it's over `budget`
 * characters, command output is cut harder, then the files are left out with a note. Null
 * if even that won't fit.
 */
export function buildFollowUp(
  input: FollowUpInput,
  budget = COMPOSER_WARN_CHARS
): { text: string; trimmed: boolean; redacted: number } | null {
  const full = followUpText(input, CHAT_OUTPUT_CHARS, true);
  const text = withFooter(full.text);
  if (text.length <= budget) return { text, redacted: full.redacted, trimmed: false };
  const note = '\n\n(Bridge trimmed this message to fit.)';
  for (const [chars, files] of [
    [TRIMMED_OUTPUT_CHARS, true],
    [TRIMMED_OUTPUT_CHARS, false]
  ] as const) {
    const built = followUpText(input, chars, files);
    const text = withFooter(built.text + note);
    if (text.length <= budget) return { text, trimmed: true, redacted: built.redacted };
  }
  return null;
}
