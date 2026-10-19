// "Check for updates": notify only. Bridge asks GitHub Releases whether a newer version
// exists and shows a link to it. It never downloads or installs anything, and it asks only
// when the user clicks the button or turned on "Check when Bridge starts" (off by default).
// That request to github.com is the app's only network call that isn't loopback.

import type { UpdateCheck } from '../preload/api';

/** The repository whose Releases the app checks and links to. */
export const RELEASES_URL = 'https://github.com/jpsoriaga/bridge/releases';

export function releaseUrl(version: string): string {
  return `${RELEASES_URL}/tag/v${version}`;
}

/**
 * Why checking is off in this build: `dev` (`pnpm dev` or an unpackaged app, nothing to compare
 * with) or `unsigned-mac` (an unsigned macOS build, which couldn't update itself anyway).
 */
export type UpdatesOff = Extract<UpdateCheck, { state: 'off' }>['reason'];

/** The part of electron-updater's `AppUpdater` Bridge uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: { version: string };
  } | null>;
}

export interface UpdatesOptions {
  /** Null when checking is on. */
  off: UpdatesOff | null;
  /** Loads electron-updater on first use, so a build that never checks never loads it. */
  load: () => Promise<UpdaterLike>;
  onChange?: (check: UpdateCheck | null) => void;
  now?: () => number;
}

/** Whether this build may check: packaged, and on macOS signed (`bridgeBuild.updates`). */
export function updatesOff(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** `bridgeBuild.updates` from the packaged package.json; false in unsigned macOS builds. */
  buildAllowsUpdates: boolean;
}): UpdatesOff | null {
  if (!options.isPackaged) return 'dev';
  if (options.platform === 'darwin' && !options.buildAllowsUpdates) return 'unsigned-mac';
  return null;
}

export class Updates {
  private last: UpdateCheck | null;
  private updater: Promise<UpdaterLike> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: UpdatesOptions) {
    this.now = options.now ?? Date.now;
    this.last = options.off ? { state: 'off', reason: options.off } : null;
  }

  /** The last check's result, or null if none ran yet. */
  get state(): UpdateCheck | null {
    return this.last;
  }

  /** Asks GitHub Releases once. Never downloads; a failure is reported, not thrown. */
  async check(): Promise<UpdateCheck> {
    if (this.options.off) return this.set({ state: 'off', reason: this.options.off });
    if (this.last?.state === 'checking') return this.last;
    this.set({ state: 'checking' });
    try {
      const updater = await this.configured();
      const result = await updater.checkForUpdates();
      const checkedAt = this.now();
      if (!result) return this.set({ state: 'failed', checkedAt });
      const { version } = result.updateInfo;
      return this.set(
        result.isUpdateAvailable
          ? { state: 'available', version, url: releaseUrl(version), checkedAt }
          : { state: 'current', version, checkedAt }
      );
    } catch {
      // Offline, rate-limited by GitHub, or no release yet. Nothing to do but say so.
      return this.set({ state: 'failed', checkedAt: this.now() });
    }
  }

  private configured(): Promise<UpdaterLike> {
    this.updater ??= this.options.load().then((updater) => {
      // Notify only: nothing is downloaded or installed, ever.
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      updater.logger = null;
      return updater;
    });
    return this.updater;
  }

  private set(check: UpdateCheck): UpdateCheck {
    this.last = check;
    this.options.onChange?.(check);
    return check;
  }
}
