import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

export const MAX_DENY_PATTERNS = 50;
export const MAX_DENY_PATTERN_LENGTH = 200;

export interface Settings {
  /** The port the server bound last time it started. Shown in the UI. */
  port?: number;
  /** Real path of the open project, reopened on launch. */
  project?: string;
  /** Newest first, at most 5. */
  recentProjects: string[];
  /** The user's additions to the denylist, in .gitignore syntax. */
  denyPatterns: string[];
}

const isAbsolutePath = (value: unknown): value is string =>
  typeof value === 'string' && value.length < 4096 && isAbsolute(value);

/** A pattern the user may add. No negation ("!"), so the defaults can't be undone. */
export function isValidDenyPattern(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_DENY_PATTERN_LENGTH &&
    !value.startsWith('!') &&
    !value.startsWith('#') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

/** A small JSON file under userData. Unknown or malformed content reads as defaults. */
export function settingsFile(path: string) {
  function read(): Settings {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return { recentProjects: [], denyPatterns: [] };
    }
    const settings: Settings = {
      recentProjects: Array.isArray(data.recentProjects)
        ? data.recentProjects.filter(isAbsolutePath).slice(0, 5)
        : [],
      denyPatterns: Array.isArray(data.denyPatterns)
        ? data.denyPatterns.filter(isValidDenyPattern).slice(0, MAX_DENY_PATTERNS)
        : []
    };
    if (Number.isInteger(data.port)) settings.port = data.port as number;
    if (isAbsolutePath(data.project)) settings.project = data.project;
    return settings;
  }

  return {
    read,
    update(patch: Partial<Settings>): void {
      const next = { ...read(), ...patch };
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${path}.tmp`, path);
    }
  };
}
