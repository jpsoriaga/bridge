// Runs after `vite build` and `vite build --ssr src/prerender.tsx`: renders the page and puts
// it inside <div id="root"> in dist/index.html, then removes the server build.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(site, 'dist-ssr');
const { render } = await import(pathToFileURL(join(server, 'prerender.js')).href);

const file = join(site, 'dist/index.html');
const html = readFileSync(file, 'utf8');
const marker = '<div id="root"></div>';
if (!html.includes(marker)) throw new Error(`${marker} not found in dist/index.html`);
writeFileSync(file, html.replace(marker, `<div id="root">${render()}</div>`));
rmSync(server, { recursive: true, force: true });
console.log('Prerendered dist/index.html.');
