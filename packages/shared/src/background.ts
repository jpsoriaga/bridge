import { INSTALL_MANAGERS, parseAllowlistEntry, programName } from './commands';

// Background processes: commands that keep running (dev servers, watchers), started with
// `@@START cmd@@` and stopped with `@@STOP cmd@@`. The app runs them; these are the words
// and the text checks both sides share. See PLAN.md, "1.3.0 decisions".

/** package.json scripts that usually keep running, so Bridge suggests them as background. */
export const BACKGROUND_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'watch'] as const;

/** `dev`, `start`, `serve`, `preview`, `watch`, or one of them with a suffix (`dev:web`). */
export function isBackgroundScript(name: string): boolean {
  return BACKGROUND_SCRIPTS.some(
    (script) => name === script || name.startsWith(`${script}:`) || name.startsWith(`${script}-`)
  );
}

/**
 * Whether an allowlist entry looks like a long-running command: a package manager running
 * one of `BACKGROUND_SCRIPTS` (`npm run dev`, `pnpm dev`, `yarn start`, `bun run preview`).
 * Only a suggestion; the user decides in the app.
 */
export function looksLikeBackground(entry: string): boolean {
  const words = parseAllowlistEntry(entry)?.words ?? [];
  const program = programName(words[0] ?? '');
  if (!(INSTALL_MANAGERS as readonly string[]).includes(program)) return false;
  const rest = words.slice(1);
  const script = rest[0] === 'run' ? rest[1] : rest[0];
  return script !== undefined && isBackgroundScript(script);
}

/** A local URL a dev server prints when it's ready. */
const LOCAL_URL =
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>`)\]]*)?/i;

/**
 * The first local URL in a line of output (`http://localhost:5173/`), as one a browser can
 * open: `0.0.0.0` and `[::]` become `localhost`, trailing punctuation goes. Null if none.
 */
export function readyUrl(line: string): string | null {
  const match = LOCAL_URL.exec(line)?.[0];
  if (!match) return null;
  const url = match.replace(/[.,;:!?]+$/, '').replace(/\/\/(?:0\.0\.0\.0|\[::\])/, '//localhost');
  return url.length <= 200 ? url : null;
}

/** An http(s) URL on this computer only. The only kind Bridge opens from a process. */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/** A line that reports an error: compile errors, crashes, failed requests. */
const ERROR_LINE =
  /\b(?:errors?|failed|failure|exception|unhandled|uncaught|cannot find|is not defined|is not a function|ELIFECYCLE|ERR!)\b|✘|✖|\[ERROR\]/i;
/** "0 errors", "no errors", "without errors": good news that mentions errors. */
const NO_ERRORS = /\b(?:0|no|without)\s+(?:errors?|problems?|failures?)\b/i;

/** Most lines `errorLines` keeps. */
export const MAX_ERROR_LINES = 40;

/**
 * The lines of a log that look like errors, each with the two lines after it (where the
 * file and the stack usually are), in order and without repeats, at most `max`.
 */
export function errorLines(lines: readonly string[], max = MAX_ERROR_LINES): string[] {
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (!ERROR_LINE.test(line) || NO_ERRORS.test(line)) return;
    for (let j = i; j < Math.min(lines.length, i + 3); j += 1) keep.add(j);
  });
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i]!)
    .filter((line) => line.trim() !== '')
    .slice(-max);
}

/** How long a process has run: `45s`, `12m 3s`, `2h 5m`. */
export function formatUptime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
