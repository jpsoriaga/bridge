import { describe, expect, it } from 'vitest';
import {
  errorLines,
  formatUptime,
  isBackgroundScript,
  isLocalUrl,
  looksLikeBackground,
  readyUrl
} from './background';

describe('looksLikeBackground', () => {
  it('suggests dev, start, serve, preview and watch scripts as background', () => {
    for (const entry of [
      'npm run dev',
      'npm start',
      'pnpm dev',
      'yarn serve',
      'bun run preview',
      'pnpm watch',
      'npm run dev:web',
      'pnpm run start *'
    ]) {
      expect(looksLikeBackground(entry), entry).toBe(true);
    }
    for (const entry of [
      'npm test',
      'pnpm build',
      'git status',
      'node server.js',
      'npm run devtools',
      'cargo run'
    ]) {
      expect(looksLikeBackground(entry), entry).toBe(false);
    }
    expect(isBackgroundScript('watch-css')).toBe(true);
  });
});

describe('readyUrl', () => {
  it('finds the local URL a dev server prints', () => {
    expect(readyUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(readyUrl('ready - started server on 0.0.0.0:3000, url: http://localhost:3000')).toBe(
      'http://localhost:3000'
    );
    expect(readyUrl('Listening on http://0.0.0.0:8080.')).toBe('http://localhost:8080');
    expect(readyUrl('Serving HTTP on http://[::]:8000/ ...')).toBe('http://localhost:8000/');
    expect(readyUrl('http://127.0.0.1:4321/docs')).toBe('http://127.0.0.1:4321/docs');
    expect(readyUrl('https://localhost:8443')).toBe('https://localhost:8443');
  });

  it('ignores remote URLs and lines without one', () => {
    expect(readyUrl('Docs: https://vitejs.dev/guide')).toBeNull();
    expect(readyUrl('compiled in 312ms')).toBeNull();
  });
});

describe('isLocalUrl', () => {
  it('opens only http(s) on this computer', () => {
    expect(isLocalUrl('http://localhost:5173/')).toBe(true);
    expect(isLocalUrl('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalUrl('https://example.com')).toBe(false);
    expect(isLocalUrl('file:///etc/passwd')).toBe(false);
    expect(isLocalUrl('javascript:alert(1)')).toBe(false);
    expect(isLocalUrl('http://user:pw@localhost/')).toBe(false);
  });
});

describe('errorLines', () => {
  it('keeps error lines with the two after each, in order', () => {
    const lines = [
      'VITE v5 ready',
      '[vite] hmr update /src/App.tsx',
      '[vite] Internal server error: Transform failed with 1 error:',
      '/src/App.tsx:3:7: ERROR: Unexpected "}"',
      '  1 | export default function App() {',
      '  2 |   return <div>',
      'page reload src/main.tsx'
    ];
    expect(errorLines(lines)).toEqual(lines.slice(2, 6));
  });

  it('skips good news that mentions errors', () => {
    expect(
      errorLines(['Found 0 errors. Watching for file changes.', 'compiled with no errors'])
    ).toEqual([]);
    expect(errorLines(['src/a.ts(3,1): error TS1005: ";" expected.'])).toEqual([
      'src/a.ts(3,1): error TS1005: ";" expected.'
    ]);
  });

  it('keeps the newest ones when there are many', () => {
    const many = Array.from({ length: 100 }, (_, i) => `Error ${i}`);
    expect(errorLines(many, 5)).toEqual([
      'Error 95',
      'Error 96',
      'Error 97',
      'Error 98',
      'Error 99'
    ]);
  });
});

describe('formatUptime', () => {
  it('reads like a clock', () => {
    expect(formatUptime(45_000)).toBe('45s');
    expect(formatUptime(12 * 60_000 + 3_000)).toBe('12m 3s');
    expect(formatUptime(2 * 3_600_000 + 5 * 60_000)).toBe('2h 5m');
    expect(formatUptime(-5)).toBe('0s');
  });
});
