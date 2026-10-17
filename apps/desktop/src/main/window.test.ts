import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWindowOptions } from './window';

describe('createWindowOptions', () => {
  it('locks down the renderer', () => {
    const { webPreferences } = createWindowOptions('/preload.js');
    expect(webPreferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    });
  });

  it('uses the given preload script', () => {
    expect(createWindowOptions('/preload.js').webPreferences?.preload).toBe('/preload.js');
  });
});

describe('production CSP', () => {
  // The dev server relaxes style-src through a plugin; the HTML on disk is what ships.
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];

  it('is present', () => {
    expect(csp).toBeDefined();
  });

  it('defaults to none', () => {
    expect(csp).toContain("default-src 'none'");
  });

  it('allows no inline or eval', () => {
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});
