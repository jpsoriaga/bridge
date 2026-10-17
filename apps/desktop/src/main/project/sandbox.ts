import { lstat, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { MAX_PATH_LENGTH, type FileErrorCode } from '@bridge/shared';

/**
 * Paths Bridge never reads, writes or lists, in .gitignore syntax and matched without
 * regard to case. The one list; users can add to it in Settings but never remove from it.
 * `node_modules/` is listed but shown collapsed in the tree.
 */
export const DEFAULT_DENYLIST: readonly string[] = [
  '.git/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'node_modules/'
];

export type SandboxCode = Extract<
  FileErrorCode,
  'invalid-path' | 'absolute-path' | 'traversal' | 'denied' | 'outside-root' | 'not-a-file'
>;

export type Checked =
  { ok: true; rel: string; segments: string[] } | { ok: false; code: SandboxCode };

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * The lexical half of the sandbox: is this a relative POSIX path we are willing to touch?
 * Returns the NFC form, which is what every later step uses.
 */
export function checkPath(input: unknown, platform: NodeJS.Platform = process.platform): Checked {
  if (typeof input !== 'string') return { ok: false, code: 'invalid-path' };
  const rel = input.normalize('NFC');
  if (rel.length === 0 || rel.length > MAX_PATH_LENGTH) return { ok: false, code: 'invalid-path' };
  // NUL and other control characters, including the ones Windows forbids in names.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(rel)) return { ok: false, code: 'invalid-path' };
  // /etc, //server/share, \\server\share, \x, C:, C:\x, C:x
  if (/^[/\\]/.test(rel) || /^[a-z]:/i.test(rel)) return { ok: false, code: 'absolute-path' };
  // Separators are "/" only. A backslash is a separator on Windows, so refuse it everywhere.
  if (rel.includes('\\')) return { ok: false, code: 'invalid-path' };
  // ":" names an NTFS alternate data stream or a drive.
  if (rel.includes(':')) return { ok: false, code: 'invalid-path' };

  const segments = rel.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return { ok: false, code: 'traversal' };
  for (const segment of segments) {
    if (segment === '') return { ok: false, code: 'invalid-path' };
    // Windows drops trailing dots and spaces, so ".git." would open ".git".
    if (/[. ]$/.test(segment)) return { ok: false, code: 'invalid-path' };
    if (platform === 'win32' && WINDOWS_DEVICE.test(segment)) {
      return { ok: false, code: 'invalid-path' };
    }
  }
  return { ok: true, rel, segments };
}

/** Default denylist plus the user's own patterns, kept apart so "!" can't undo a default. */
export class Denylist {
  private readonly defaults: Ignore;
  private readonly user: Ignore;

  constructor(extra: readonly string[] = []) {
    this.defaults = ignore({ ignorecase: true }).add([...DEFAULT_DENYLIST]);
    this.user = ignore({ ignorecase: true }).add(extra.filter((p) => !p.startsWith('!')));
  }

  /** `rel` is a checked relative POSIX path. Tests it as a file and as a directory. */
  matches(rel: string): boolean {
    for (const ig of [this.defaults, this.user]) {
      if (ig.ignores(rel) || ig.ignores(`${rel}/`)) return true;
    }
    return false;
  }
}

export type Resolved =
  | {
      ok: true;
      /** NFC, relative, POSIX. Safe to show and to send back. */
      rel: string;
      /** Real absolute path inside the root. Never sent to the extension. */
      abs: string;
      /** What is there now: a file, a directory, or nothing. */
      kind: 'file' | 'dir' | 'missing';
    }
  | { ok: false; code: SandboxCode };

const toPosix = (p: string) => p.split(sep).join('/');

/**
 * Turns an untrusted relative path into a real path inside the project, or a typed refusal.
 * Every component is checked as it is walked: a symlink is followed with realpath and must
 * land inside the real root and outside the denylist. The first missing component ends the
 * walk, so a new file's nearest existing parent is always a real, checked directory.
 */
export class Sandbox {
  private constructor(
    /** realpath of the project folder. */
    readonly root: string,
    readonly denylist: Denylist
  ) {}

  static async create(root: string, extraPatterns: readonly string[] = []): Promise<Sandbox> {
    return new Sandbox(await realpath(root), new Denylist(extraPatterns));
  }

  /** True when a real absolute path is inside the root (or is the root). */
  contains(real: string): boolean {
    return (
      real === this.root || real.startsWith(this.root.endsWith(sep) ? this.root : this.root + sep)
    );
  }

  /** Relative POSIX path of a real path inside the root. */
  relativeOf(real: string): string {
    return toPosix(relative(this.root, real)).normalize('NFC');
  }

  async resolve(input: unknown): Promise<Resolved> {
    const checked = checkPath(input);
    if (!checked.ok) return checked;
    if (this.denylist.matches(checked.rel)) return { ok: false, code: 'denied' };

    let current = this.root;
    let kind: 'file' | 'dir' = 'dir';
    const { rel, segments } = checked;
    for (let i = 0; i < segments.length; i++) {
      // A file in the middle of the path ("a.txt/b").
      if (kind === 'file') return { ok: false, code: 'not-a-file' };
      const next = join(current, segments[i]!);
      let stats;
      try {
        stats = await lstat(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // `current` is the nearest existing parent, already real and checked.
        return { ok: true, rel, abs: join(current, ...segments.slice(i)), kind: 'missing' };
      }

      if (stats.isSymbolicLink()) {
        let real: string;
        try {
          real = await realpath(next);
        } catch {
          // Dangling or looping: there's no telling where a write would land.
          return { ok: false, code: 'outside-root' };
        }
        if (real === this.root || !this.contains(real)) return { ok: false, code: 'outside-root' };
        if (this.denylist.matches(this.relativeOf(real))) return { ok: false, code: 'denied' };
        stats = await lstat(real);
        current = real;
      } else {
        current = next;
      }

      if (stats.isDirectory()) kind = 'dir';
      else if (stats.isFile()) kind = 'file';
      else return { ok: false, code: 'not-a-file' }; // sockets, FIFOs, devices
    }
    return { ok: true, rel: checked.rel, abs: current, kind };
  }
}
