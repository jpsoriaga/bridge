import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// @bridge/shared ships TypeScript source, so it must be bundled rather than
// externalized (Electron cannot require .ts at runtime).
const build = { externalizeDeps: { exclude: ['@bridge/shared'] } };

// Vite injects CSS through <style> tags during dev, which the production CSP
// blocks. Relax style-src for the dev server only; builds keep the strict policy.
function devStyleCsp(): Plugin {
  return {
    name: 'bridge:dev-style-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
  };
}

export default defineConfig({
  main: {
    build,
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    build,
    define: {
      __BRIDGE_VERSION__: JSON.stringify(pkg.version)
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), devStyleCsp()]
  }
});
