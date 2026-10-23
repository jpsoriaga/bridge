// `pnpm build:extension:release`: the release builds of the extension.
//
//   release/bridge-extension-<version>.zip            for the Chrome Web Store
//   release/bridge-extension-<version>-unpacked.zip   for "Load unpacked"
//
// A beta (1.2.0-beta.1) gets only the unpacked zip: betas go to testers, who load it
// unpacked so it has the fixed ID the app accepts, and never to the store.
//
// Both are production builds (minified, no source maps, no dev-only code). The store zip
// has no manifest `key` (BRIDGE_RELEASE=1; the store assigns the ID and refuses a key). The
// unpacked one keeps it, so it gets the fixed ID the app accepts. Each zip holds only the
// build's contents, at its root. Refuses to finish if any of that isn't true.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, isBeta, readVersions, ROOT } from './version.mjs';
import { listFiles, zipDir } from './zip.mjs';

export const OUT_DIR = join(ROOT, 'release', 'extension');
export const UNPACKED_DIR = join(ROOT, 'release', 'extension-unpacked');

/** Text only the dev build's side panel shows (the file tester and page diagnostics). */
export const DEV_ONLY = ['(dev only)'];

/** The zips to build for `version`: both for a release, only the unpacked one for a beta. */
export function releaseBuilds(version) {
  const builds = [
    { dir: OUT_DIR, key: false, zip: `bridge-extension-${version}.zip` },
    { dir: UNPACKED_DIR, key: true, zip: `bridge-extension-${version}-unpacked.zip` }
  ];
  return isBeta(version) ? builds.filter((build) => build.key) : builds;
}

/**
 * The manifest's `version` (numbers only) and `version_name` (a beta's full version) for
 * `version`. The same split as `manifestVersion` in @bridge/shared.
 */
export function manifestFields(version) {
  const [numbers] = version.split('-');
  return isBeta(version) ? { version: numbers, version_name: version } : { version: numbers };
}

/** What's wrong with a release build in `dir` (an empty list when it's fit to upload). */
export function releaseProblems(dir, version, { key = false } = {}) {
  const problems = [];
  const files = listFiles(dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!key && 'key' in manifest) problems.push('manifest.json still has a key');
  if (key && !('key' in manifest)) problems.push('manifest.json has no key');
  const want = manifestFields(version);
  if (manifest.version !== want.version) {
    problems.push(`manifest version ${manifest.version}, expected ${want.version}`);
  }
  if (manifest.version_name !== want.version_name) {
    problems.push(`manifest version_name ${manifest.version_name}, expected ${want.version_name}`);
  }
  if (JSON.stringify(manifest).includes('<all_urls>'))
    problems.push('manifest asks for <all_urls>');
  for (const file of files) {
    if (file.endsWith('.map')) problems.push(`${file}: source map`);
    if (!/\.(js|html|css)$/.test(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    if (text.includes('sourceMappingURL=')) problems.push(`${file}: links a source map`);
    for (const marker of DEV_ONLY) {
      if (text.includes(marker)) problems.push(`${file}: dev-only code (${marker})`);
    }
    // The e2e port range only exists in builds for the e2e scripts.
    if (text.includes('47921')) problems.push(`${file}: built for the e2e port range`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const versionProblems = checkVersions();
  if (versionProblems.length > 0) {
    for (const problem of versionProblems) console.error(problem);
    process.exit(1);
  }
  const version = readVersions()['apps/extension/package.json'];
  mkdirSync(join(ROOT, 'release'), { recursive: true });
  if (isBeta(version)) console.log(`${version} is a beta: only the Load unpacked zip.`);
  for (const { dir, key, zip } of releaseBuilds(version)) {
    rmSync(dir, { recursive: true, force: true });
    const env = { ...process.env, NODE_ENV: 'production' };
    delete env.BRIDGE_E2E;
    if (key) delete env.BRIDGE_RELEASE;
    else env.BRIDGE_RELEASE = '1';
    const build = spawnSync(
      'pnpm',
      [
        '--filter',
        '@bridge/extension',
        'exec',
        'vite',
        'build',
        '--mode',
        'production',
        '--outDir',
        dir,
        '--emptyOutDir'
      ],
      { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' }
    );
    if (build.status !== 0) process.exit(build.status ?? 1);

    const problems = releaseProblems(dir, version, { key });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`✗ ${zip}: ${problem}`);
      process.exit(1);
    }
    const zipPath = join(ROOT, 'release', zip);
    writeFileSync(zipPath, zipDir(dir));
    console.log(
      `✓ ${zipPath} (${listFiles(dir).length} files, ${key ? 'fixed ID for Load unpacked' : 'no key'}, no source maps)`
    );
  }
}
