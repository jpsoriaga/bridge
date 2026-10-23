import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pairing key lives in the service worker's IndexedDB (background/key-store.ts). This
// proves the content script can't get at it: nothing it bundles imports the key store or
// any worker module, nothing it bundles touches `indexedDB` or `chrome.storage` (and its
// `indexedDB` would be chatgpt.com's anyway), and the messages it may send carry no key.

const EXTENSION = resolve(__dirname, '../..');
const SHARED = resolve(EXTENSION, '../../packages/shared/src');
const ENTRY = join(EXTENSION, 'src/content/index.ts');

const SPECIFIERS =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;

function resolveImport(from: string, specifier: string): string | null {
  const bare = specifier.replace(/\?.*$/, '');
  let base: string;
  if (bare === '@bridge/shared') base = join(SHARED, 'index');
  else if (bare.startsWith('@bridge/shared/'))
    return null; // CSS and SVG assets
  else if (bare.startsWith('.')) base = resolve(dirname(from), bare);
  else return null; // a package from node_modules
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every first-party TS module the content script bundles, starting from its entry. */
function contentScriptModules(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const source = readFileSync(file, 'utf8');
    seen.set(file, source);
    for (const match of source.matchAll(SPECIFIERS)) {
      const target = resolveImport(file, match[1] ?? match[2] ?? '');
      if (target) queue.push(target);
    }
  }
  return seen;
}

const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('content script isolation', () => {
  const modules = contentScriptModules();
  // Forward slashes on every OS, so the names below read the same on Windows.
  const names = [...modules.keys()].map((file) => relative(EXTENSION, file).replace(/\\/g, '/'));

  it('walks the real import graph', () => {
    expect(names).toContain('src/content/chat/controller.ts');
    expect(names).toContain('src/messages.ts');
    expect(names.some((name) => name.endsWith('shared/src/parser.ts'))).toBe(true);
  });

  it('bundles no service worker module, so not the key store', () => {
    expect(names.filter((name) => name.startsWith('src/background/'))).toEqual([]);
    expect(names.some((name) => name.includes('key-store'))).toBe(false);
  });

  it('never touches indexedDB or chrome.storage', () => {
    for (const [file, source] of modules) {
      expect(code(source), relative(EXTENSION, file)).not.toMatch(/indexedDB|chrome\.storage/);
    }
  });

  it('can ask the worker for nothing that carries the key', () => {
    const messages = code(modules.get(join(EXTENSION, 'src/messages.ts')) ?? '');
    expect(messages).not.toMatch(/token/i);
  });
});
