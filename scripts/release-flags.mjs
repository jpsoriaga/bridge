// The extra `gh release create` flags for a tag, one per line, for the release workflow:
//
//   node scripts/release-flags.mjs v1.2.0          (nothing: a normal release, as before)
//   node scripts/release-flags.mjs v1.2.0-beta.1   --prerelease and --latest=false
//   node scripts/release-flags.mjs --intro <tag>   a beta's line above the release notes
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

/** The line a beta's release notes start with, pointing testers at BETA.md; '' otherwise. */
export function releaseIntro(tag) {
  if (releaseFlags(tag).length === 0) return '';
  return (
    `**Beta for testers.** Not a stable release. Install steps, what to test and how to ` +
    `report problems: [BETA.md](https://github.com/jpsoriaga/bridge/blob/${tag}/BETA.md).`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--intro') {
      const intro = releaseIntro(args[1] ?? '');
      if (intro) console.log(`${intro}\n`);
      process.exit(0);
    }
    const flags = releaseFlags(args[0] ?? '');
    if (flags.length > 0) console.log(flags.join('\n'));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
