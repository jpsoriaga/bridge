// Bridge's versions: `MAJOR.MINOR.PATCH` for a release, `MAJOR.MINOR.PATCH-beta.N` for a
// beta. One version for the app, the extension and this package (scripts/version.mjs keeps
// them in step, with the same rule). Used for display, the extension manifest and the
// app's update channels.

/** Where the app looks for newer versions: stable releases only, or betas too. */
export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** The N of `-beta.N`, or null for a release. */
  beta: number | null;
}

/** Each part is 0–65535 with no leading zeros, which is what Chrome's manifest takes. */
const PART = '(0|[1-9]\\d{0,4})';
const VERSION = new RegExp(`^${PART}\\.${PART}\\.${PART}(?:-beta\\.([1-9]\\d{0,4}))?$`);

/** `1.2.0` or `1.2.0-beta.1` (a leading `v` is fine), or null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.replace(/^v/, ''));
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number
  ];
  const beta = match[4] === undefined ? null : Number(match[4]);
  if ([major, minor, patch, beta ?? 0].some((n) => n > 65535)) return null;
  return { major, minor, patch, beta };
}

export const isBetaVersion = (text: string): boolean => parseVersion(text)?.beta != null;

/**
 * Negative if `a` is older than `b`, positive if newer, 0 if the same. A beta comes before
 * its release (`1.2.0-beta.3` < `1.2.0`), as in semver. Unparseable versions throw.
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a Bridge version: ${x ? b : a}`);
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    (x.beta ?? Infinity) - (y.beta ?? Infinity) ||
    0
  );
}

/**
 * The extension manifest's `version` takes numbers only, so a beta keeps `MAJOR.MINOR.PATCH`
 * there and the full version in `version_name`, which Chrome shows instead.
 */
export function manifestVersion(text: string): { version: string; version_name?: string } {
  const version = parseVersion(text);
  if (!version) throw new Error(`Not a Bridge version: ${text}`);
  const release = `${version.major}.${version.minor}.${version.patch}`;
  return version.beta === null ? { version: release } : { version: release, version_name: text };
}

/** The channel a build starts on: betas check for betas, releases for releases. */
export const defaultChannel = (current: string): UpdateChannel =>
  isBetaVersion(current) ? 'beta' : 'stable';

/**
 * Whether `found` is worth telling the user about on `channel`: newer than `current`, and on
 * the stable channel never a beta.
 */
export function offersUpdate(channel: UpdateChannel, current: string, found: string): boolean {
  if (!parseVersion(found) || !parseVersion(current)) return false;
  if (channel === 'stable' && isBetaVersion(found)) return false;
  return compareVersions(found, current) > 0;
}
