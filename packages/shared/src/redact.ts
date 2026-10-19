// Likely secrets in text Bridge is about to put into the chat: command output and file
// contents. Each match becomes `[redacted]`. The patterns favour catching real credentials
// over leaving every string alone, but stay narrow enough that ordinary code (types, env
// lookups, hashes without a key word, UUIDs) passes through. See SECURITY.md.

export const REDACTED = '[redacted]';

/** Fixed shapes: provider prefixes, JWTs and PEM blocks. */
const SHAPES: readonly RegExp[] = [
  // PEM blocks, private keys or certificates. An unterminated one runs to the end.
  /-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g,
  // sk-… (and sk-proj-…, sk-ant-…): API keys from several providers.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub: classic personal, OAuth, user, server and refresh tokens; fine-grained PATs.
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key ids (long-term and temporary).
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack bot and user tokens.
  /\bxox[bp]-[A-Za-z0-9-]{10,}/g,
  // JSON Web Tokens: three base64url parts, the first a JSON header.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];

/**
 * A key word, then `:` or `=` (optionally quoted), then the value. Only the value is
 * redacted, and only if it looks random (`looksRandom`).
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:key|token|secret|passwd|password|credential|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([A-Za-z0-9+/=_.~-]{16,})/gi;

/** `Authorization: Bearer <token>` and the like: the token, if it looks random. */
const BEARER = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9+/=_.~-]{16,})/g;

/** Bits per character of `text`, by character frequency. */
export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A value next to a key word that reads like a credential: 16+ characters, letters and
 * digits mixed, and high entropy. `process.env.API_KEY`, `MY_SECRET_NAME`,
 * `hello-world-text` and the like don't qualify.
 */
export function looksRandom(value: string): boolean {
  if (value.length < 16) return false;
  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false;
  // A dotted lookup (process.env.X, config.auth.token) is code, not a value.
  if (/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)+$/.test(value)) return false;
  return entropy(value) >= 3.5;
}

/** `text` with likely secrets replaced by `[redacted]`, and how many were. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const shape of SHAPES) {
    out = out.replace(shape, () => {
      count += 1;
      return REDACTED;
    });
  }
  out = out.replace(BEARER, (match, scheme: string, space: string, value: string) => {
    if (!looksRandom(value)) return match;
    count += 1;
    return `${scheme}${space}${REDACTED}`;
  });
  out = out.replace(ASSIGNMENT, (match, name: string, sep: string, value: string) => {
    if (!looksRandom(value)) return match;
    count += 1;
    return `${name}${sep}${REDACTED}`;
  });
  return { text: out, count };
}
