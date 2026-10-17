import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STEP_LIMIT,
  MAX_ALLOWLIST_ENTRIES,
  MAX_ALLOWLIST_ENTRY_CHARS,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  parseAllowlistEntry
} from '@bridge/shared';
import { isValidEnvPattern, MAX_ENV_PATTERNS } from './commands/env';
import { isUsablePath } from './commands/login-env';

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
  /**
   * The mode to start in. Never `full-auto`: Full auto is opt-in per launch, so turning it
   * on saves `manual` here.
   */
  mode: 'manual' | 'auto-apply';
  /**
   * Confirmed command allowlists, by project id (`projectId` of the real root). A project
   * with no entry hasn't been confirmed yet, and the app suggests defaults.
   */
  allowlists: Record<string, string[]>;
  /** The user's additions to the gated files, in .gitignore syntax. */
  gatedPatterns: string[];
  /** The user's additions to the environment filter. */
  envPatterns: string[];
  runTimeoutMs: number;
  stepLimit: number;
  pauseOnFailure: boolean;
  /** The PATH commands get instead of the login shell's. Empty: no override. */
  pathOverride: string;
}

/** An allowlist entry the user may save: a command shell-quote can split, with no shell syntax. */
export function isValidAllowlistEntry(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= MAX_ALLOWLIST_ENTRY_CHARS &&
    parseAllowlistEntry(value) !== null
  );
}

export function isValidAllowlist(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ALLOWLIST_ENTRIES &&
    value.every(isValidAllowlistEntry)
  );
}

const clampInt = (value: unknown, min: number, max: number, fallback: number) =>
  Number.isInteger(value) ? Math.min(max, Math.max(min, value as number)) : fallback;

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
      data = {};
    }
    const patterns = (value: unknown, valid: (v: unknown) => boolean, max: number) =>
      Array.isArray(value) ? (value.filter(valid) as string[]).slice(0, max) : [];
    const allowlists: Record<string, string[]> = {};
    if (typeof data.allowlists === 'object' && data.allowlists !== null) {
      for (const [id, list] of Object.entries(data.allowlists)) {
        if (/^[0-9a-f]{16}$/.test(id) && isValidAllowlist(list)) allowlists[id] = list;
      }
    }
    const settings: Settings = {
      recentProjects: Array.isArray(data.recentProjects)
        ? data.recentProjects.filter(isAbsolutePath).slice(0, 5)
        : [],
      denyPatterns: patterns(data.denyPatterns, isValidDenyPattern, MAX_DENY_PATTERNS),
      mode: data.mode === 'auto-apply' ? 'auto-apply' : 'manual',
      allowlists,
      gatedPatterns: patterns(data.gatedPatterns, isValidDenyPattern, MAX_DENY_PATTERNS),
      envPatterns: patterns(data.envPatterns, isValidEnvPattern, MAX_ENV_PATTERNS),
      runTimeoutMs: clampInt(
        data.runTimeoutMs,
        MIN_RUN_TIMEOUT_MS,
        MAX_RUN_TIMEOUT_MS,
        DEFAULT_RUN_TIMEOUT_MS
      ),
      stepLimit: clampInt(data.stepLimit, 1, MAX_STEP_LIMIT, DEFAULT_STEP_LIMIT),
      pauseOnFailure: data.pauseOnFailure === true,
      pathOverride: isUsablePath(data.pathOverride) ? data.pathOverride : ''
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
