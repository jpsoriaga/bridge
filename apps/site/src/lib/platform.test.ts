import { describe, expect, it } from 'vitest';
import { applyClientHints, detectFromUserAgent, detectPlatform, primaryPlatform } from './platform';

const UA = {
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  winChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  winEdgeArm:
    'Mozilla/5.0 (Windows NT 10.0; ARM64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  linuxArm: 'Mozilla/5.0 (X11; Linux aarch64; rv:144.0) Gecko/20100101 Firefox/144.0',
  android:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
};

describe('detectFromUserAgent', () => {
  it.each([
    ['macChrome', 'mac', 'unknown'],
    ['macSafari', 'mac', 'unknown'],
    ['winChrome', 'windows', 'x64'],
    ['winEdgeArm', 'windows', 'arm64'],
    ['linuxFirefox', 'linux', 'x64'],
    ['linuxArm', 'linux', 'arm64'],
    ['android', 'other', 'unknown'],
    ['iphone', 'other', 'unknown'],
    ['chromebook', 'other', 'unknown']
  ] as const)('%s → %s %s', (key, os, arch) => {
    expect(detectFromUserAgent(UA[key])).toEqual({ os, arch });
  });

  it('treats an unknown string as other', () => {
    expect(detectFromUserAgent('')).toEqual({ os: 'other', arch: 'unknown' });
  });
});

describe('applyClientHints', () => {
  const mac = detectFromUserAgent(UA.macChrome);

  it('finds Apple silicon from architecture "arm"', () => {
    expect(
      applyClientHints(mac, { platform: 'macOS', architecture: 'arm', bitness: '64' })
    ).toEqual({ os: 'mac', arch: 'arm64' });
  });

  it('finds an Intel Mac from architecture "x86"', () => {
    expect(
      applyClientHints(mac, { platform: 'macOS', architecture: 'x86', bitness: '64' })
    ).toEqual({ os: 'mac', arch: 'x64' });
  });

  it('keeps the User-Agent guess when the hints are empty or 32-bit', () => {
    expect(applyClientHints(mac, {})).toEqual(mac);
    const win = detectFromUserAgent(UA.winChrome);
    expect(
      applyClientHints(win, { platform: 'Windows', architecture: 'x86', bitness: '32' })
    ).toEqual(win);
  });

  it('lets the platform hint win', () => {
    expect(applyClientHints(mac, { platform: 'Android', architecture: 'arm' })).toEqual({
      os: 'other',
      arch: 'unknown'
    });
    expect(applyClientHints(mac, { platform: 'Linux', architecture: 'x86' })).toEqual({
      os: 'linux',
      arch: 'x64'
    });
  });
});

describe('primaryPlatform', () => {
  it('offers Apple silicon first when the chip is unknown', () => {
    expect(primaryPlatform({ os: 'mac', arch: 'unknown' })).toBe('mac-arm64');
    expect(primaryPlatform({ os: 'mac', arch: 'arm64' })).toBe('mac-arm64');
    expect(primaryPlatform({ os: 'mac', arch: 'x64' })).toBe('mac-x64');
  });

  it('offers Windows x64 on Windows on Arm too, and nothing for Linux on Arm or phones', () => {
    expect(primaryPlatform({ os: 'windows', arch: 'arm64' })).toBe('windows');
    expect(primaryPlatform({ os: 'linux', arch: 'x64' })).toBe('linux');
    expect(primaryPlatform({ os: 'linux', arch: 'arm64' })).toBeNull();
    expect(primaryPlatform({ os: 'other', arch: 'unknown' })).toBeNull();
  });
});

describe('detectPlatform', () => {
  it('asks Chromium for the architecture', async () => {
    const nav = {
      userAgent: UA.macChrome,
      userAgentData: {
        getHighEntropyValues: () =>
          Promise.resolve({ platform: 'macOS', architecture: 'arm', bitness: '64' })
      }
    };
    expect(await detectPlatform(nav)).toEqual({ os: 'mac', arch: 'arm64' });
  });

  it('falls back to the User-Agent when the hints fail or are missing', async () => {
    const failing = {
      userAgent: UA.winChrome,
      userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('blocked')) }
    };
    expect(await detectPlatform(failing)).toEqual({ os: 'windows', arch: 'x64' });
    expect(await detectPlatform({ userAgent: UA.macSafari })).toEqual({
      os: 'mac',
      arch: 'unknown'
    });
  });

  it('recognises an iPad that asks for the desktop site', async () => {
    expect(await detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 })).toEqual({
      os: 'other',
      arch: 'unknown'
    });
  });
});
