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
/** Installs download and build packages, so they get longer than other commands by default. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

/** Package managers whose bare `<manager> install` Bridge suggests and times separately. */
export const INSTALL_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type InstallManager = (typeof INSTALL_MANAGERS)[number];

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
 * An allowlist entry is a command, matched word for word. By default it allows exactly that
 * command: `pnpm test` allows `pnpm test` and nothing more. A last word of `*` also allows
 * extra arguments after it: `pnpm test *` allows `pnpm test -- --run`, never `pnpm testx`.
 */
export interface AllowlistRule {
  words: string[];
  /** Ends in `*`: more arguments may follow. */
  extra: boolean;
}

/** The marker for "and any arguments after these". Only ever the last word. */
export const ALLOWLIST_ANY = '*';

export function parseAllowlistEntry(entry: string): AllowlistRule | null {
  const trimmed = entry.trim();
  const extra = trimmed === ALLOWLIST_ANY || /\s\*$/.test(trimmed);
  const parsed = parseCommand(extra ? trimmed.slice(0, -1).trimEnd() : trimmed);
  return parsed.ok ? { words: parsed.argv, extra } : null;
}

/**
 * The first entry that allows `argv`, or null: the same words exactly, or (with `*`) the
 * entry's words followed by anything.
 */
export function matchAllowlist(argv: readonly string[], entries: readonly string[]): string | null {
  for (const entry of entries) {
    const rule = parseAllowlistEntry(entry);
    if (!rule) continue;
    const { words, extra } = rule;
    const fits = extra ? words.length <= argv.length : words.length === argv.length;
    if (fits && words.every((word, i) => argv[i] === word)) return entry;
  }
  return null;
}

/**
 * Options that let an allowlisted program do far more than the entry suggests (run other
 * code, write files, change folder or config), refused even when the allowlist entry
 * would match. One table, by program name (lowercase, no `.exe`/`.cmd`/`.bat`). `null`
 * refuses the program entirely. Single words (no dash) are subcommands, refused anywhere.
 */
export const DENIED_FLAGS: Readonly<Record<string, readonly string[] | null>> = {
  git: [
    '--output',
    '-o',
    '-c',
    '--config-env',
    '--exec',
    '--upload-pack',
    '--receive-pack',
    '-C',
    '--git-dir',
    '--work-tree'
  ],
  node: [
    '-e',
    '--eval',
    '-p',
    '--print',
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader'
  ],
  npm: ['-C', '--dir', '--prefix', '--global', '-g', 'exec', 'dlx', 'x'],
  pnpm: ['-C', '--dir', '--prefix', '--global', '-g', 'exec', 'dlx', 'x'],
  // Yarn's own word for changing folder is --cwd.
  yarn: ['-C', '--dir', '--cwd', '--prefix', '--global', '-g', 'exec', 'dlx', 'x'],
  npx: null,
  pnpx: null,
  bunx: null
};

/** A program's name as the table keys it: the last path part, lowercase, no Windows suffix. */
export function programName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

/**
 * The first argument `argv` may not use, or null. For each denied option: the option
 * itself, `--option=value`, an abbreviation git and others accept (`--outp` for
 * `--output`), a short option with its value attached (`-Cdir`), and a short option in a
 * cluster (`-pe`). A refused program returns its own name.
 */
export function deniedArgument(argv: readonly string[], table = DENIED_FLAGS): string | null {
  const program = programName(argv[0] ?? '');
  if (!(program in table)) return null;
  const denied = table[program];
  if (denied === null || denied === undefined) return argv[0] ?? program;
  const longs = denied.filter((f) => f.startsWith('--'));
  const shorts = denied.filter((f) => /^-[^-]$/.test(f)).map((f) => f[1]!);
  const words = denied.filter((f) => !f.startsWith('-'));
  for (const arg of argv.slice(1)) {
    // After `--`, the rest is the script's own arguments, not the program's options.
    if (arg === '--') break;
    if (words.includes(arg)) return arg;
    if (arg.startsWith('--')) {
      const name = arg.split('=')[0]!;
      if (name.length > 3 && longs.some((flag) => flag.startsWith(name))) return arg;
      continue;
    }
    if (/^-[^-]/.test(arg) && [...arg.slice(1)].some((c) => shorts.includes(c))) return arg;
  }
  return null;
}

/**
 * `npm install`, `pnpm install`, `yarn install` or `bun install` with nothing after it: it
 * installs only what package.json lists. Anything with more words (`npm install lodash`)
 * isn't one, and an exact allowlist entry doesn't allow it either.
 */
export function isInstallCommand(argv: readonly string[]): boolean {
  return (
    argv.length === 2 &&
    (INSTALL_MANAGERS as readonly string[]).includes(programName(argv[0] ?? '')) &&
    argv[1] === 'install'
  );
}

export type CommandRefusal = 'not-allowlisted' | 'denied-flag';

/** Why `argv` may not run under `allowlist`, or null. The app and the RUN card share it. */
export function commandRefusal(
  argv: readonly string[],
  allowlist: readonly string[]
): CommandRefusal | null {
  if (matchAllowlist(argv, allowlist) === null) return 'not-allowlisted';
  if (deniedArgument(argv) !== null) return 'denied-flag';
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
