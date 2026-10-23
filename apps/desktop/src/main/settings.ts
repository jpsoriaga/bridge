import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_STEP_LIMIT,
  MAX_ALLOWLIST_ENTRIES,
  MAX_ALLOWLIST_ENTRY_CHARS,
  MAX_RUN_TIMEOUT_MS,
  MAX_STEP_LIMIT,
  MIN_RUN_TIMEOUT_MS,
  parseAllowlistEntry,
  UPDATE_CHANNELS,
  type UpdateChannel
} from '@bridge/shared';
import { isValidEnvPattern, MAX_ENV_PATTERNS } from './commands/env';
import { isUsablePath } from './commands/login-env';

export const MAX_DENY_PATTERNS = 50;
export const MAX_DENY_PATTERN_LENGTH = 200;
export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 90;

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

/** Where the window was, to open it there again. */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

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
  /**
   * Allowlist entries are exact unless they end in ` *` (since Phase 7). Lists saved before
   * that allowed extra arguments everywhere, so reading one adds ` *` to every entry once
   * and sets `allowlistNote` until the user has seen it in Settings.
   */
  allowlistFormat: 2;
  allowlistNote: boolean;
  /** The user's additions to the gated files, in .gitignore syntax. */
  gatedPatterns: string[];
  /** The user's additions to the environment filter. */
  envPatterns: string[];
  runTimeoutMs: number;
  /** The timeout for `<manager> install` (`isInstallCommand`), which takes longer. */
  installTimeoutMs: number;
  /**
   * Projects (by id) that already answered, or never needed, the one-time "Add
   * `<manager> install`?" note: lists confirmed before 1.1.0 get it once.
   */
  installNoteSeen: string[];
  stepLimit: number;
  pauseOnFailure: boolean;
  /** Full auto syncs with the chat after the computer sleeps, instead of pausing. */
  catchUpAfterSleep: boolean;
  /** The PATH commands get instead of the login shell's. Empty: no override. */
  pathOverride: string;
  theme: Theme;
  /** Days ops and backups are kept, 1–90. */
  backupRetentionDays: number;
  /** The first-run checklist was closed. Help reopens it. */
  onboardingDismissed: boolean;
  /** A chat session was started at least once (the checklist's last step). */
  sessionStarted: boolean;
  /** Check GitHub Releases for a newer version at launch. Off unless the user turns it on. */
  checkUpdatesOnStart: boolean;
  /**
   * The update channel the user picked in Settings → About. Unset: the build's own
   * (`defaultChannel`: beta for a beta build, stable otherwise).
   */
  updateChannel?: UpdateChannel;
  windowBounds?: WindowBounds;
}

function isWindowBounds(value: unknown): value is WindowBounds {
  const b = value as Partial<WindowBounds> | null;
  return (
    typeof b === 'object' &&
    b !== null &&
    [b.x, b.y, b.width, b.height].every((n) => Number.isInteger(n) && Math.abs(n!) < 100_000) &&
    b.width! >= 200 &&
    b.height! >= 200 &&
    typeof b.maximized === 'boolean'
  );
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

/** An entry from before exact matching, as it behaved then: extra arguments allowed. */
export const withAnyArguments = (entry: string): string =>
  parseAllowlistEntry(entry)?.extra ? entry : `${entry} *`;

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
    const migrate = data.allowlistFormat !== 2;
    let migrated = false;
    if (typeof data.allowlists === 'object' && data.allowlists !== null) {
      for (const [id, list] of Object.entries(data.allowlists)) {
        if (!/^[0-9a-f]{16}$/.test(id) || !isValidAllowlist(list)) continue;
        const next = migrate ? list.map(withAnyArguments).filter(isValidAllowlistEntry) : list;
        migrated ||= migrate && next.some((entry, i) => entry !== list[i]);
        allowlists[id] = next;
      }
    }
    const settings: Settings = {
      recentProjects: Array.isArray(data.recentProjects)
        ? data.recentProjects.filter(isAbsolutePath).slice(0, 5)
        : [],
      denyPatterns: patterns(data.denyPatterns, isValidDenyPattern, MAX_DENY_PATTERNS),
      mode: data.mode === 'auto-apply' ? 'auto-apply' : 'manual',
      allowlists,
      allowlistFormat: 2,
      allowlistNote: migrated || (!migrate && data.allowlistNote === true),
      gatedPatterns: patterns(data.gatedPatterns, isValidDenyPattern, MAX_DENY_PATTERNS),
      envPatterns: patterns(data.envPatterns, isValidEnvPattern, MAX_ENV_PATTERNS),
      runTimeoutMs: clampInt(
        data.runTimeoutMs,
        MIN_RUN_TIMEOUT_MS,
        MAX_RUN_TIMEOUT_MS,
        DEFAULT_RUN_TIMEOUT_MS
      ),
      installTimeoutMs: clampInt(
        data.installTimeoutMs,
        MIN_RUN_TIMEOUT_MS,
        MAX_RUN_TIMEOUT_MS,
        DEFAULT_INSTALL_TIMEOUT_MS
      ),
      installNoteSeen: Array.isArray(data.installNoteSeen)
        ? data.installNoteSeen
            .filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id))
            .slice(-1000)
        : [],
      stepLimit: clampInt(data.stepLimit, 1, MAX_STEP_LIMIT, DEFAULT_STEP_LIMIT),
      pauseOnFailure: data.pauseOnFailure === true,
      catchUpAfterSleep: data.catchUpAfterSleep !== false,
      pathOverride: isUsablePath(data.pathOverride) ? data.pathOverride : '',
      theme: THEMES.includes(data.theme as Theme) ? (data.theme as Theme) : 'system',
      backupRetentionDays: clampInt(
        data.backupRetentionDays,
        1,
        MAX_RETENTION_DAYS,
        DEFAULT_RETENTION_DAYS
      ),
      onboardingDismissed: data.onboardingDismissed === true,
      sessionStarted: data.sessionStarted === true,
      checkUpdatesOnStart: data.checkUpdatesOnStart === true
    };
    if (isWindowBounds(data.windowBounds)) settings.windowBounds = data.windowBounds;
    if (Number.isInteger(data.port)) settings.port = data.port as number;
    if (isAbsolutePath(data.project)) settings.project = data.project;
    if (UPDATE_CHANNELS.includes(data.updateChannel as UpdateChannel)) {
      settings.updateChannel = data.updateChannel as UpdateChannel;
    }
    return settings;
  }

  return {
    read,
    update(patch: Partial<Settings>): void {
      const next = { ...read(), ...patch };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }
  };
}
