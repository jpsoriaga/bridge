import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@bridge/shared';
import { appDiagnostics, type AppDiagnostics } from './diagnostics';
import { Log, LOG_FILE } from './log';

// Fake credentials, assembled at runtime so the repository never holds one.
const rand = 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d';
const fakeToken = `gh${'p_'}${rand}abcd`;
const pairingKey = '9c1e'.repeat(16);
const fileContents = 'export const answer = 42; // from src/answer.ts';

const base: AppDiagnostics = {
  version: '1.2.0-beta.1',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '15.1.0',
  browser: 'Chrome 141.0.7390.54',
  status: 'connected',
  paired: true,
  port: 47821,
  mode: 'auto-apply',
  project: '/Users/al/code/app',
  updateChannel: 'beta',
  log: [],
  home: '/Users/al',
  time: new Date('2026-10-23T10:00:00.000Z')
};

describe('appDiagnostics', () => {
  it('lists versions, the system, the browser, mode and connection', () => {
    const text = appDiagnostics(base);
    for (const line of [
      'Bridge diagnostics (from the app)',
      'App:            1.2.0-beta.1',
      `Protocol:       ${PROTOCOL_VERSION}`,
      'OS:             macOS 15.1.0 (arm64)',
      'Browser:        Chrome 141.0.7390.54',
      'Mode:           auto-apply',
      'Connection:     connected',
      'Server:         127.0.0.1:47821',
      'Project:        ~/code/app',
      'Update channel: beta'
    ]) {
      expect(text).toContain(line);
    }
    expect(appDiagnostics({ ...base, packaged: false })).toContain('(development build)');
  });

  it('has no file contents, tokens, keys or home paths, from a log with a fake secret', () => {
    // A log file as it might be after a careless line, read back the way the app does.
    const dir = mkdtempSync(join(tmpdir(), 'bridge-diag-'));
    writeFileSync(
      join(dir, LOG_FILE),
      [
        '2026-10-23T09:59:00.000Z info  Bridge 1.2.0-beta.1 started',
        `2026-10-23T09:59:01.000Z warn  command output GITHUB_TOKEN=${fakeToken}`,
        `2026-10-23T09:59:02.000Z info  key ${pairingKey}`,
        '2026-10-23T09:59:03.000Z info  project opened /Users/al/code/app',
        ''
      ].join('\n')
    );
    const log = new Log({ dir, home: '/Users/al' });
    log.info(`token=${rand} again, in /Users/al/code/app`);
    const text = appDiagnostics({ ...base, log: log.recent() });
    expect(text).toContain('Bridge 1.2.0-beta.1 started');
    expect(text).toContain('project opened ~/code/app');
    expect(text).not.toContain(fakeToken);
    expect(text).not.toContain(rand);
    expect(text).not.toContain(pairingKey);
    expect(text).not.toContain('/Users/al');
    expect(text).not.toContain(fileContents);
    expect(text).toContain('[redacted]');
  });

  it('copes with nothing connected yet, on Windows', () => {
    const text = appDiagnostics({
      ...base,
      platform: 'win32',
      arch: 'x64',
      osVersion: '10.0.22631',
      browser: null,
      status: 'not-paired',
      paired: false,
      port: null,
      project: null,
      home: 'C:\\Users\\Al'
    });
    expect(text).toContain('OS:             Windows 10.0.22631 (x64)');
    expect(text).toContain('Browser:        not connected yet');
    expect(text).toContain('Server:         not running');
    expect(text).toContain('Project:        none open');
    expect(text).toContain('(none)');
  });
});
