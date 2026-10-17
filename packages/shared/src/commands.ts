import { parse } from 'shell-quote';

// Commands the chat asks for with `@@RUN cmd@@`. The text becomes an argv here, in the
// extension and again in the desktop, and never goes near a shell: the desktop spawns it
// with `shell: false` only if its argv starts with an allowlisted prefix. See PLAN.md,
// "Phase 5 decisions".

export const MAX_COMMAND_CHARS = 1_000;
export const MAX_ARGS = 100;
/** Output kept per run: the first half and the last half of this many bytes. */
export const RUN_OUTPUT_CAP_BYTES = 200 * 1024;
/** About how much output a chat message carries: head and tail, `[truncated]` between. */
export const CHAT_OUTPUT_CHARS = 8_000;
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const MAX_RUN_TIMEOUT_MS = 10 * 60_000;
export const MIN_RUN_TIMEOUT_MS = 5_000;

export type CommandRejection =
  | 'empty'
  | 'too-long'
  | 'newline'
  | 'control'
  | 'substitution'
  | 'operator'
  | 'glob'
  | 'comment'
  | 'env-assignment';

export const COMMAND_REJECTION_TEXT: Record<CommandRejection, string> = {
  empty: 'The command is empty.',
  'too-long': `The command is longer than ${MAX_COMMAND_CHARS.toLocaleString('en-US')} characters.`,
  newline: 'The command spans more than one line.',
  control: 'The command has control characters in it.',
  substitution: 'Bridge doesn’t run commands with $ or backticks.',
  operator: 'Bridge runs one command at a time, without |, &&, ;, < or >.',
  glob: 'Bridge doesn’t expand wildcards like * or ?.',
  comment: 'Bridge doesn’t run commands with # comments.',
  'env-assignment': 'Bridge doesn’t run commands that set variables (FOO=1 cmd).'
};

export type CommandParse = { ok: true; argv: string[] } | { ok: false; reason: CommandRejection };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
const GLOB = /[*?[\]]/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Per-argument checks shared by the parser and the desktop's re-check of a `run` argv. */
function argRejection(arg: string): CommandRejection | null {
  if (/[\r\n]/.test(arg)) return 'newline';
  if (CONTROL.test(arg)) return 'control';
  if (/[$`]/.test(arg)) return 'substitution';
  if (GLOB.test(arg)) return 'glob';
  return null;
}

/**
 * Turns one command line into argv with shell-quote's tokenizer, or says why not. Refuses
 * everything that would mean something to a shell: operators (`|`, `&&`, `;`, `>`, `<`,
 * `&`, parentheses), `$` and backticks (substitution, variables), wildcards, comments,
 * leading `FOO=1` assignments, newlines, control characters, and more than 1,000
 * characters. Quotes and backslashes group words as a shell would. With no shell, the
 * argv is exactly what the program receives.
 */
export function parseCommand(text: string): CommandParse {
  if (text.length > MAX_COMMAND_CHARS) return { ok: false, reason: 'too-long' };
  const pre = argRejection(text);
  if (pre) return { ok: false, reason: pre };
  // `$` is already refused, so shell-quote has nothing to expand.
  const tokens = parse(text);
  const argv: string[] = [];
  for (const token of tokens) {
    if (typeof token === 'string') {
      argv.push(token);
      continue;
    }
    if ('comment' in token) return { ok: false, reason: 'comment' };
    return { ok: false, reason: token.op === 'glob' ? 'glob' : 'operator' };
  }
  if (argv.length === 0 || argv[0] === '') return { ok: false, reason: 'empty' };
  if (argv.length > MAX_ARGS) return { ok: false, reason: 'too-long' };
  if (ENV_ASSIGNMENT.test(argv[0] ?? '')) return { ok: false, reason: 'env-assignment' };
  return { ok: true, argv };
}

/**
 * The desktop's check of an argv the extension sent: the same rules the parser applies to
 * each word, so a `run` request can carry nothing the chat text couldn't.
 */
export function checkArgv(argv: readonly string[]): CommandRejection | null {
  if (argv.length === 0 || argv[0] === '') return 'empty';
  if (argv.length > MAX_ARGS) return 'too-long';
  if (argv.reduce((n, arg) => n + arg.length + 1, 0) > MAX_COMMAND_CHARS + 1) return 'too-long';
  for (const arg of argv) {
    const rejection = argRejection(arg);
    if (rejection) return rejection;
  }
  if (ENV_ASSIGNMENT.test(argv[0] ?? '')) return 'env-assignment';
  return null;
}

/** For display: words joined by spaces, quoting any with spaces, quotes or backslashes. */
export function formatArgv(argv: readonly string[]): string {
  return argv
    .map((arg) =>
      arg === '' || /[\s'"\\|&;<>()#]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg
    )
    .join(' ');
}

/**
 * An allowlist entry is an executable plus an argument prefix, written as a command:
 * `pnpm test` allows `pnpm test` and `pnpm test -- --run`, but not `pnpm testx`.
 */
export function parseAllowlistEntry(entry: string): string[] | null {
  const parsed = parseCommand(entry.trim());
  return parsed.ok ? parsed.argv : null;
}

/** The first entry whose words are a prefix of `argv`, word for word, or null. */
export function matchAllowlist(argv: readonly string[], entries: readonly string[]): string | null {
  for (const entry of entries) {
    const prefix = parseAllowlistEntry(entry);
    if (prefix && prefix.length <= argv.length && prefix.every((word, i) => argv[i] === word)) {
      return entry;
    }
  }
  return null;
}

/**
 * Head and tail of `text` with `[truncated]` between, at most about `max` characters, for
 * a chat message. Cuts at line breaks where it can.
 */
export function truncateMiddle(text: string, max = CHAT_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const marker = '\n[truncated]\n';
  const half = Math.floor((max - marker.length) / 2);
  let head = text.slice(0, half);
  let tail = text.slice(text.length - half);
  const headBreak = head.lastIndexOf('\n');
  if (headBreak > half / 2) head = head.slice(0, headBreak);
  const tailBreak = tail.indexOf('\n');
  if (tailBreak >= 0 && tailBreak < half / 2) tail = tail.slice(tailBreak + 1);
  return `${head}${marker}${tail}`;
}
