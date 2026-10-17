import { sha256Hex } from './proof';

// The pairing key (the token's SHA-256) lives in the extension's own IndexedDB, opened
// only by the service worker. Content scripts run in the page's origin, so `indexedDB`
// there is chatgpt.com's, not ours, and `chrome.storage.local` (which content scripts can
// read) no longer holds it. See PLAN.md, "Phase 5 decisions".

/** The one place the key is kept. */
export interface KeyStore {
  get(): Promise<string | null>;
  set(tokenHash: string | null): Promise<void>;
}

const DB_NAME = 'bridge-keys';
const STORE = 'keys';
const KEY = 'tokenHash';
const HASH = /^[0-9a-f]{64}$/;

function promisify(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** The service worker's IndexedDB. Pass the worker's `indexedDB`; nothing else opens it. */
export function indexedDbKeyStore(factory: IDBFactory): KeyStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        db = null;
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
    });
    return db;
  };
  const run = async (mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest) => {
    const tx = (await open()).transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    });
    const [result] = await Promise.all([promisify(fn(tx.objectStore(STORE))), done]);
    return result;
  };
  return {
    async get() {
      const value = await run('readonly', (store) => store.get(KEY));
      return typeof value === 'string' && HASH.test(value) ? value : null;
    },
    async set(tokenHash) {
      await run('readwrite', (store) =>
        tokenHash === null ? store.delete(KEY) : store.put(tokenHash, KEY)
      );
    }
  };
}

/** Where earlier versions kept the key: `chrome.storage.local`. */
export interface LegacyKeyArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
}

const LEGACY_KEYS = ['tokenHash', 'token'];

/**
 * Moves a key left in `chrome.storage.local` into `store`, then deletes it there. Phase 2
 * stored the raw token, which becomes its hash on the way. A key already in `store` wins,
 * and leftovers are deleted either way. Safe to call more than once.
 */
export async function migrateLegacyKey(store: KeyStore, legacy: LegacyKeyArea): Promise<void> {
  const { tokenHash, token } = await legacy.get(LEGACY_KEYS);
  if (tokenHash === undefined && token === undefined) return;
  if ((await store.get()) === null) {
    if (typeof tokenHash === 'string' && HASH.test(tokenHash)) await store.set(tokenHash);
    else if (typeof token === 'string' && token.length > 0) await store.set(await sha256Hex(token));
  }
  await legacy.remove(LEGACY_KEYS);
}

/** `store`, migrating from `legacy` once before the first read or write. */
export function migratingKeyStore(store: KeyStore, legacy: LegacyKeyArea): KeyStore {
  let migrated: Promise<void> | null = null;
  const ready = () => {
    migrated ??= migrateLegacyKey(store, legacy).catch(() => {
      migrated = null;
    });
    return migrated;
  };
  return {
    async get() {
      await ready();
      return store.get();
    },
    async set(tokenHash) {
      await ready();
      await store.set(tokenHash);
    }
  };
}
