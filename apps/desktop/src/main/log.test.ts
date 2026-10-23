import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Log, LOG_FILE } from './log';
import { tempProject } from './project/test-utils';

// A fake credential, assembled at runtime so the repository never holds one.
const rand = 'Q7f2Kp9xZ3mW8vR1tY6uN4bL0cJ5hG2d';

describe('Log', () => {
  let t: ReturnType<typeof tempProject>;
  let dir: string;
  const at = () => new Date('2026-10-23T10:00:00.000Z');
  beforeEach(() => {
    t = tempProject('bridge-log-');
    dir = join(t.base, 'logs');
  });
  afterEach(() => t.cleanup());

  const file = (suffix = '') => join(dir, `${LOG_FILE}${suffix}`);

  it('writes timestamped lines to logs/bridge.log, privately', () => {
    const log = new Log({ dir, now: at });
    log.info('started');
    log.warn('refused write: traversal');
    expect(readFileSync(file(), 'utf8')).toBe(
      '2026-10-23T10:00:00.000Z info  started\n' +
        '2026-10-23T10:00:00.000Z warn  refused write: traversal\n'
    );
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(file()).mode & 0o777).toBe(0o600);
    }
  });

  it('redacts secrets and shortens the home folder in every line', () => {
    const log = new Log({ dir, home: '/Users/al', now: at });
    log.error(`command failed in /Users/al/code/app: API_KEY=${rand}\nsecond line`);
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain(rand);
    expect(text).not.toContain('/Users/al');
    expect(text).toContain('~/code/app');
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(log.recent()).toEqual([text.trimEnd()]);
  });

  it('rotates at the size limit and keeps 3 files', () => {
    const log = new Log({ dir, maxBytes: 200, now: at });
    // Each line is 92 bytes (31 prefix, 60 text, newline): two fit in a file.
    for (let i = 0; i < 9; i++) log.info(`${String(i)}${'x'.repeat(59)}`);
    expect(existsSync(file())).toBe(true);
    expect(existsSync(file('.1'))).toBe(true);
    expect(existsSync(file('.2'))).toBe(true);
    expect(existsSync(file('.3'))).toBe(false);
    const lines = (suffix: string) =>
      readFileSync(file(suffix), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => line.slice(31, 32));
    // Newest in bridge.log; the oldest lines (0–3) are gone.
    expect(lines('')).toEqual(['8']);
    expect(lines('.1')).toEqual(['6', '7']);
    expect(lines('.2')).toEqual(['4', '5']);
    for (const suffix of ['', '.1', '.2']) expect(statSync(file(suffix)).size).toBeLessThan(200);
  });

  it('remembers the last lines across launches, for diagnostics', () => {
    const first = new Log({ dir, now: at });
    for (let i = 0; i < 60; i++) first.info(`line ${i}`);
    const second = new Log({ dir, now: at });
    expect(second.recent()).toHaveLength(50);
    expect(second.recent().at(-1)).toContain('line 59');
    expect(second.recent(2).map((line) => line.slice(31))).toEqual(['line 58', 'line 59']);
  });

  it('keeps going when it can’t write', () => {
    // The log folder's place is taken by a file: lines are lost, not thrown.
    writeFileSync(dir, 'not a folder');
    const log = new Log({ dir, now: at });
    expect(() => log.info('hello')).not.toThrow();
    expect(log.recent()).toHaveLength(1);
  });
});
