// Which CI jobs a push or pull request needs (ci.yml's `changes` job). A change only under
// apps/site skips the app checks and e2e; the site job runs when the site or what it's built
// from changes. With no usable base (a new branch, a tag, the release workflow's call),
// everything runs.
//   BASE=<sha> HEAD=<sha> node scripts/ci-changes.mjs   → app=true|false, site=true|false
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SITE_ONLY = 'apps/site/';

// What the site build reads outside apps/site, and the tooling its CI job runs.
const SITE_INPUTS = [
  SITE_ONLY,
  'packages/shared/assets/',
  'packages/shared/src/tokens.css',
  'packages/shared/src/brand.ts',
  'packages/shared/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.js',
  '.prettierrc',
  '.prettierignore',
  '.nvmrc',
  '.github/workflows/ci.yml',
  'scripts/ci-changes.mjs'
];

/** @param {string[] | null} files changed paths, or null when they can't be known */
export function classify(files) {
  if (files === null) return { app: true, site: true };
  return {
    app: files.some((f) => !f.startsWith(SITE_ONLY)),
    site: files.some((f) => SITE_INPUTS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)))
  };
}

const usable = (sha) => Boolean(sha) && !/^0+$/.test(sha);

/** The files changed between two commits, or null if git can't tell. */
export function changedFiles(base, head) {
  if (!usable(base) || !usable(head)) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8'
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const result = classify(changedFiles(process.env.BASE, process.env.HEAD));
  const lines = `app=${result.app}\nsite=${result.site}\n`;
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
