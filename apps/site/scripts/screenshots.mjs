// Screenshots of the built page for docs/screenshots/site/, plus the checks they stand for:
// no horizontal scroll at any width, the footer wordmark spanning the footer. Also records
// the hero demo. Uses the Chromium the e2e scripts use:
//   npm ci --prefix e2e && npx --prefix e2e playwright-core install chromium
//   pnpm --filter site build && pnpm --filter site preview   (in another terminal)
//   node apps/site/scripts/screenshots.mjs [http://localhost:4173]
/* global document, innerHeight, innerWidth, scrollTo -- inside page.evaluate(), in the browser */
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const { chromium } = createRequire(join(root, 'e2e/package.json'))('playwright-core');
const url = process.argv[2] ?? 'http://localhost:4173';
const out = join(root, 'docs/screenshots/site');
mkdirSync(out, { recursive: true });

const SIZES = [
  { name: 'phone-small', width: 320, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'wide', width: 2560, height: 1440 }
];
// The committed screenshots; the other sizes are only checked.
const SAVED = new Set(['phone', 'tablet', 'desktop']);

const browser = await chromium.launch();
let failed = false;

for (const size of SIZES) {
  for (const theme of ['light', 'dark']) {
    for (const motion of ['no-preference', 'reduce']) {
      const page = await browser.newPage({
        viewport: { width: size.width, height: size.height },
        colorScheme: theme,
        reducedMotion: motion
      });
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      // Scroll through so every reveal runs, then back to the top.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) {
          scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
        scrollTo(0, document.body.scrollHeight);
        await new Promise((r) => setTimeout(r, 1800));
        scrollTo(0, 0);
      });
      const check = await page.evaluate(() => {
        const svg = document.querySelector('footer svg.wordmark').getBoundingClientRect();
        const footer = document.querySelector('footer').getBoundingClientRect();
        const hidden = [...document.querySelectorAll('[data-reveal]:not([data-shown])')].length;
        return {
          overflow: document.documentElement.scrollWidth - innerWidth,
          wordmark: Math.round(svg.width),
          footer: Math.round(footer.width),
          motion: document.documentElement.hasAttribute('data-motion'),
          hidden
        };
      });
      const label = `${size.name} ${theme} ${motion}`;
      const problems = [];
      if (check.overflow > 0) problems.push(`scrolls ${check.overflow}px sideways`);
      if (check.footer - check.wordmark > 32)
        problems.push(`wordmark ${check.wordmark}px of ${check.footer}px`);
      if (check.motion && check.hidden) problems.push(`${check.hidden} reveals never shown`);
      if (motion === 'reduce' && check.motion) problems.push('reveals run under reduced motion');
      console.log(
        `${problems.length ? '✗' : '✓'} ${label}${problems.length ? `: ${problems.join(', ')}` : ''}`
      );
      if (problems.length) failed = true;
      if (SAVED.has(size.name) && motion === 'reduce') {
        await page.screenshot({ path: join(out, `${size.name}-${theme}.png`), fullPage: true });
      }
      await page.close();
    }
  }
}

// About two loops of the hero demo, light theme, at desktop width.
const video = join(out, '.video');
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: 'light',
  recordVideo: { dir: video, size: { width: 1280, height: 800 } }
});
const page = await context.newPage();
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.querySelector('figure').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(20_000);
const file = await page.video().path();
await context.close();
renameSync(file, join(out, 'hero-demo.webm'));
rmSync(video, { recursive: true, force: true });

await browser.close();
if (failed) process.exit(1);
