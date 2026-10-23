import { describe, expect, it } from 'vitest';
import { builderArgs, builderEnv, SECRETS, signingPlan } from './package.mjs';

const all = (platform) => Object.fromEntries(SECRETS[platform].map((name) => [name, 'x']));

describe('signingPlan', () => {
  it('signs with every secret, builds unsigned with none', () => {
    expect(signingPlan('mac', all('mac'))).toEqual({ sign: true });
    expect(signingPlan('win', all('win'))).toEqual({ sign: true });
    expect(signingPlan('mac', {})).toEqual({ sign: false });
    expect(signingPlan('win', { WIN_CSC_LINK: '  ' })).toEqual({ sign: false });
    expect(signingPlan('linux', all('mac'))).toEqual({ sign: false });
  });

  it('refuses a partial set, naming what is missing', () => {
    const partial = all('mac');
    delete partial.APPLE_API_ISSUER;
    expect(() => signingPlan('mac', partial)).toThrow(/not APPLE_API_ISSUER/);
    expect(() => signingPlan('win', { WIN_CSC_LINK: 'x' })).toThrow(/not WIN_CSC_KEY_PASSWORD/);
    expect(() => signingPlan('beos', {})).toThrow(/Unknown platform/);
  });
});

describe('builderArgs', () => {
  it('never publishes', () => {
    for (const platform of ['mac', 'win', 'linux']) {
      for (const sign of [true, false]) {
        const { args } = builderArgs(platform, { sign });
        expect(args.slice(1, 3)).toEqual(['--publish', 'never']);
      }
    }
  });

  it('unsigned macOS: ad-hoc, no hardened runtime or notarization, update checks off', () => {
    const { args, env } = builderArgs('mac', { sign: false });
    expect(args).toEqual(
      expect.arrayContaining([
        '-c.mac.identity=-',
        '-c.mac.hardenedRuntime=false',
        '-c.mac.notarize=false',
        '-c.extraMetadata.bridgeBuild.updates=false'
      ])
    );
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false');
  });

  it('signed macOS: notarized, update checks on, hardened runtime from the config', () => {
    const { args, env } = builderArgs('mac', { sign: true });
    expect(args).toContain('-c.mac.notarize=true');
    expect(args).toContain('-c.extraMetadata.bridgeBuild.updates=true');
    expect(args.join(' ')).not.toMatch(/hardenedRuntime|identity/);
    expect(env).toEqual({});
  });

  it('unsigned Windows: no keychain discovery', () => {
    expect(builderArgs('win', { sign: false })).toEqual({
      args: ['--win', '--publish', 'never'],
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    });
  });
});

describe('builderEnv', () => {
  it('empty secrets build unsigned and never reach electron-builder', () => {
    const empty = Object.fromEntries([...SECRETS.mac, ...SECRETS.win].map((name) => [name, '']));
    empty.CSC_KEY_PASSWORD = '  ';
    for (const platform of ['mac', 'win']) {
      const plan = signingPlan(platform, empty);
      expect(plan).toEqual({ sign: false });
      const env = builderEnv({ ...empty, PATH: '/usr/bin' }, builderArgs(platform, plan).env);
      expect(env).toEqual({ PATH: '/usr/bin', CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
    }
  });

  it('keeps secrets that are set', () => {
    expect(builderEnv(all('mac'), {})).toEqual(all('mac'));
  });
});
