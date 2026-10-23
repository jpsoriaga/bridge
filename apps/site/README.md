# Bridge landing page

The one-page site at **https://bridge.jpsoriaga.me**: what Bridge is, how to set it up, the
downloads, the FAQ and the Support section. React + TypeScript + Tailwind CSS v4 on Vite, built
to static files and hosted on Vercel. It has no server, no analytics and no cookies; the only
request it makes is to the GitHub Releases API, for the download links.

It's a private workspace package (`@bridge/site`), separate from the app and the extension:
`pnpm version:set`, the release workflow and the root `pnpm build` leave it alone.

## Run it locally

From the repository root:

```bash
pnpm install
pnpm --filter site dev        # http://localhost:5173
```

| Command                        | What it does                                         |
| ------------------------------ | ---------------------------------------------------- |
| `pnpm --filter site dev`       | Dev server with hot reload                           |
| `pnpm --filter site build`     | Typecheck, then the static build in `apps/site/dist` |
| `pnpm --filter site preview`   | Serves `dist` to check the build                     |
| `pnpm --filter site test`      | Vitest (jsdom)                                       |
| `pnpm --filter site typecheck` | `tsc --noEmit`                                       |
| `pnpm exec eslint apps/site`   | Lint, with the repository's ESLint config            |

The download section reads the real releases. With no published release it shows the link to
the Releases page instead, which is expected.

### Where things are

- `src/config/site.ts`: `SITE_URL` (the domain, in one place) and every outside link.
- `src/config/funding.ts`: the Support section's goals and links (see "Funding").
- `src/lib/platform.ts`, `src/lib/releases.ts`: which installer to show first, and picking the
  files from the Releases API (a stable release wins over a beta; any failure falls back to the
  Releases page).
- `src/styles/index.css`: the design tokens from `@bridge/shared/tokens.css`, mapped into
  Tailwind's theme. Components use those utilities only (`bg-bg-muted`, `text-fg-subtle`…),
  never raw colours. The motion tokens (`--motion-fast`, `--motion-base`, `--motion-slow`, the
  two curves) are there too, and every transition uses them. DESIGN.md, "Landing page", has
  the site's additions.
- `public/`: icons, the share image (`og.png`), `theme.js` (applies the saved theme before the
  first paint). `robots.txt` and `sitemap.xml` are written at build time from `SITE_URL`.
- `src/lib/motion.ts`: reduced-motion detection and the scroll reveals (`data-reveal`); the
  hero demo's timeline is in `src/components/ChatDemo.tsx`.
- `scripts/screenshots.mjs`: with `pnpm --filter site preview` running, checks every width
  from 320 to 2560px in both themes, with and without reduced motion (no sideways scroll,
  every reveal shows), watches three loops of the hero demo (its height never changes, every
  part fades out together), writes `docs/screenshots/site/` and records the hero demo
  (`hero-demo.webm`). Same Chromium setup as `images.mjs` below.
- `scripts/images.mjs`: renders the icons and `og.png` from the logo. Run it after changing
  either: `npm ci --prefix e2e && npx --prefix e2e playwright-core install chromium`, then
  `node apps/site/scripts/images.mjs`.

## Deploy to Vercel

`vercel.json` holds the settings, so the project needs only its root directory.

1. On vercel.com, **Add New… → Project**, and import the `jpsoriaga/bridge` repository.
2. **Root Directory:** `apps/site`. Leave "Include files outside the root directory in the Build
   Step" on (the site uses the logo and tokens from `packages/shared`).
3. Framework, install, build and output come from `vercel.json`:
   - install: `pnpm install --frozen-lockfile --filter @bridge/site...` (the site and its
     workspace dependencies only, so no Electron download)
   - build: `pnpm build`
   - output: `dist`
4. Node.js 24 comes from `engines` in `apps/site/package.json`, matching `.nvmrc`.
5. Deploy. Every push to `main` deploys to production, and pull requests get preview URLs.

**Skipped builds.** The `ignoreCommand` in `vercel.json` skips a deployment unless the commit
changed `apps/site/`, `packages/shared/assets/`, `packages/shared/src/tokens.css` or
`packages/shared/src/brand.ts` (the parts of `packages/shared` the site uses). To force one, use
**Redeploy** in the Vercel dashboard.

`vercel.json` also sets the security headers (a strict Content-Security-Policy that allows
only the site's own files and `api.github.com`, `nosniff`, a referrer policy, a permissions
policy) and long caching for the hashed files in `/assets/`.

## Point bridge.jpsoriaga.me at it

1. In Vercel: Project → **Settings → Domains → Add**, enter `bridge.jpsoriaga.me`.
2. At the DNS provider for `jpsoriaga.me`, add the record Vercel shows. For a subdomain it's:

   | Type  | Name     | Value                  |
   | ----- | -------- | ---------------------- |
   | CNAME | `bridge` | `cname.vercel-dns.com` |

   (Vercel may show a project-specific value instead, like `abc123.vercel-dns-017.com`; use
   what the dashboard says. If the domain's DNS is already on Vercel, it adds the record itself.)

3. Wait for the domain to show **Valid Configuration**. Vercel issues the HTTPS certificate on
   its own.

## Switch to a new domain later

1. Change `SITE_URL` in `src/config/site.ts`. The canonical URL, the Open Graph and Twitter
   tags, `robots.txt` and `sitemap.xml` all follow it.
2. Update the domain in the funding goal's text (`src/config/funding.ts`, "bridge.jpsoriaga.me
   until then") and mark the domain item as funded.
3. Update the two links in the root `README.md` (the site link at the top and the Support
   line), and `custom:` in `.github/FUNDING.yml` if you use it.
4. In Vercel, add the new domain under **Settings → Domains**. Set the old one to redirect
   (308) to the new one, so existing links keep working.
5. At the new domain's DNS provider: for the apex (`example.com`) an `A` record to
   `76.76.21.21`, for a subdomain a `CNAME` to `cname.vercel-dns.com` (or what Vercel shows).
6. Push. The next deployment uses the new URL.

## Funding

`src/config/funding.ts` is updated by hand; the page doesn't fetch or track anything.

- **Progress:** set `raised` (US dollars) on each item in `FUNDING_GOALS`. The bar shows
  `$raised / $goal`, and once `raised` reaches `goal` the item reads "Funded, thank you!".
- **Links:** fill in `SUPPORT_LINKS`. A button appears only when its value is set:
  - `githubSponsors`: e.g. `https://github.com/sponsors/<you>`
  - `kofi`: e.g. `https://ko-fi.com/<you>`
  - `gcashQr`: `'/gcash-qr.png'` once the image is in place (below)

  With none set, the section shows the two costs and the "Can’t chip in?" card with **Star on
  GitHub** and **Report a bug**, so it reads as finished either way.

- **GCash QR:** export the QR from the GCash app, save it as `apps/site/public/gcash-qr.png`
  (square, about 640×640 px, under 200 KB), and set `gcashQr: '/gcash-qr.png'`. The image loads
  only when someone opens the GCash dialog.
- **GitHub's Sponsor button:** uncomment the matching lines in `.github/FUNDING.yml`.

## CI

`.github/workflows/ci.yml` has a `site` job (Prettier, ESLint, typecheck, tests and build for
this package) that runs only when the site or what it's built from changes
(`scripts/ci-changes.mjs`). A change only under `apps/site/` skips the app checks and e2e.
