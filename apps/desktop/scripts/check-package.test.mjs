import { describe, expect, it } from 'vitest';
import { asarOf, asarProblems, productionPackages } from './check-package.mjs';

const allowed = new Set(['fastify', '@fastify/websocket', 'ws']);
const good = [
  'package.json',
  'out',
  'out/main',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/assets/index-abc.js',
  'node_modules',
  'node_modules/@fastify',
  'node_modules/fastify/package.json',
  'node_modules/@fastify/websocket/index.js',
  'node_modules/@fastify/websocket/node_modules/ws/index.js'
];

describe('asarProblems', () => {
  it('accepts the built app and its production dependencies', () => {
    expect(asarProblems(good, allowed)).toEqual([]);
  });

  it.each([
    ['out/main/index.js.map', 'source map'],
    ['out/main/server.test.js', 'test file'],
    ['src/main/index.ts', 'not part of the built app'],
    ['out/renderer/src/App.tsx', 'TypeScript'],
    ['node_modules/fastify/types/index.d.ts', 'TypeScript'],
    ['node_modules/fastify/test/helper.js', 'tests'],
    ['e2e/chat.cjs', 'not part of the built app'],
    ['node_modules/fastify/fixtures/a.json', 'fixtures'],
    ['node_modules/vitest/index.js', "vitest isn't a production dependency"],
    ['node_modules/@bridge/shared/src/index.ts', "@bridge/shared isn't a production dependency"],
    [
      'node_modules/fastify/node_modules/electron/index.js',
      "electron isn't a production dependency"
    ],
    ['out/coverage/index.html', 'not part of the main, preload or renderer build'],
    ['node_modules/fastify/.env', 'secret-looking file']
  ])('refuses %s', (file, why) => {
    const problems = asarProblems([...good, file], allowed);
    expect(problems.some((p) => p.startsWith(`${file}:`) && p.includes(why))).toBe(true);
  });

  it('needs the entry point and package.json', () => {
    expect(asarProblems(['out/renderer/index.html'], allowed)).toEqual([
      'package.json is missing',
      'out/main/index.js is missing'
    ]);
  });
});

describe('productionPackages', () => {
  it('follows dependencies down, and never reaches dev dependencies', () => {
    const names = productionPackages();
    for (const name of ['fastify', 'zod', 'electron-updater', 'chokidar']) {
      expect(names.has(name)).toBe(true);
    }
    for (const name of ['electron', 'electron-builder', 'vite', 'react', '@bridge/shared']) {
      expect(names.has(name)).toBe(false);
    }
  });
});

describe('asarOf', () => {
  it('finds app.asar on each platform', () => {
    expect(asarOf('dist/mac-arm64/Bridge.app').replace(/\\/g, '/')).toBe(
      'dist/mac-arm64/Bridge.app/Contents/Resources/app.asar'
    );
    expect(asarOf('dist/win-unpacked/Bridge.exe').replace(/\\/g, '/')).toBe(
      'dist/win-unpacked/resources/app.asar'
    );
  });
});
