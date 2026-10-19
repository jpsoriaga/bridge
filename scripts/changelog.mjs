// Prints one version's section of CHANGELOG.md (Keep a Changelog format), without its
// heading, for the release notes:
//
//   node scripts/changelog.mjs v1.0.0
//
// Fails if there's no section for the version, or it's empty.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './version.mjs';

/** The body of `## [version]` in `text`, trimmed, or null if it's missing or empty. */
export function changelogSection(text, version) {
  const want = version.replace(/^v/, '');
  const lines = text.split(/\r?\n/);
  const heading = (line) => /^## \[([^\]]+)\]/.exec(line)?.[1] ?? null;
  const start = lines.findIndex((line) => heading(line) === want);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => heading(line) !== null || /^\[[^\]]+\]:\s/.test(line));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body === '' ? null : body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/changelog.mjs <version>');
    process.exit(2);
  }
  const section = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (section === null) {
    console.error(
      `CHANGELOG.md has no section for ${version}. Add "## [${version.replace(/^v/, '')}] - YYYY-MM-DD".`
    );
    process.exit(1);
  }
  console.log(section);
}
