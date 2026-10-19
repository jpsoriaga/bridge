import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection } from './changelog.mjs';
import { readVersions, ROOT } from './version.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

## [1.1.0] - 2026-11-01

### Fixed

- A thing.

## [1.0.0] - 2026-10-19

### Added

- Everything.

[1.1.0]: https://example.com/compare/v1.0.0...v1.1.0
[1.0.0]: https://example.com/releases/tag/v1.0.0
`;

describe('changelogSection', () => {
  it('returns the body of one version, up to the next one or the links', () => {
    expect(changelogSection(SAMPLE, 'v1.1.0')).toBe('### Fixed\n\n- A thing.');
    expect(changelogSection(SAMPLE, '1.0.0')).toBe('### Added\n\n- Everything.');
  });

  it('is null for a missing or empty section', () => {
    expect(changelogSection(SAMPLE, '2.0.0')).toBeNull();
    expect(changelogSection(SAMPLE, 'Unreleased')).toBeNull();
  });

  it('has a section for the current version', () => {
    const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    expect(changelogSection(text, readVersions()['package.json'])).not.toBeNull();
  });
});
