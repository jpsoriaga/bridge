// One version for the whole of Bridge: the root, the desktop app, the extension (its
// manifest reads apps/extension/package.json) and @bridge/shared.
//
//   pnpm version:set 1.2.0       set it everywhere
//   pnpm version:check           fail unless every package has the same version
//   pnpm version:check v1.2.0    ...and it is this one (the release workflow passes the tag)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every package.json that carries the version, relative to the root. */
export const VERSIONED = [
  'package.json',
  'apps/desktop/package.json',
  'apps/extension/package.json',
  'packages/shared/package.json'
];

/**
 * `MAJOR.MINOR.PATCH` only. Chrome takes at most four dot-separated integers of 0–65535
 * with no leading zeros and refuses pre-release tags, so the shared version keeps to what
 * both the store and electron-builder accept.
 */
export function isReleaseVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  return version.split('.').every((part) => Number(part) <= 65535);
}

/** The version in each package.json, keyed by path. */
export function readVersions(root = ROOT) {
  return Object.fromEntries(
    VERSIONED.map((file) => [file, JSON.parse(readFileSync(join(root, file), 'utf8')).version])
  );
}

/** Writes `version` into every package.json, keeping the rest of each file as it was. */
export function setVersion(version, root = ROOT) {
  if (!isReleaseVersion(version)) {
    throw new Error(`Not a release version: ${JSON.stringify(version)}. Use MAJOR.MINOR.PATCH.`);
  }
  for (const file of VERSIONED) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    // Replace only the top-level "version" value, so key order and formatting stay.
    const next = text.replace(/^(\s{2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
    if (next === text && JSON.parse(text).version !== version) {
      throw new Error(`${file} has no top-level "version" field.`);
    }
    writeFileSync(path, next);
  }
}

/** Problems with the versions: they differ, or aren't `expected` (a `v`-prefixed tag is fine). */
export function checkVersions(expected, root = ROOT) {
  const versions = readVersions(root);
  const distinct = [...new Set(Object.values(versions))];
  const problems = [];
  if (distinct.length !== 1) {
    problems.push(
      'Versions differ: ' +
        Object.entries(versions)
          .map(([file, v]) => `${file} ${v}`)
          .join(', ')
    );
  } else if (!isReleaseVersion(distinct[0])) {
    problems.push(`Not a release version: ${distinct[0]}`);
  }
  const want = expected?.replace(/^v/, '');
  if (want !== undefined && distinct.length === 1 && distinct[0] !== want) {
    problems.push(`Version is ${distinct[0]}, expected ${want}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, value] = process.argv.slice(2);
  try {
    if (command === 'set' && value) {
      setVersion(value);
      console.log(`Version set to ${value} in ${VERSIONED.join(', ')}`);
    } else if (command === 'check') {
      const problems = checkVersions(value);
      if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        process.exit(1);
      }
      console.log(`Version ${readVersions()['package.json']} everywhere`);
    } else {
      console.error('Usage: node scripts/version.mjs set <MAJOR.MINOR.PATCH> | check [version]');
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
