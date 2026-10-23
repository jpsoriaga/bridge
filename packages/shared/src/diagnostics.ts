// "Copy diagnostics" (app: Help menu; extension: side panel), for bug reports. Versions,
// the system, the mode, the connection and the last log lines: never file contents, keys
// or tokens. The whole block goes through `redactDiagnostics` before it's copied, so even
// a log line that slipped something in comes out without it.

import { looksRandom, REDACTED, redactSecrets } from './redact';

/** Log lines a diagnostics block carries, newest last. */
export const DIAGNOSTICS_LOG_LINES = 50;

/** The longest log line kept, so one runaway line can't fill the block. */
export const MAX_LOG_LINE_CHARS = 500;

/**
 * Long hex or base64 runs: pairing keys, proofs, nonces and hashes. Diagnostics never need
 * them, and `redactSecrets` leaves bare ones alone (it looks for key words or known shapes).
 * Slashes split a run, so paths stay readable.
 */
const KEY_LIKE = /[A-Za-z0-9+_=-]{32,}/g;
const redactKeyLike = (run: string) =>
  /^[0-9a-f]+$/i.test(run) || looksRandom(run) ? REDACTED : run;

/** `home` (and its backslash form) at the start of a path becomes `~`. */
export function shortenHome(text: string, home: string | null | undefined): string {
  const trimmed = home?.replace(/[\\/]+$/, '');
  if (!trimmed || trimmed.length < 2) return text;
  const forms = new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')]);
  let out = text;
  for (const form of forms) {
    // Only where the home folder is a whole path prefix: /Users/al, not /Users/alice.
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}(?=[\\\\/]|$|[\\s"'\`),;:])`, 'gi'), '~');
  }
  return out;
}

/** Diagnostics text with home paths shortened, key-like runs and likely secrets redacted. */
export function redactDiagnostics(text: string, home?: string | null): string {
  return redactSecrets(shortenHome(text, home).replace(KEY_LIKE, redactKeyLike)).text;
}

/** One log line as it's kept: one line, capped, home shortened and redacted. */
export function logLine(text: string, home?: string | null): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\r\n]+/g, ' ⏎ ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const capped = flat.length > MAX_LOG_LINE_CHARS ? `${flat.slice(0, MAX_LOG_LINE_CHARS)}…` : flat;
  return redactDiagnostics(capped, home);
}

/**
 * The browser and version from a User-Agent string: `Chrome 141.0.7390.54`, `Edge 141.0…`,
 * or null. Brave and Arc say Chrome. The app reads it from the extension's socket request.
 */
export function browserFromUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  for (const [token, name] of [
    ['Edg', 'Edge'],
    ['OPR', 'Opera'],
    ['Chrome', 'Chrome']
  ] as const) {
    const version = new RegExp(`\\b${token}/(\\d+(?:\\.\\d+){0,3})`).exec(userAgent)?.[1];
    if (version) return `${name} ${version}`;
  }
  return null;
}

export interface DiagnosticsInput {
  /** Which side copied it: the app or the extension. */
  source: 'app' | 'extension';
  /** Label and value, in order. Missing values read "unknown". */
  fields: readonly (readonly [string, string | number | null | undefined])[];
  /** Recent log lines, oldest first; only the last `DIAGNOSTICS_LOG_LINES` are kept. */
  log: readonly string[];
  /** The user's home folder, shown as `~`. */
  home?: string | null;
  /** ISO time it was copied. */
  time: string;
}

/** The block "Copy diagnostics" puts on the clipboard. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const width = Math.max(...input.fields.map(([label]) => label.length));
  const lines = [
    `Bridge diagnostics (${input.source === 'app' ? 'from the app' : 'from the extension'})`,
    `Copied: ${input.time}`,
    ...input.fields.map(
      ([label, value]) =>
        `${`${label}:`.padEnd(width + 2)}${value === null || value === undefined || value === '' ? 'unknown' : value}`
    ),
    '',
    `Last ${DIAGNOSTICS_LOG_LINES} log lines:`,
    ...(input.log.length === 0 ? ['(none)'] : input.log.slice(-DIAGNOSTICS_LOG_LINES)),
    '',
    'No file contents, keys or tokens are included; paths start at ~.'
  ];
  return redactDiagnostics(lines.join('\n'), input.home);
}
