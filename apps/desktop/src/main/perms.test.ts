import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { History } from './project/history';
import { tempProject } from './project/test-utils';
import { securePrivateData } from './perms';
import { settingsFile } from './settings';
import { fileTokenStore } from './server/token-store';

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe.runIf(process.platform !== 'win32')('private data permissions', () => {
  let base: ReturnType<typeof tempProject>;
  let userData: string;
  beforeEach(() => {
    base = tempProject('bridge-perms-');
    userData = join(base.base, 'userData');
  });
  afterEach(() => base.cleanup());

  it('creates settings, the pairing key, backups and the op log private', async () => {
    settingsFile(join(userData, 'settings.json')).update({ mode: 'manual' });
    fileTokenStore(join(userData, 'pairing.json'), {
      isEncryptionAvailable: () => false,
      encryptString: (s) => Buffer.from(s),
      decryptString: (b) => b.toString()
    }).save(Buffer.alloc(32, 1));
    const history = await History.open(join(userData, 'backups/p1'));
    await history.backup('op-1', Buffer.from('before'), Buffer.from('after'));
    await history.commit({
      opId: 'op-1',
      time: Date.now(),
      path: 'a.txt',
      kind: 'modify',
      beforeHash: 'a'.repeat(64),
      afterHash: 'b'.repeat(64)
    });
    expect(modeOf(userData)).toBe(0o700);
    expect(modeOf(join(userData, 'settings.json'))).toBe(0o600);
    expect(modeOf(join(userData, 'pairing.json'))).toBe(0o600);
    expect(modeOf(join(userData, 'backups'))).toBe(0o700);
    expect(modeOf(join(userData, 'backups/p1'))).toBe(0o700);
    expect(modeOf(join(userData, 'backups/p1/op-1'))).toBe(0o700);
    expect(modeOf(join(userData, 'backups/p1/op-1/before'))).toBe(0o600);
    expect(modeOf(join(userData, 'backups/p1/log.json'))).toBe(0o600);
    expect(await securePrivateData(userData)).toEqual([]);
  });

  it('tightens anything looser at startup, and leaves symlinks and other files alone', async () => {
    mkdirSync(join(userData, 'backups/p1/op-1'), { recursive: true });
    writeFileSync(join(userData, 'settings.json'), '{}');
    writeFileSync(join(userData, 'backups/p1/log.json'), '{}');
    writeFileSync(join(userData, 'backups/p1/op-1/before'), 'x');
    writeFileSync(join(userData, 'Cookies'), '');
    const elsewhere = base.write('elsewhere.txt', 'x', base.base);
    chmodSync(elsewhere, 0o644);
    symlinkSync(elsewhere, join(userData, 'backups/p1/link'));
    for (const path of [userData, join(userData, 'backups'), join(userData, 'backups/p1')]) {
      chmodSync(path, 0o755);
    }
    chmodSync(join(userData, 'backups/p1/op-1'), 0o777);
    chmodSync(join(userData, 'settings.json'), 0o644);
    chmodSync(join(userData, 'backups/p1/log.json'), 0o666);
    chmodSync(join(userData, 'backups/p1/op-1/before'), 0o744);
    chmodSync(join(userData, 'Cookies'), 0o644);

    const fixed = await securePrivateData(userData);
    expect(fixed).toHaveLength(7);
    expect(modeOf(userData)).toBe(0o700);
    expect(modeOf(join(userData, 'backups/p1/op-1'))).toBe(0o700);
    expect(modeOf(join(userData, 'settings.json'))).toBe(0o600);
    expect(modeOf(join(userData, 'backups/p1/log.json'))).toBe(0o600);
    // The owner's execute bit stays; nobody else gets anything.
    expect(modeOf(join(userData, 'backups/p1/op-1/before'))).toBe(0o700);
    // Not Bridge's, and not through a symlink.
    expect(modeOf(join(userData, 'Cookies'))).toBe(0o644);
    expect(modeOf(elsewhere)).toBe(0o644);
    expect(await securePrivateData(userData)).toEqual([]);
  });

  it('does nothing on Windows', async () => {
    mkdirSync(userData, { recursive: true });
    chmodSync(userData, 0o755);
    expect(await securePrivateData(userData, 'win32')).toEqual([]);
  });
});
