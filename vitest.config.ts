import { defineConfig } from 'vitest/config';

// One run covers every package. E2E (Electron/Playwright) tests are out of scope here.
export default defineConfig({
  test: {
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
