import { existsSync, readFileSync } from 'node:fs';
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

/** The CSP meta tag in an HTML file, as its directives. */
function cspOf(html: string): Map<string, string[]> {
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  return new Map(
    content
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((parts) => parts[0])
      .map(([name, ...values]) => [name!, values])
  );
}

// What actually ships: electron-vite's output. CI builds before it tests, so this runs
// there; locally it runs after `pnpm build`.
const built = new URL('../../out/renderer/index.html', import.meta.url);
describe.runIf(existsSync(built))('production CSP in the built app', () => {
  const csp = cspOf(readFileSync(built, 'utf8'));

  it('defaults to nothing: stricter than self', () => {
    expect(csp.get('default-src')).toEqual(["'none'"]);
  });

  it('loads scripts and styles from the app only, with no unsafe-* anywhere', () => {
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(csp.get('style-src')).toEqual(["'self'"]);
    for (const [name, values] of csp) {
      expect(
        values.filter((v) => v.startsWith("'unsafe-")),
        name
      ).toEqual([]);
    }
  });

  it('allows no plugins, base changes or form posts, and no remote origins', () => {
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('form-action')).toEqual(["'none'"]);
    for (const values of csp.values()) {
      expect(values.filter((v) => /^https?:|^\*$/.test(v))).toEqual([]);
    }
  });

  it('has no inline script in the page', () => {
    const html = readFileSync(built, 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });
});

describe('main process hardening', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('sandboxes every renderer before the app is ready', () => {
    expect(source.indexOf('app.enableSandbox()')).toBeGreaterThan(-1);
    expect(source.indexOf('app.enableSandbox()')).toBeLessThan(source.indexOf('app.whenReady()'));
  });

  it('locks down every web contents and the session', () => {
    expect(source).toMatch(/app\.on\('web-contents-created',[\s\S]{0,80}lockDownContents\(/);
    expect(source).toContain('lockDownSession(session.defaultSession)');
  });
});
