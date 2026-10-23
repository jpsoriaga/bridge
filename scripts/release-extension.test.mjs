import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { manifestFields, releaseBuilds, releaseProblems } from './release-extension.mjs';
import { listFiles, zip, zipDir } from './zip.mjs';

/** Reads a zip back through its central directory: name → contents. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    expect(buffer.readUInt32LE(at)).toBe(0x02014b50);
    const crc = buffer.readUInt32LE(at + 16);
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(offset + 26);
    const start = offset + 30 + localNameLength;
    const data = inflateRawSync(buffer.subarray(start, start + size));
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString('utf8');
    at += 46 + nameLength;
  }
  return out;
}

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-zip-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('zip', () => {
  it('round-trips files at the root, sorted, with the same bytes every time', () => {
    const dir = tree({ 'manifest.json': '{}', 'assets/a.js': 'x'.repeat(5000), 'b é.txt': 'é' });
    expect(listFiles(dir)).toEqual(['assets/a.js', 'b é.txt', 'manifest.json']);
    const first = zipDir(dir);
    expect(zipDir(dir).equals(first)).toBe(true);
    expect(unzip(first)).toEqual({
      'assets/a.js': 'x'.repeat(5000),
      'b é.txt': 'é',
      'manifest.json': '{}'
    });
    expect(zip([]).length).toBe(22);
  });
});

describe('releaseProblems', () => {
  const manifest = (extra = {}) =>
    JSON.stringify({ manifest_version: 3, name: 'Bridge', version: '1.0.0', ...extra });

  it('passes a store build, and an unpacked build with its key', () => {
    const dir = tree({ 'manifest.json': manifest(), 'assets/a.js': 'console.log(1)' });
    expect(releaseProblems(dir, '1.0.0')).toEqual([]);
    expect(releaseProblems(dir, '1.0.0', { key: true })).toEqual(['manifest.json has no key']);
    const keyed = tree({ 'manifest.json': manifest({ key: 'MIIB' }) });
    expect(releaseProblems(keyed, '1.0.0', { key: true })).toEqual([]);
  });

  it('catches a key, a wrong version, source maps, dev-only code and the e2e ports', () => {
    const dir = tree({
      'manifest.json': manifest({ key: 'MIIB', host_permissions: ['<all_urls>'] }),
      'assets/a.js': 'x\n//# sourceMappingURL=a.js.map',
      'assets/a.js.map': '{}',
      'assets/panel.js': '"Test read (dev only)"',
      'assets/worker.js': 'const p=47921'
    });
    expect(releaseProblems(dir, '1.0.1')).toEqual([
      'manifest.json still has a key',
      'manifest version 1.0.0, expected 1.0.1',
      'manifest asks for <all_urls>',
      'assets/a.js: links a source map',
      'assets/a.js.map: source map',
      'assets/panel.js: dev-only code ((dev only))',
      'assets/worker.js: built for the e2e port range'
    ]);
  });
});

describe('betas', () => {
  it('build only the Load unpacked zip, with the fixed ID', () => {
    expect(releaseBuilds('1.2.0').map((b) => b.zip)).toEqual([
      'bridge-extension-1.2.0.zip',
      'bridge-extension-1.2.0-unpacked.zip'
    ]);
    const beta = releaseBuilds('1.2.0-beta.1');
    expect(beta.map((b) => b.zip)).toEqual(['bridge-extension-1.2.0-beta.1-unpacked.zip']);
    expect(beta[0].key).toBe(true);
  });

  it('split the version: numbers in version, the beta in version_name', () => {
    expect(manifestFields('1.2.0')).toEqual({ version: '1.2.0' });
    expect(manifestFields('1.2.0-beta.1')).toEqual({
      version: '1.2.0',
      version_name: '1.2.0-beta.1'
    });
    const manifest = (extra) =>
      JSON.stringify({ manifest_version: 3, name: 'Bridge', key: 'MIIB', ...extra });
    const good = tree({
      'manifest.json': manifest({ version: '1.2.0', version_name: '1.2.0-beta.1' })
    });
    expect(releaseProblems(good, '1.2.0-beta.1', { key: true })).toEqual([]);
    const bad = tree({ 'manifest.json': manifest({ version: '1.2.0-beta.1' }) });
    expect(releaseProblems(bad, '1.2.0-beta.1', { key: true })).toEqual([
      'manifest version 1.2.0-beta.1, expected 1.2.0',
      'manifest version_name undefined, expected 1.2.0-beta.1'
    ]);
    const stray = tree({ 'manifest.json': manifest({ version: '1.2.0', version_name: 'x' }) });
    expect(releaseProblems(stray, '1.2.0', { key: true })).toEqual([
      'manifest version_name x, expected undefined'
    ]);
  });
});
