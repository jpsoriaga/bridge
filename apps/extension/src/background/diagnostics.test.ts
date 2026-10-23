import { describe, expect, it } from 'vitest';
import { browserFromUserAgent, PROTOCOL_VERSION } from '@bridge/shared';
import { browserVersion, extensionDiagnostics, type ExtensionDiagnostics } from './diagnostics';
import { WorkerLog } from './log';

// A fake credential, assembled at runtime so the repository never holds one.
const rand = 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d';
const fakeKey = `sk-${'proj-'}${rand}`;
const pairingKey = '5e7d'.repeat(16);

const base: ExtensionDiagnostics = {
  version: '1.2.0-beta.1',
  appVersion: '1.2.0-beta.1',
  browser: 'Google Chrome 141.0.7390.54',
  os: 'mac',
  arch: 'arm64',
  status: 'connected',
  mode: 'manual',
  project: '~/code/app',
  chatTab: 'session active',
  log: [],
  time: new Date('2026-10-23T10:00:00.000Z')
};

describe('extensionDiagnostics', () => {
  it('lists both versions, the protocol, system, browser, mode and connection', () => {
    const text = extensionDiagnostics(base);
    for (const line of [
      'Bridge diagnostics (from the extension)',
      'Extension:  1.2.0-beta.1',
      'App:        1.2.0-beta.1',
      `Protocol:   ${PROTOCOL_VERSION}`,
      'OS:         macOS (arm64)',
      'Browser:    Google Chrome 141.0.7390.54',
      'Mode:       manual',
      'Connection: connected',
      'Project:    ~/code/app',
      'Chat tab:   session active'
    ]) {
      expect(text).toContain(line);
    }
    const offline = extensionDiagnostics({
      ...base,
      appVersion: null,
      status: 'app-not-running',
      mode: null,
      project: null
    });
    expect(offline).toContain('App:        not reached');
    expect(offline).toContain('Mode:       unknown (not connected)');
  });

  it('has no tokens or keys, even if a log line had one', () => {
    const log = new WorkerLog(() => new Date('2026-10-23T09:00:00.000Z'));
    log.info('connection: connected');
    log.warn(`pair failed: ${fakeKey}`);
    log.info(`key ${pairingKey}`);
    const text = extensionDiagnostics({ ...base, log: log.recent(50) });
    expect(text).toContain('connection: connected');
    expect(text).not.toContain(rand);
    expect(text).not.toContain(pairingKey);
  });
});

describe('WorkerLog', () => {
  it('keeps the newest lines in memory, capped', () => {
    const log = new WorkerLog(() => new Date('2026-10-23T09:00:00.000Z'));
    for (let i = 0; i < 250; i++) log.info(`event ${i}`);
    expect(log.recent(500)).toHaveLength(200);
    expect(log.recent(1)).toEqual(['2026-10-23T09:00:00.000Z info  event 249']);
  });
});

describe('browserVersion', () => {
  const ua = 'Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36';

  it('prefers the full version and brand from client hints', async () => {
    const nav = {
      userAgent: ua,
      userAgentData: {
        getHighEntropyValues: async () => ({
          fullVersionList: [
            { brand: 'Not)A;Brand', version: '8.0.0.0' },
            { brand: 'Chromium', version: '141.0.7390.54' },
            { brand: 'Brave', version: '141.1.83.109' }
          ]
        })
      }
    };
    expect(await browserVersion(nav, browserFromUserAgent)).toBe('Brave 141.1.83.109');
  });

  it('falls back to the User-Agent', async () => {
    expect(await browserVersion({ userAgent: ua }, browserFromUserAgent)).toBe('Chrome 141.0.0.0');
    const failing = {
      userAgent: ua,
      userAgentData: { getHighEntropyValues: () => Promise.reject(new Error('no')) }
    };
    expect(await browserVersion(failing, browserFromUserAgent)).toBe('Chrome 141.0.0.0');
  });
});
