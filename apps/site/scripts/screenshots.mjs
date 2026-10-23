// Screenshots of the built page for docs/screenshots/site/, plus the checks they stand for:
// no horizontal scroll at any width, every reveal shown, no footer wordmark. Then it watches
// three loops of the hero demo (its height never changes, every part fades out together at
// the end) and records it. Uses the Chromium the e2e scripts use:
//   npm ci --prefix e2e && npx --prefix e2e playwright-core install chromium
//   pnpm --filter site build && pnpm --filter site preview   (in another terminal)
//   node apps/site/scripts/screenshots.mjs [http://localhost:4173]
/* global document, getComputedStyle, innerHeight, innerWidth, scrollTo -- inside page.evaluate(), in the browser */
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
  { name: 'full-hd', width: 1920, height: 1080 },
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
        const hidden = [...document.querySelectorAll('[data-reveal]:not([data-shown])')].length;
        return {
          overflow: document.documentElement.scrollWidth - innerWidth,
          wordmark: document.querySelector('footer svg text, .wordmark') !== null,
          motion: document.documentElement.hasAttribute('data-motion'),
          hidden
        };
      });
      const label = `${size.name} ${theme} ${motion}`;
      const problems = [];
      if (check.overflow > 0) problems.push(`scrolls ${check.overflow}px sideways`);
      if (check.wordmark) problems.push('the footer has a wordmark');
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

// Three loops of the hero demo at a phone and a desktop width: the frame and the page keep
// their height, and during the exit every part has the same opacity.
for (const width of [390, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelector('figure').scrollIntoView({ block: 'center' }));
  const watch = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const figure = document.querySelector('figure');
        const heights = new Set();
        const pages = new Set();
        const exits = [];
        let loops = 0;
        let last = figure.dataset.step;
        const timer = setInterval(() => {
          heights.add(Math.round(figure.getBoundingClientRect().height));
          pages.add(document.documentElement.scrollHeight);
          const step = figure.dataset.step;
          if (step === 'exit') {
            // The top-level parts that are drawn (the side panel isn't, on phones).
            const parts = [...figure.querySelectorAll('.demo-part')].filter(
              (el) => !el.parentElement.closest('.demo-part') && el.getClientRects().length
            );
            const values = parts.map((el) => Number(getComputedStyle(el).opacity).toFixed(2));
            exits.push(new Set(values).size);
          }
          if (step === 'empty' && last !== 'empty') loops += 1;
          last = step;
          if (loops > 3) {
            clearInterval(timer);
            resolve({ heights: [...heights], pages: [...pages], exits });
          }
        }, 50);
      })
  );
  const problems = [];
  if (watch.heights.length > 1) problems.push(`demo heights ${watch.heights.join(', ')}`);
  if (watch.pages.length > 1) problems.push(`page heights ${watch.pages.join(', ')}`);
  if (!watch.exits.length) problems.push('never saw the exit');
  if (watch.exits.some((n) => n > 1)) problems.push('parts fade out at different rates');
  console.log(
    `${problems.length ? '✗' : '✓'} demo loops at ${width}px${problems.length ? `: ${problems.join(', ')}` : ''}`
  );
  if (problems.length) failed = true;
  await page.close();
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
await page.waitForTimeout(25_000);
const file = await page.video().path();
await context.close();
renameSync(file, join(out, 'hero-demo.webm'));
rmSync(video, { recursive: true, force: true });

await browser.close();
if (failed) process.exit(1);
