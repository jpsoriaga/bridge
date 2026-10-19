// Checks packaged apps: the fuses are as scripts/fuses.cjs sets them, and app.asar holds
// only the built app and its production dependencies (no source, tests, source maps, e2e,
// fixtures, archive/ or dev dependencies).
//
//   node scripts/check-package.mjs                  every app under dist/
//   node scripts/check-package.mjs dist/mac-arm64/Bridge.app
//
// Exits 1 on the first problem in any app.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Folders that hold tests, fixtures or other code that never runs. */
const TEST_FOLDERS = [
  'archive',
  'e2e',
  'fixtures',
  'coverage',
  '__tests__',
  'test',
  'tests',
  'benchmark',
  'benchmarks'
];

/** Folders and files that must never be in the package, wherever they are. */
const FORBIDDEN = [
  { test: (path) => path.endsWith('.map'), why: 'source map' },
  { test: (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path), why: 'test file' },
  { test: (path) => /\.[cm]?tsx?$/.test(path), why: 'TypeScript' },
  {
    test: (path) => path.split('/').some((part) => TEST_FOLDERS.includes(part)),
    why: 'archive, e2e, fixtures, tests or coverage'
  },
  {
    test: (path) => /(^|\/)(\.env[^/]*|.*\.pem|.*\.key|\.npmrc)$/.test(path),
    why: 'secret-looking file'
  }
];

/** Where an `out/` file may be: the three electron-vite builds. */
const OUT_DIRS = ['out/main/', 'out/preload/', 'out/renderer/'];

/** Finds `name`'s package folder the way Node would from `fromDir` (pnpm's layout included). */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    // The real path: pnpm links each package from its store folder, beside its own deps.
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Names of every package the desktop app needs at runtime: its `dependencies`, and theirs,
 * all the way down (optional ones if installed). Dev dependencies are never reached.
 */
export function productionPackages(root = DESKTOP) {
  const names = new Set();
  const seen = new Set();
  const visit = (dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(deps)) {
      const found = findPackage(dir, name);
      if (!found) continue; // an optional dependency that isn't installed
      names.add(name);
      if (!seen.has(found)) {
        seen.add(found);
        visit(found);
      }
    }
  };
  visit(root);
  return names;
}

/** The package names in a path: `node_modules/a/node_modules/@s/b/x.js` → `a`, `@s/b`. */
function packagesIn(path) {
  const parts = path.split('/');
  const names = [];
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue;
    const scoped = parts[i + 1].startsWith('@');
    // A scope's own folder (`node_modules/@fastify`) isn't a package.
    if (scoped && parts[i + 2] === undefined) continue;
    names.push(scoped ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1]);
  }
  return names;
}

/** What's wrong with these asar entries (paths relative to the asar root, `/`-separated). */
export function asarProblems(files, allowedPackages) {
  const problems = [];
  if (!files.includes('package.json')) problems.push('package.json is missing');
  if (!files.some((f) => f === 'out/main/index.js')) problems.push('out/main/index.js is missing');
  for (const file of files) {
    const top = file.split('/')[0];
    if (!['package.json', 'out', 'node_modules'].includes(top)) {
      problems.push(`${file}: not part of the built app`);
      continue;
    }
    if (
      top === 'out' &&
      file !== 'out' &&
      !OUT_DIRS.some((d) => file.startsWith(d) || `${file}/` === d)
    ) {
      problems.push(`${file}: not part of the main, preload or renderer build`);
    }
    for (const name of packagesIn(file)) {
      if (!allowedPackages.has(name))
        problems.push(`${file}: ${name} isn't a production dependency`);
    }
    const forbidden = FORBIDDEN.find((rule) => rule.test(file));
    if (forbidden) problems.push(`${file}: ${forbidden.why}`);
  }
  return problems;
}

/** The asar inside a packaged app (the .app bundle, or the folder holding Bridge.exe or bridge). */
export function asarOf(app) {
  if (app.endsWith('.app')) return join(app, 'Contents', 'Resources', 'app.asar');
  return join(dirname(app), 'resources', 'app.asar');
}

/** Every packaged app electron-builder left under dist/. */
function builtApps(dist) {
  if (!existsSync(dist)) return [];
  const apps = [];
  for (const dir of readdirSync(dist)) {
    const path = join(dist, dir);
    if (dir.startsWith('mac') && existsSync(join(path, 'Bridge.app')))
      apps.push(join(path, 'Bridge.app'));
    if (dir === 'win-unpacked' && existsSync(join(path, 'Bridge.exe')))
      apps.push(join(path, 'Bridge.exe'));
    if (dir === 'linux-unpacked' && existsSync(join(path, 'bridge')))
      apps.push(join(path, 'bridge'));
  }
  return apps;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { listPackage } = require('@electron/asar');
  const { getCurrentFuseWire } = require('@electron/fuses');
  const { mismatches } = require('./fuses.cjs');
  const apps =
    process.argv.length > 2
      ? process.argv.slice(2).map((a) => resolve(a))
      : builtApps(join(DESKTOP, 'dist'));
  if (apps.length === 0) {
    console.error('No packaged app found. Run pnpm package:mac (or :win, :linux) first.');
    process.exit(2);
  }
  const allowed = productionPackages();
  let failed = false;
  for (const app of apps) {
    const wrongFuses = mismatches(await getCurrentFuseWire(app));
    const files = listPackage(asarOf(app), { isPack: false }).map((f) =>
      f.replace(/\\/g, '/').replace(/^\//, '')
    );
    const problems = [
      ...wrongFuses.map((w) => `fuse ${w.fuse} is ${w.found}, wanted ${w.wanted}`),
      ...asarProblems(files, allowed)
    ];
    if (problems.length === 0) {
      console.log(
        `✓ ${app}: fuses as configured, ${files.length} asar entries, nothing unexpected`
      );
    } else {
      failed = true;
      console.error(`✗ ${app}:`);
      for (const problem of problems.slice(0, 50)) console.error(`  ${problem}`);
      if (problems.length > 50) console.error(`  …and ${problems.length - 50} more`);
    }
  }
  process.exit(failed ? 1 : 0);
}
