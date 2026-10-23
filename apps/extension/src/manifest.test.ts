import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_EXTENSION_ID } from '@bridge/shared';
import manifestExport, { EXTENSION_PUBLIC_KEY } from '../manifest.config';
import pkg from '../package.json';

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
  it('carries the package version, numbers only, with a beta in version_name', async () => {
    const manifest = await loadManifest();
    const [release, beta] = pkg.version.split('-');
    expect(manifest.version).toBe(release);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version_name).toBe(beta ? pkg.version : undefined);
  });

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

  it('has no key in the store build (the store assigns the ID)', async () => {
    vi.stubEnv('BRIDGE_RELEASE', '1');
    vi.resetModules();
    try {
      const release = (await import('../manifest.config')).default;
      const manifest = await (typeof release === 'function'
        ? release({ command: 'build', mode: 'production' })
        : release);
      expect('key' in manifest).toBe(false);
      expect(manifest.permissions).toEqual(['storage', 'sidePanel', 'alarms']);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('runs extension pages under a strict CSP', async () => {
    const manifest = await loadManifest();
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    const directives = new Map(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .filter((parts) => parts[0])
        .map(([name, ...values]) => [name!, values])
    );
    expect(directives.get('script-src')).toEqual(["'self'"]);
    expect(directives.get('object-src')).toEqual(["'none'"]);
    expect(csp).not.toMatch(/unsafe-|https?:|\*/);
  });

  it('lets no web page or other extension connect', async () => {
    const manifest = await loadManifest();
    expect(manifest.externally_connectable).toEqual({ ids: [] });
  });

  it('declares nothing it doesn’t use: no other keys that widen access', async () => {
    const manifest = (await loadManifest()) as unknown as Record<string, unknown>;
    for (const key of [
      'optional_permissions',
      'optional_host_permissions',
      'sandbox',
      'chrome_url_overrides',
      'devtools_page',
      'oauth2',
      'declarative_net_request',
      'commands'
    ]) {
      expect(manifest[key], key).toBeUndefined();
    }
    const resources = (manifest.web_accessible_resources ?? []) as { matches: string[] }[];
    for (const entry of resources) expect(entry.matches).toEqual(['https://chatgpt.com/*']);
  });
});
