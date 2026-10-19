import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrivateKey } from 'node:crypto';
import { fileTokenStore, loadServerKey, type Cipher } from './token-store';

// Reversible stand-in for safeStorage.
const fakeCipher = (available: boolean): Cipher => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8'),
  decryptString: (buf) => [...buf.toString('utf8')].reverse().join('')
});

let dir: string;
let path: string;
const hash = Buffer.alloc(32, 0xab);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-token-'));
  path = join(dir, 'pairing.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fileTokenStore', () => {
  it('round-trips an encrypted hash and never writes it in the clear', () => {
    fileTokenStore(path, fakeCipher(true)).save(hash);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(hash.toString('hex'));
    expect(JSON.parse(raw)).toMatchObject({ v: 2, encrypted: true });
    expect(fileTokenStore(path, fakeCipher(true)).load()).toEqual(hash);
  });

  it('falls back to plain storage when encryption is unavailable', () => {
    fileTokenStore(path, fakeCipher(false)).save(hash);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ encrypted: false });
    expect(fileTokenStore(path, fakeCipher(false)).load()).toEqual(hash);
  });

  it.skipIf(process.platform === 'win32')('writes the file owner-only', () => {
    fileTokenStore(path, fakeCipher(true)).save(hash);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('deletes the file on unpair', () => {
    const store = fileTokenStore(path, fakeCipher(true));
    store.save(hash);
    store.save(null);
    expect(store.load()).toBeNull();
  });

  it('treats a missing or corrupt file as unpaired', () => {
    expect(fileTokenStore(path, fakeCipher(true)).load()).toBeNull();
    writeFileSync(path, '{not json');
    expect(fileTokenStore(path, fakeCipher(true)).load()).toBeNull();
    writeFileSync(path, JSON.stringify({ v: 2, encrypted: false, data: 'zz' }));
    expect(fileTokenStore(path, fakeCipher(true)).load()).toBeNull();
  });

  it('reads a key from before Phase 7 (a token hash) as unpaired', () => {
    writeFileSync(path, JSON.stringify({ v: 1, encrypted: false, data: hash.toString('hex') }));
    expect(fileTokenStore(path, fakeCipher(true)).load()).toBeNull();
  });
});

describe('loadServerKey', () => {
  const keyPath = () => join(dir, 'server-key.json');

  it('makes the app key once, encrypted, then reads the same one back', () => {
    const first = loadServerKey(keyPath(), fakeCipher(true));
    const raw = readFileSync(keyPath(), 'utf8');
    expect(raw).not.toContain('PRIVATE KEY');
    expect(JSON.parse(raw)).toMatchObject({ v: 2, encrypted: true });
    expect(first.publicKey).toMatch(/^B[A-P][A-Za-z0-9_-]{85}$/);
    expect(loadServerKey(keyPath(), fakeCipher(true)).publicKey).toBe(first.publicKey);
    expect(() =>
      createPrivateKey(fakeCipher(true).decryptString(Buffer.from(JSON.parse(raw).data, 'base64')))
    ).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('writes it owner-only', () => {
    loadServerKey(keyPath(), fakeCipher(false));
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
  });

  it('makes a new one if the stored one is unreadable', () => {
    const first = loadServerKey(keyPath(), fakeCipher(true));
    writeFileSync(keyPath(), '{broken');
    expect(loadServerKey(keyPath(), fakeCipher(true)).publicKey).not.toBe(first.publicKey);
  });
});
