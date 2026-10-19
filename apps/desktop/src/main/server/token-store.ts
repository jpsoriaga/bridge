import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateServerKey, rawPublicKey, type ServerKey, type TokenHashStore } from './pairing';

/** Electron's `safeStorage`, narrowed to what the store needs. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredFile {
  /** 2 since Phase 7: an ECDH-derived key. Version 1 (a token hash) reads as unpaired. */
  v: 2;
  encrypted: boolean;
  data: string;
}

/** Writes a small private file: 0600 in a 0700 folder, replaced in one rename. */
function writePrivate(path: string, file: StoredFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A stored secret, decrypted. Null if missing, of another version, or unreadable. */
function readPrivate(path: string, cipher: Cipher): string | null {
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as StoredFile;
    if (file.v !== 2 || typeof file.data !== 'string') return null;
    return file.encrypted ? cipher.decryptString(Buffer.from(file.data, 'base64')) : file.data;
  } catch {
    // Missing, corrupt, or the keychain entry is gone.
    return null;
  }
}

function sealed(plain: string, cipher: Cipher): StoredFile {
  const encrypted = cipher.isEncryptionAvailable();
  return {
    v: 2,
    encrypted,
    data: encrypted ? cipher.encryptString(plain).toString('base64') : plain
  };
}

/**
 * The app's ECDH key pair for pairing, generated on first use and kept in one file under
 * userData, encrypted with the OS keychain when available (plain in a 0600 file otherwise,
 * like the pairing key). A new key changes every future fingerprint, nothing else.
 */
export function loadServerKey(path: string, cipher: Cipher): ServerKey {
  const pem = readPrivate(path, cipher);
  if (pem) {
    try {
      const privateKey = createPrivateKey(pem);
      return { privateKey, publicKey: rawPublicKey(createPublicKey(privateKey)) };
    } catch {
      // Unreadable: make a new one below.
    }
  }
  const key = generateServerKey();
  const exported = key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  writePrivate(path, sealed(exported, cipher));
  return key;
}

/**
 * Keeps the pairing key in one file under userData, encrypted with the OS keychain when
 * available. Without a keyring (some Linux setups) it falls back to plain hex in a 0600
 * file, readable only by the user, like the extension's copy.
 */
export function fileTokenStore(path: string, cipher: Cipher): TokenHashStore {
  return {
    load() {
      const hex = readPrivate(path, cipher);
      return hex !== null && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
    },

    save(hash) {
      if (hash === null) {
        rmSync(path, { force: true });
        return;
      }
      writePrivate(path, sealed(hash.toString('hex'), cipher));
    }
  };
}
