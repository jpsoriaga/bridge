import { describe, expect, it, vi } from 'vitest';
import type { UpdateChannel } from '@bridge/shared';
import { releaseUrl, Updates, updatesOff, type UpdaterLike, type UpdatesOptions } from './updates';

/** A build of `version` checking on `channel`. */
const build = (version: string, channel: UpdateChannel = 'stable') =>
  ({ version, channel: () => channel }) satisfies Partial<UpdatesOptions>;

function fakeUpdater(
  result: Awaited<ReturnType<UpdaterLike['checkForUpdates']>> | Error
): UpdaterLike {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    logger: console,
    checkForUpdates: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    })
  };
}

describe('updatesOff', () => {
  it('is off in dev and in unsigned macOS builds only', () => {
    const base = { isPackaged: true, platform: 'darwin' as const, buildAllowsUpdates: true };
    expect(updatesOff(base)).toBeNull();
    expect(updatesOff({ ...base, isPackaged: false })).toBe('dev');
    expect(updatesOff({ ...base, buildAllowsUpdates: false })).toBe('unsigned-mac');
    // Windows and Linux builds only notify, signed or not.
    expect(updatesOff({ ...base, platform: 'win32', buildAllowsUpdates: false })).toBeNull();
    expect(updatesOff({ ...base, platform: 'linux', buildAllowsUpdates: false })).toBeNull();
  });
});

describe('Updates', () => {
  it('never loads the updater when off', async () => {
    const load = vi.fn();
    const updates = new Updates({ ...build('1.0.0'), off: 'unsigned-mac', load });
    expect(updates.state).toEqual({ state: 'off', reason: 'unsigned-mac' });
    expect(await updates.check()).toEqual({ state: 'off', reason: 'unsigned-mac' });
    expect(load).not.toHaveBeenCalled();
  });

  it('notifies only: turns off download and install before the first check', async () => {
    const updater = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '1.2.0' } });
    const changes: unknown[] = [];
    const updates = new Updates({
      ...build('1.1.0'),
      off: null,
      load: async () => updater,
      onChange: (c) => changes.push(c?.state),
      now: () => 42
    });
    expect(updates.state).toBeNull();
    expect(await updates.check()).toEqual({
      state: 'available',
      version: '1.2.0',
      url: 'https://github.com/jpsoriaga/bridge/releases/tag/v1.2.0',
      checkedAt: 42
    });
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
      logger: null
    });
    expect(changes).toEqual(['checking', 'available']);
  });

  it('says when it is current, and when the check failed', async () => {
    const current = new Updates({
      ...build('1.0.0'),
      off: null,
      load: async () => fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }),
      now: () => 1
    });
    expect(await current.check()).toEqual({ state: 'current', version: '1.0.0', checkedAt: 1 });

    const offline = new Updates({
      ...build('1.0.0'),
      off: null,
      load: async () => fakeUpdater(new Error('net::ERR_INTERNET_DISCONNECTED')),
      now: () => 2
    });
    expect(await offline.check()).toEqual({ state: 'failed', checkedAt: 2 });
    const inactive = new Updates({
      ...build('1.0.0'),
      off: null,
      load: async () => fakeUpdater(null),
      now: () => 3
    });
    expect(await inactive.check()).toEqual({ state: 'failed', checkedAt: 3 });
  });

  it('runs one check at a time and loads the updater once', async () => {
    let resolve!: (value: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void;
    const updater = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
    vi.mocked(updater.checkForUpdates).mockImplementationOnce(
      () => new Promise((r) => (resolve = r))
    );
    const load = vi.fn(async () => updater);
    const updates = new Updates({ ...build('1.0.0'), off: null, load });
    const first = updates.check();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalled());
    expect(await updates.check()).toEqual({ state: 'checking' });
    resolve({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
    await first;
    expect((await updates.check()).state).toBe('current');
    expect(load).toHaveBeenCalledTimes(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('never shows a beta on the stable channel, and reads no pre-releases there', async () => {
    // Say electron-updater found a beta anyway: stable still doesn't offer it.
    const updater = fakeUpdater({
      isUpdateAvailable: true,
      updateInfo: { version: '1.2.0-beta.1' }
    });
    const updates = new Updates({ ...build('1.1.0'), off: null, load: async () => updater });
    expect(await updates.check()).toMatchObject({ state: 'current', version: '1.1.0' });
    expect(updater.allowPrerelease).toBe(false);
  });

  it('shows newer betas and releases on the beta channel', async () => {
    const found = (version: string) => ({ isUpdateAvailable: true, updateInfo: { version } });
    const updater = fakeUpdater(found('1.2.0-beta.2'));
    const updates = new Updates({
      ...build('1.2.0-beta.1', 'beta'),
      off: null,
      load: async () => updater
    });
    expect(await updates.check()).toMatchObject({ state: 'available', version: '1.2.0-beta.2' });
    expect(updater.allowPrerelease).toBe(true);
    vi.mocked(updater.checkForUpdates).mockResolvedValueOnce(found('1.2.0'));
    expect(await updates.check()).toMatchObject({
      state: 'available',
      version: '1.2.0',
      url: 'https://github.com/jpsoriaga/bridge/releases/tag/v1.2.0'
    });
    // An older beta is not an update, whatever the updater says.
    vi.mocked(updater.checkForUpdates).mockResolvedValueOnce(found('1.1.0'));
    expect(await updates.check()).toMatchObject({ state: 'current', version: '1.2.0-beta.1' });
  });

  it('follows the channel the user switches to, check by check', async () => {
    let channel: UpdateChannel = 'beta';
    const updater = fakeUpdater({
      isUpdateAvailable: true,
      updateInfo: { version: '1.3.0-beta.1' }
    });
    const updates = new Updates({
      version: '1.2.0',
      channel: () => channel,
      off: null,
      load: async () => updater
    });
    expect((await updates.check()).state).toBe('available');
    channel = 'stable';
    expect((await updates.check()).state).toBe('current');
    expect(updater.allowPrerelease).toBe(false);
  });

  it('links to the tag of the version found', () => {
    expect(releaseUrl('2.0.1')).toBe('https://github.com/jpsoriaga/bridge/releases/tag/v2.0.1');
  });
});
