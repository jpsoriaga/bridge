import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenHashStore } from './pairing';

/** Electron's `safeStorage`, narrowed to what the store needs. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredFile {
  v: 1;
  encrypted: boolean;
  data: string;
}

/**
 * Keeps the token hash in one file under userData, encrypted with the OS keychain when
 * available. It is already a hash, so the plain fallback (e.g. Linux without a keyring)
 * exposes nothing that could be replayed.
 */
export function fileTokenStore(path: string, cipher: Cipher): TokenHashStore {
  return {
    load() {
      let file: StoredFile;
      try {
        file = JSON.parse(readFileSync(path, 'utf8')) as StoredFile;
      } catch {
        return null;
      }
      try {
        const hex = file.encrypted
          ? cipher.decryptString(Buffer.from(file.data, 'base64'))
          : file.data;
        return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
      } catch {
        // Keychain entry gone or file corrupt: treat as unpaired.
        return null;
      }
    },

    save(hash) {
      if (hash === null) {
        rmSync(path, { force: true });
        return;
      }
      const hex = hash.toString('hex');
      const encrypted = cipher.isEncryptionAvailable();
      const file: StoredFile = {
        v: 1,
        encrypted,
        data: encrypted ? cipher.encryptString(hex).toString('base64') : hex
      };
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      renameSync(tmp, path);
    }
  };
}
