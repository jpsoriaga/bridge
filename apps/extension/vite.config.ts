import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';
import { CARD_FONTS } from './src/fonts';

const require = createRequire(import.meta.url);

/**
 * Emits the card fonts at fixed paths. The content script doesn't import them, so CRXJS
 * doesn't add them to its own `web_accessible_resources` entry (which has to stay static
 * for its script chunks); the manifest lists them separately with `use_dynamic_url`.
 */
function cardFonts(): Plugin {
  return {
    name: 'bridge-card-fonts',
    apply: 'build',
    generateBundle() {
      for (const { path, source } of Object.values(CARD_FONTS)) {
        this.emitFile({
          type: 'asset',
          fileName: path,
          source: readFileSync(require.resolve(source))
        });
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  // `pnpm dev` is `vite build --watch --mode development`, and a build leaves DEV false
  // even in development mode. Dev-only UI (the side panel's file tester) keys off DEV.
  define: mode === 'development' ? { 'import.meta.env.DEV': 'true' } : {},
  plugins: [react(), crx({ manifest }), cardFonts()]
}));
