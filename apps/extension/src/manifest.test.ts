import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BRIDGE_EXTENSION_ID } from '@bridge/shared';
import manifestExport, { EXTENSION_PUBLIC_KEY } from '../manifest.config';

async function loadManifest() {
  return typeof manifestExport === 'function'
    ? manifestExport({ command: 'build', mode: 'production' })
    : manifestExport;
}

/** Chrome's ID derivation: SHA-256 of the DER key, first 16 bytes, hex mapped to a–p. */
function extensionIdFromKey(key: string): string {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}

describe('manifest', () => {
  it('requests exactly storage, sidePanel and alarms', async () => {
    const manifest = await loadManifest();
    expect(manifest.permissions).toEqual(['storage', 'sidePanel', 'alarms']);
  });

  it('runs content scripts on chatgpt.com only', async () => {
    const manifest = await loadManifest();
    const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
    expect(matches).toEqual(['https://chatgpt.com/*']);
  });

  it('has loopback as its only host permission, and no <all_urls>', async () => {
    const manifest = await loadManifest();
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
    expect(JSON.stringify(manifest)).not.toContain('localhost');
  });

  it('pins the extension ID the desktop allowlists', async () => {
    const manifest = await loadManifest();
    expect(manifest.key).toBe(EXTENSION_PUBLIC_KEY);
    expect(extensionIdFromKey(EXTENSION_PUBLIC_KEY)).toBe(BRIDGE_EXTENSION_ID);
  });
});
