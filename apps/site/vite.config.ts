import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { SITE_URL } from './src/config/site';

const shared = (path: string): string =>
  fileURLToPath(new URL(`../../packages/shared/${path}`, import.meta.url));

// Puts SITE_URL into index.html and writes robots.txt and sitemap.xml from it, so a new
// domain is a one-line change in src/config/site.ts.
function siteUrl(): Plugin {
  return {
    name: 'bridge-site-url',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', SITE_URL),
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source:
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `  <url><loc>${SITE_URL}/</loc></url>\n` +
          '</urlset>\n'
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), siteUrl()],
  resolve: {
    alias: {
      // Only the logo geometry: the package's index also pulls in zod and the parser.
      '@bridge/shared/brand': shared('src/brand.ts')
    }
  },
  build: { target: 'es2022', sourcemap: false }
});
