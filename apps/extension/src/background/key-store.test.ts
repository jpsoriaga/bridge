import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  migrateLegacyKey,
  migratingKeyStore,
  type KeyStore,
  type LegacyKeyArea
} from './key-store';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

function memoryKeys(initial: string | null = null): KeyStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => Promise.resolve(store.value),
    set: (value: string | null) => {
      store.value = value;
      return Promise.resolve();
    }
  };
  return store;
}

function legacyArea(initial: Record<string, unknown>): LegacyKeyArea & {
  data: Record<string, unknown>;
  reads: number;
} {
  const area = {
    data: { ...initial },
    reads: 0,
    get: (keys: string[]) => {
      area.reads += 1;
      return Promise.resolve(
        Object.fromEntries(keys.filter((k) => k in area.data).map((k) => [k, area.data[k]]))
      );
    },
    remove: (keys: string[]) => {
      for (const key of keys) delete area.data[key];
      return Promise.resolve();
    }
  };
  return area;
}

describe('migrateLegacyKey', () => {
  it('moves tokenHash out of chrome.storage.local and deletes it there', async () => {
    const keys = memoryKeys();
    const legacy = legacyArea({ tokenHash: KEY, port: 47821, cards: {} });
    await migrateLegacyKey(keys, legacy);
    expect(keys.value).toBe(KEY);
    expect(legacy.data).toEqual({ port: 47821, cards: {} });
  });

  it('hashes a Phase 2 raw token on the way', async () => {
    const keys = memoryKeys();
    const legacy = legacyArea({ token: 'f'.repeat(64) });
    await migrateLegacyKey(keys, legacy);
    expect(keys.value).toBe(createHash('sha256').update('f'.repeat(64)).digest('hex'));
    expect(legacy.data).toEqual({});
  });

  it('keeps a key already in IndexedDB and still deletes the leftover', async () => {
    const keys = memoryKeys(OTHER);
    const legacy = legacyArea({ tokenHash: KEY });
    await migrateLegacyKey(keys, legacy);
    expect(keys.value).toBe(OTHER);
    expect(legacy.data).toEqual({});
  });

  it('drops a malformed legacy value instead of moving it', async () => {
    const keys = memoryKeys();
    const legacy = legacyArea({ tokenHash: 'not-a-hash' });
    await migrateLegacyKey(keys, legacy);
    expect(keys.value).toBeNull();
    expect(legacy.data).toEqual({});
  });

  it('does nothing when storage has no key', async () => {
    const keys = memoryKeys(KEY);
    await migrateLegacyKey(keys, legacyArea({}));
    expect(keys.value).toBe(KEY);
  });
});

describe('migratingKeyStore', () => {
  it('migrates once, before the first read', async () => {
    const keys = memoryKeys();
    const legacy = legacyArea({ tokenHash: KEY });
    const store = migratingKeyStore(keys, legacy);
    expect(await store.get()).toBe(KEY);
    expect(await store.get()).toBe(KEY);
    expect(legacy.reads).toBe(1);
    await store.set(null);
    expect(keys.value).toBeNull();
    expect(legacy.data).toEqual({});
  });

  it('a write before any read still clears the legacy copy first', async () => {
    const keys = memoryKeys();
    const legacy = legacyArea({ tokenHash: KEY });
    await migratingKeyStore(keys, legacy).set(OTHER);
    expect(keys.value).toBe(OTHER);
    expect(legacy.data).toEqual({});
  });
});
