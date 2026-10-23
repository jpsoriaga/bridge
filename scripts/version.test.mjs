import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkVersions,
  isBeta,
  isReleaseVersion,
  readVersions,
  ROOT,
  setVersion,
  VERSIONED
} from './version.mjs';

/** A copy of the four package.json files in a temp folder. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-version-'));
  for (const file of VERSIONED) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  return root;
}

describe('version', () => {
  it('is the same in every package of the repo', () => {
    expect(checkVersions()).toEqual([]);
  });

  it('accepts MAJOR.MINOR.PATCH that Chrome takes, and -beta.N', () => {
    for (const ok of ['0.0.1', '1.0.0', '10.20.30', '65535.0.0', '1.2.0-beta.1', '1.2.0-beta.12']) {
      expect(isReleaseVersion(ok)).toBe(true);
    }
    for (const bad of [
      '1.0',
      '1.0.0.0',
      '01.0.0',
      'v1.0.0',
      '65536.0.0',
      '',
      '1.0.0-beta',
      '1.0.0-beta.0',
      '1.0.0-rc.1',
      '1.0.0-alpha.1',
      '1.0.0-beta.65536'
    ]) {
      expect(isReleaseVersion(bad)).toBe(false);
    }
    expect(isBeta('1.2.0-beta.1')).toBe(true);
    expect(isBeta('v1.2.0-beta.1')).toBe(true);
    expect(isBeta('1.2.0')).toBe(false);
    expect(isBeta('1.2.0-beta')).toBe(false);
  });

  it('sets every package and keeps the rest of each file', () => {
    const root = fixture();
    const before = readFileSync(join(root, 'apps/extension/package.json'), 'utf8');
    setVersion('3.4.5', root);
    expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(['3.4.5']));
    const after = readFileSync(join(root, 'apps/extension/package.json'), 'utf8');
    expect(after.replace('"3.4.5"', '"x"')).toBe(
      before.replace(/"version": "[^"]*"/, '"version": "x"')
    );
    expect(checkVersions('v3.4.5', root)).toEqual([]);
    expect(checkVersions('3.4.6', root)).toEqual(['Version is 3.4.5, expected 3.4.6']);
  });

  it('sets and checks a beta against its tag', () => {
    const root = fixture();
    setVersion('1.2.0-beta.1', root);
    expect(new Set(Object.values(readVersions(root)))).toEqual(new Set(['1.2.0-beta.1']));
    expect(checkVersions('v1.2.0-beta.1', root)).toEqual([]);
    expect(checkVersions('v1.2.0', root)).toEqual(['Version is 1.2.0-beta.1, expected 1.2.0']);
  });

  it('refuses a bad version and reports a mismatch', () => {
    const root = fixture();
    expect(() => setVersion('1.0.0-rc.1', root)).toThrow(/Not a release version/);
    const file = join(root, 'packages/shared/package.json');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/"version": "[^"]*"/, '"version": "9.9.9"')
    );
    expect(checkVersions(undefined, root)[0]).toMatch(/^Versions differ: .*9\.9\.9/);
  });
});
