import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCurrentFuseWire } from '@electron/fuses';

interface FusesModule {
  (context: unknown): Promise<void>;
  FUSES: Record<string, boolean>;
  electronBinary(appOutDir: string, platform: string, productFilename: string): string;
  mismatches(wire: Record<string, unknown>): { fuse: string; wanted: string; found: string }[];
}
const afterPack = createRequire(import.meta.url)('../../scripts/fuses.cjs') as FusesModule;

/** Electron's sentinel, then wire version 1, 8 fuses, each at Electron's default. */
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const ELECTRON_DEFAULTS = '10110011';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-fuses-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Electron fuses', () => {
  it('turns off RunAsNode, NODE_OPTIONS and --inspect, and turns on asar-only and cookie encryption', () => {
    expect(afterPack.FUSES).toEqual({
      0: false, // RunAsNode
      1: true, // EnableCookieEncryption
      2: false, // EnableNodeOptionsEnvironmentVariable
      3: false, // EnableNodeCliInspectArguments
      4: true, // EnableEmbeddedAsarIntegrityValidation
      5: true // OnlyLoadAppFromAsar
    });
  });

  it('finds the binary in each platform’s packaged app', () => {
    expect(afterPack.electronBinary('/out', 'darwin', 'Bridge')).toBe(join('/out', 'Bridge.app'));
    expect(afterPack.electronBinary('/out', 'win32', 'Bridge')).toBe(join('/out', 'Bridge.exe'));
    expect(afterPack.electronBinary('/out', 'linux', 'Bridge')).toBe(join('/out', 'bridge'));
  });

  it('flips them in the binary at packaging, and the check then passes', async () => {
    const binary = join(dir, 'bridge');
    writeFileSync(
      binary,
      Buffer.concat([
        Buffer.from('ELF…'),
        Buffer.from(SENTINEL),
        Buffer.from([1, ELECTRON_DEFAULTS.length]),
        Buffer.from(ELECTRON_DEFAULTS),
        Buffer.from('…rest')
      ])
    );
    expect(afterPack.mismatches(await getCurrentFuseWire(binary))).toHaveLength(6);
    await afterPack({
      appOutDir: dir,
      electronPlatformName: 'linux',
      arch: 1,
      packager: { appInfo: { productFilename: 'Bridge' } }
    });
    expect(afterPack.mismatches(await getCurrentFuseWire(binary))).toEqual([]);
  });
});
