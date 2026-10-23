import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  defaultChannel,
  isBetaVersion,
  manifestVersion,
  offersUpdate,
  parseVersion
} from './version';

describe('parseVersion', () => {
  it('reads releases and betas', () => {
    expect(parseVersion('1.2.0')).toEqual({ major: 1, minor: 2, patch: 0, beta: null });
    expect(parseVersion('1.2.0-beta.1')).toEqual({ major: 1, minor: 2, patch: 0, beta: 1 });
    expect(parseVersion('v10.0.3-beta.12')).toEqual({ major: 10, minor: 0, patch: 3, beta: 12 });
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      '1.2',
      '1.2.0.0',
      '01.2.0',
      '1.2.0-beta',
      '1.2.0-beta.0',
      '1.2.0-beta.01',
      '1.2.0-rc.1',
      '1.2.0-alpha.1',
      '1.2.0+build',
      '65536.0.0',
      '1.2.0-beta.65536'
    ]) {
      expect(parseVersion(bad), bad).toBeNull();
    }
    expect(isBetaVersion('1.2.0-beta.1')).toBe(true);
    expect(isBetaVersion('1.2.0')).toBe(false);
    expect(isBetaVersion('nonsense')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders betas before their release, like semver', () => {
    const sorted = [
      '1.1.0',
      '1.2.0-beta.1',
      '1.2.0-beta.2',
      '1.2.0-beta.10',
      '1.2.0',
      '1.2.1',
      '2.0.0-beta.1'
    ];
    const shuffled = [...sorted].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(sorted);
    expect(compareVersions('1.2.0-beta.1', '1.2.0-beta.1')).toBe(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(() => compareVersions('1.2.0', 'x')).toThrow(/Not a Bridge version: x/);
  });
});

describe('manifestVersion', () => {
  it('keeps numbers in version and the beta in version_name', () => {
    expect(manifestVersion('1.2.0')).toEqual({ version: '1.2.0' });
    expect(manifestVersion('1.2.0-beta.1')).toEqual({
      version: '1.2.0',
      version_name: '1.2.0-beta.1'
    });
    expect(() => manifestVersion('1.2.0-rc.1')).toThrow();
  });
});

describe('update channels', () => {
  it('starts betas on beta and releases on stable', () => {
    expect(defaultChannel('1.2.0-beta.1')).toBe('beta');
    expect(defaultChannel('1.2.0')).toBe('stable');
  });

  it('never shows a beta on the stable channel', () => {
    expect(offersUpdate('stable', '1.1.0', '1.2.0-beta.1')).toBe(false);
    expect(offersUpdate('stable', '1.2.0-beta.1', '1.2.0-beta.2')).toBe(false);
    expect(offersUpdate('stable', '1.1.0', '1.2.0')).toBe(true);
    expect(offersUpdate('stable', '1.2.0-beta.1', '1.2.0')).toBe(true);
    expect(offersUpdate('stable', '1.2.0', '1.1.0')).toBe(false);
  });

  it('shows newer betas and releases on the beta channel', () => {
    expect(offersUpdate('beta', '1.2.0-beta.1', '1.2.0-beta.2')).toBe(true);
    expect(offersUpdate('beta', '1.2.0-beta.1', '1.2.0')).toBe(true);
    expect(offersUpdate('beta', '1.1.0', '1.2.0-beta.1')).toBe(true);
    expect(offersUpdate('beta', '1.2.0-beta.2', '1.2.0-beta.1')).toBe(false);
    expect(offersUpdate('beta', '1.2.0', '1.2.0-beta.3')).toBe(false);
    expect(offersUpdate('beta', '1.2.0-beta.1', '1.2.0-beta.1')).toBe(false);
  });

  it('ignores versions it can’t read', () => {
    expect(offersUpdate('beta', '1.2.0', '1.3.0-rc.1')).toBe(false);
    expect(offersUpdate('beta', 'dev', '1.3.0')).toBe(false);
  });
});
