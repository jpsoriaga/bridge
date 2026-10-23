// The extra `gh release create` flags for a tag, one per line, for the release workflow:
//
//   node scripts/release-flags.mjs v1.2.0          (nothing: a normal release, as before)
//   node scripts/release-flags.mjs v1.2.0-beta.1   --prerelease and --latest=false
//
// A beta is a GitHub pre-release and never "Latest", so the stable update check (which asks
// for the latest release) and the README's "latest release" links never land on it.
// Fails on a tag that isn't a version.
import { fileURLToPath } from 'node:url';
import { isBeta, isReleaseVersion } from './version.mjs';

export function releaseFlags(tag) {
  const version = tag.replace(/^v/, '');
  if (!tag.startsWith('v') || !isReleaseVersion(version)) {
    throw new Error(`Not a release tag: ${JSON.stringify(tag)}. Use vX.Y.Z or vX.Y.Z-beta.N.`);
  }
  return isBeta(version) ? ['--prerelease', '--latest=false'] : [];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const flags = releaseFlags(process.argv[2] ?? '');
    if (flags.length > 0) console.log(flags.join('\n'));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
