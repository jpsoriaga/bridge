import { describe, expect, it } from 'vitest';
import { BRIDGE_EXTENSION_ID, STORE_EXTENSION_ID } from '@bridge/shared';
import {
  ALLOWED_EXTENSION_IDS,
  ALLOWED_ORIGINS,
  allowedExtensionIds,
  EXTENSION_ID
} from './config';

const STORE = 'abcdefghijklmnopabcdefghijklmnop';

describe('allowed extension IDs', () => {
  it('is the dev ID, plus the store ID once it is set', () => {
    expect(EXTENSION_ID.test(BRIDGE_EXTENSION_ID)).toBe(true);
    // Empty until the first store upload (RELEASE.md); a real ID once set.
    expect(STORE_EXTENSION_ID === '' || EXTENSION_ID.test(STORE_EXTENSION_ID)).toBe(true);
    expect(ALLOWED_EXTENSION_IDS).toEqual(
      STORE_EXTENSION_ID === '' ? [BRIDGE_EXTENSION_ID] : allowedExtensionIds()
    );
    expect(allowedExtensionIds(BRIDGE_EXTENSION_ID, '')).toEqual([BRIDGE_EXTENSION_ID]);
    expect(allowedExtensionIds(BRIDGE_EXTENSION_ID, STORE)).toEqual([BRIDGE_EXTENSION_ID, STORE]);
    // Both builds sharing one ID (the store's key copied into the dev manifest).
    expect(allowedExtensionIds(STORE, STORE)).toEqual([STORE]);
  });

  it('refuses anything that is not an extension ID', () => {
    for (const bad of [
      '*',
      'chrome-extension://x',
      STORE.toUpperCase(),
      `${STORE}q`,
      'z'.repeat(32)
    ]) {
      expect(() => allowedExtensionIds(BRIDGE_EXTENSION_ID, bad)).toThrow(/Not an extension ID/);
    }
  });

  it('allows exactly those origins', () => {
    expect([...ALLOWED_ORIGINS]).toEqual(
      ALLOWED_EXTENSION_IDS.map((id) => `chrome-extension://${id}`)
    );
  });
});
