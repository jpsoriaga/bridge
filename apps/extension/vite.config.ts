import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig(({ mode }) => ({
  // `pnpm dev` is `vite build --watch --mode development`, and a build leaves DEV false
  // even in development mode. Dev-only UI (the side panel's file tester) keys off DEV.
  define: mode === 'development' ? { 'import.meta.env.DEV': 'true' } : {},
  plugins: [react(), crx({ manifest })]
}));
