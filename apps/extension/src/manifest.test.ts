import { describe, expect, it } from 'vitest';
import manifestExport from '../manifest.config';

async function loadManifest() {
  return typeof manifestExport === 'function'
    ? manifestExport({ command: 'build', mode: 'production' })
    : manifestExport;
}

describe('manifest', () => {
  it('requests exactly storage and sidePanel', async () => {
    const manifest = await loadManifest();
    expect(manifest.permissions).toEqual(['storage', 'sidePanel']);
  });

  it('runs content scripts on chatgpt.com only', async () => {
    const manifest = await loadManifest();
    const matches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
    expect(matches).toEqual(['https://chatgpt.com/*']);
  });

  it('has no host permissions and no <all_urls>', async () => {
    const manifest = await loadManifest();
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.optional_permissions).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('<all_urls>');
  });
});
