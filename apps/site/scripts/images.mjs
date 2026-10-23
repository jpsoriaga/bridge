// Renders the site's icons and its Open Graph image (1200×630) into public/, with the
// Chromium the e2e scripts use. Run after changing the logo or the share card:
//   npm ci --prefix e2e && npx --prefix e2e playwright-core install chromium
//   node apps/site/scripts/images.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const root = join(site, '../..');
const { chromium } = createRequire(join(root, 'e2e/package.json'))('playwright-core');
const require = createRequire(join(site, 'package.json'));

const font = (pkg, file) =>
  pathToFileURL(join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file)).href;
const GEIST = font('@fontsource-variable/geist', 'geist-latin-wght-normal.woff2');
const GEIST_MONO = font('@fontsource-variable/geist-mono', 'geist-mono-latin-wght-normal.woff2');

// The light theme's tokens (packages/shared/src/tokens.css); a share image has one look.
const TOKENS = readFileSync(join(root, 'packages/shared/src/tokens.css'), 'utf8');

const logo = readFileSync(join(root, 'packages/shared/assets/logo.svg'), 'utf8');
// The tile without its rounded corners, for icons the system rounds itself.
const squareLogo = logo.replace(' rx="7.5"', '');

const page = (body, css = '') => `<!doctype html><html data-theme="light"><head><style>
@font-face { font-family: 'Geist Variable'; src: url(${GEIST}) format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Geist Mono Variable'; src: url(${GEIST_MONO}) format('woff2'); font-weight: 100 900; }
${TOKENS}
html, body { margin: 0; background: transparent; }
svg { display: block; width: 100%; height: 100%; }
${css}
</style></head><body>${body}</body></html>`;

const ICONS = [
  { file: 'favicon-32.png', size: 32, svg: logo, pad: 0 },
  { file: 'apple-touch-icon.png', size: 180, svg: squareLogo, pad: 0 },
  { file: 'icon-192.png', size: 192, svg: logo, pad: 12 },
  { file: 'icon-512.png', size: 512, svg: logo, pad: 32 }
];

const OG = `
<div class="og">
  <div class="left">
    <div class="brand"><div class="mark">${logo}</div>Bridge</div>
    <h1>Let the ChatGPT web chat edit your local project.</h1>
    <p>Every change shows as a diff you review. Apply it with one click, undo any time. Free, open source, works on the Free plan.</p>
  </div>
  <div class="card">
    <div class="head"><span class="path">src/components/Header.tsx</span><span class="badge">modified</span><span class="meta">Modified · <b class="add">+4</b> <b class="del">−1</b></span></div>
    <div class="body">
      <div class="row hunk">@@ -1,8 +1,12 @@</div>
      <div class="row">  import { Logo } from './Logo';</div>
      <div class="row a">+ import { useTheme } from '../hooks/useTheme';</div>
      <div class="row">  export function Header() {</div>
      <div class="row a">+   const { theme, toggle } = useTheme();</div>
      <div class="row d">-     &lt;header className="bar"&gt;</div>
      <div class="row a">+     &lt;header data-theme={theme}&gt;</div>
    </div>
    <div class="foot"><span class="hint"><b>Manual</b> Review before applying.</span><span class="btn">Reject</span><span class="btn primary">Apply</span></div>
  </div>
  <div class="wordmark">Bridge</div>
</div>`;

const OG_CSS = `
.og { position: relative; width: 1200px; height: 630px; overflow: hidden; background: var(--bg); color: var(--fg);
  font-family: var(--font-sans); display: grid; grid-template-columns: 1fr 520px; gap: 56px; padding: 72px 72px 0; box-sizing: border-box; }
.left { position: relative; z-index: 1; }
.brand { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.01em; }
.mark { width: 44px; height: 44px; }
h1 { margin: 44px 0 0; font-size: 54px; line-height: 1.05; letter-spacing: -0.035em; font-weight: 600; }
p { margin: 24px 0 0; font-size: 22px; line-height: 1.5; color: var(--fg-muted); }
.card { position: relative; z-index: 1; align-self: start; margin-top: 8px; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg); overflow: hidden; }
.head { display: flex; align-items: center; gap: 10px; padding: 14px 18px; font-size: 15px; }
.path { font-family: var(--font-mono); }
.badge { font-family: var(--font-mono); font-size: 13px; padding: 1px 6px; border: 1px solid var(--border-strong); border-radius: 6px; color: var(--fg-muted); }
.meta { color: var(--fg-muted); font-size: 14px; } .add { color: var(--success); font-weight: 400; } .del { color: var(--danger); font-weight: 400; }
.body { border-top: 1px solid var(--border); padding: 6px 0; }
.row { font-family: var(--font-mono); font-size: 15px; line-height: 26px; padding: 0 18px; white-space: pre; }
.row.a { background: var(--success-bg); } .row.d { background: var(--danger-bg); } .row.hunk { color: var(--fg-subtle); }
.foot { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--border); background: var(--bg-hover); }
.hint { flex: 1; font-size: 14px; color: var(--fg-muted); } .hint b { color: var(--fg); font-weight: 500; margin-right: 6px; }
.btn { height: 36px; padding: 0 14px; display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 8px; font-size: 15px; font-weight: 500; background: var(--bg); }
.btn.primary { background: var(--inverse-bg); border-color: var(--inverse-bg); color: var(--inverse-fg); font-weight: 600; height: 42px; padding: 0 18px; }
.wordmark { position: absolute; left: 0; right: 0; bottom: -120px; text-align: center; font-size: 330px; font-weight: 900; line-height: 1; letter-spacing: -0.05em;
  background: linear-gradient(to bottom, var(--border) 20%, var(--bg) 85%); -webkit-background-clip: text; background-clip: text; color: transparent; }
`;

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const p = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const inner = icon.size - icon.pad * 2;
    await p.setContent(
      page(`<div style="width:${inner}px;height:${inner}px;margin:${icon.pad}px">${icon.svg}</div>`)
    );
    await p.screenshot({ path: join(site, 'public', icon.file), omitBackground: true });
    await p.close();
  }
  const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await p.setContent(page(OG, OG_CSS));
  await p.evaluate('document.fonts.ready');
  await p.screenshot({ path: join(site, 'public/og.png') });
  await p.close();
} finally {
  await browser.close();
}
console.log('Wrote the icons and og.png to apps/site/public/.');
