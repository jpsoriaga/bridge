import { defineConfig } from 'vitest/config';

// One run covers every package. E2E (Electron/Playwright) tests are out of scope here.
export default defineConfig({
  test: {
    // `pnpm test:coverage` (CI) fails below these. The security-critical modules carry a
    // higher bar than the rest.
    coverage: {
      provider: 'v8',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/shared/src/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/test-utils.{ts,tsx}',
        '**/test-pairing.ts',
        '**/*.d.ts',
        // Entry points that only wire modules to Electron and Chrome; the e2e scripts run
        // them (e2e/README.md).
        'apps/desktop/src/main/index.ts',
        'apps/desktop/src/preload/**',
        'apps/desktop/src/renderer/src/main.tsx',
        'apps/extension/src/background/index.ts',
        'apps/extension/src/content/index.ts',
        'apps/extension/src/sidepanel/main.tsx'
      ],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        lines: 70,
        'apps/desktop/src/main/project/sandbox.ts': { lines: 90 },
        'apps/desktop/src/main/commands/runner.ts': { lines: 90 },
        'apps/desktop/src/main/server/server.ts': { lines: 90 },
        'apps/desktop/src/main/server/nonces.ts': { lines: 90 },
        'apps/desktop/src/main/server/pairing.ts': { lines: 90 },
        'apps/extension/src/background/proof.ts': { lines: 90 },
        'packages/shared/src/parser.ts': { lines: 90 }
      }
    },
    projects: [
      {
        test: { name: 'shared', root: 'packages/shared', include: ['src/**/*.test.ts'] }
      },
      {
        test: {
          name: 'desktop',
          root: 'apps/desktop',
          include: ['src/main/**/*.test.ts'],
          environment: 'node'
        }
      },
      {
        // The desktop renderer's React pages, with Testing Library and axe in jsdom.
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'renderer',
          root: 'apps/desktop',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom'
        }
      },
      {
        // Release tooling (one version everywhere).
        test: { name: 'scripts', root: 'scripts', include: ['**/*.test.mjs'], environment: 'node' }
      },
      {
        test: {
          name: 'extension',
          root: 'apps/extension',
          include: ['src/**/*.test.ts'],
          environment: 'node'
        }
      }
    ]
  }
});
