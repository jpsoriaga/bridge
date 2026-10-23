import { describe, expect, it } from 'vitest';
import {
  browserFromUserAgent,
  buildDiagnostics,
  DIAGNOSTICS_LOG_LINES,
  logLine,
  MAX_LOG_LINE_CHARS,
  redactDiagnostics,
  shortenHome
} from './diagnostics';

// Fake credentials, assembled at runtime so the repository never holds a string a secret
// scanner would flag. None of them is real.
const rand = 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d';
const fakeKey = `sk-${'proj-'}${rand}`;
const fakeGithub = `gh${'p_'}${rand}abcd`;
const pairingKey = 'a3f9'.repeat(16);

describe('shortenHome', () => {
  it('turns the home folder into ~, on POSIX and Windows paths', () => {
    expect(shortenHome('opened /Users/al/code/app', '/Users/al')).toBe('opened ~/code/app');
    expect(shortenHome('at /Users/al', '/Users/al/')).toBe('at ~');
    expect(shortenHome('C:\\Users\\Al\\code\\app', 'C:\\Users\\Al')).toBe('~\\code\\app');
    expect(shortenHome('c:/users/al/x', 'C:\\Users\\Al')).toBe('~/x');
  });

  it('leaves other folders that only start the same', () => {
    expect(shortenHome('/Users/alice/x', '/Users/al')).toBe('/Users/alice/x');
    expect(shortenHome('/x', '/')).toBe('/x');
    expect(shortenHome('/x', null)).toBe('/x');
  });
});

describe('redactDiagnostics', () => {
  it('redacts secrets, keys and long hashes but keeps paths readable', () => {
    const out = redactDiagnostics(
      [
        `token ${fakeKey}`,
        `github ${fakeGithub}`,
        `key ${pairingKey}`,
        'project /Users/al/code/some-really-long-folder-name/inside/another',
        'fingerprint a1b2 c3d4'
      ].join('\n'),
      '/Users/al'
    );
    expect(out).not.toContain(fakeKey);
    expect(out).not.toContain(fakeGithub);
    expect(out).not.toContain(pairingKey);
    expect(out).toContain('~/code/some-really-long-folder-name/inside/another');
    expect(out).toContain('fingerprint a1b2 c3d4');
  });
});

describe('logLine', () => {
  it('keeps one capped line', () => {
    expect(logLine('a\r\nb\u0007c')).toBe('a ⏎ bc');
    const long = logLine('x '.repeat(MAX_LOG_LINE_CHARS));
    expect(long.length).toBe(MAX_LOG_LINE_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('buildDiagnostics', () => {
  const fields = [
    ['App', '1.2.0-beta.1'],
    ['Extension', null],
    ['Protocol', 7],
    ['OS', 'macOS 15.1 (arm64)']
  ] as const;

  it('lists the fields, then the last 50 log lines', () => {
    const log = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const text = buildDiagnostics({ source: 'app', fields, log, time: '2026-10-23T10:00:00Z' });
    const lines = text.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      'Bridge diagnostics (from the app)',
      'Copied: 2026-10-23T10:00:00Z',
      'App:       1.2.0-beta.1',
      'Extension: unknown',
      'Protocol:  7',
      'OS:        macOS 15.1 (arm64)'
    ]);
    expect(text).toContain(`Last ${DIAGNOSTICS_LOG_LINES} log lines:`);
    expect(text).not.toContain('line 9\n');
    expect(text).toContain('line 10\n');
    expect(text).toContain('line 59\n');
    expect(lines.filter((line) => line.startsWith('line ')).length).toBe(DIAGNOSTICS_LOG_LINES);
  });

  it('never carries a secret, a key or the home folder, even from a bad log line', () => {
    // A fixture log as a careless line could have written it.
    const log = [
      '2026-10-23T10:00:00.000Z info  project opened /Users/al/code/app',
      `2026-10-23T10:00:01.000Z warn  command printed OPENAI_API_KEY=${rand}`,
      `2026-10-23T10:00:02.000Z error Authorization: Bearer ${rand}`,
      `2026-10-23T10:00:03.000Z info  pairing key ${pairingKey}`,
      `2026-10-23T10:00:04.000Z info  ${fakeKey}`
    ];
    const text = buildDiagnostics({
      source: 'extension',
      fields: [['Project', '/Users/al/code/app']],
      log,
      home: '/Users/al',
      time: 'now'
    });
    expect(text).not.toContain(rand);
    expect(text).not.toContain(pairingKey);
    expect(text).not.toContain('/Users/al');
    expect(text).toContain('Project: ~/code/app');
    expect(text).toContain('project opened ~/code/app');
    expect(text.match(/\[redacted\]/g)?.length).toBe(4);
  });

  it('says when there are no log lines', () => {
    const text = buildDiagnostics({ source: 'app', fields: [['App', '1']], log: [], time: 't' });
    expect(text).toContain('(none)');
  });
});

describe('browserFromUserAgent', () => {
  it('reads Chrome, Edge and Opera versions', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36';
    expect(browserFromUserAgent(chrome)).toBe('Chrome 141.0.7390.54');
    expect(browserFromUserAgent(`${chrome} Edg/141.0.3537.57`)).toBe('Edge 141.0.3537.57');
    expect(browserFromUserAgent(`${chrome} OPR/123.0.0.0`)).toBe('Opera 123.0.0.0');
    expect(browserFromUserAgent('curl/8.0')).toBeNull();
    expect(browserFromUserAgent(undefined)).toBeNull();
  });
});
