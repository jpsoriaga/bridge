import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG AA contrast for text in both themes, read from tokens.css. Every colour token is
// light-dark(light, dark), so each theme is one side of it.

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

function tokens(theme: 'light' | 'dark'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, light, dark] of css.matchAll(
    /(--[\w-]+):\s*light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi
  )) {
    out[name!] = theme === 'light' ? light! : dark!;
  }
  return out;
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Text tokens, and the surfaces they're used on. */
const TEXT = ['--fg', '--fg-muted', '--fg-subtle', '--success', '--danger', '--warning'];
const SURFACES = ['--bg', '--bg-muted', '--bg-hover'];

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  const t = tokens(theme);

  it('has every token as a light-dark() pair', () => {
    for (const name of [...TEXT, ...SURFACES, '--inverse-fg', '--inverse-bg']) {
      expect(t[name], name).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(TEXT)('%s meets WCAG AA (4.5:1) on every surface', (text) => {
    for (const surface of SURFACES) {
      expect(contrast(t[text]!, t[surface]!), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('primary buttons and the active segment read clearly', () => {
    expect(contrast(t['--inverse-fg']!, t['--inverse-bg']!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--fg']!, t['--bg-raised']!)).toBeGreaterThanOrEqual(4.5);
  });

  it('borders and dots stand out from the page enough to see (3:1 for state dots)', () => {
    for (const dot of ['--success', '--danger', '--warning']) {
      expect(contrast(t[dot]!, t['--bg']!), dot).toBeGreaterThanOrEqual(3);
    }
  });
});
