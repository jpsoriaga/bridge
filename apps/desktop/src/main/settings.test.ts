import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempProject } from './project/test-utils';
import { settingsFile } from './settings';

describe('allowlist migration to exact matching', () => {
  let t: ReturnType<typeof tempProject>;
  let path: string;
  beforeEach(() => {
    t = tempProject('bridge-settings-');
    path = join(t.base, 'settings.json');
  });
  afterEach(() => t.cleanup());

  it('adds * to every saved entry once, since they allowed extra arguments, and notes it', () => {
    writeFileSync(
      path,
      JSON.stringify({
        allowlists: { '0123456789abcdef': ['pnpm test', 'git status', 'pnpm lint *'] }
      })
    );
    const settings = settingsFile(path);
    const read = settings.read();
    expect(read.allowlists['0123456789abcdef']).toEqual([
      'pnpm test *',
      'git status *',
      'pnpm lint *'
    ]);
    expect(read.allowlistNote).toBe(true);

    // Saved once: reading again changes nothing more.
    settings.update({});
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { allowlistFormat: number };
    expect(saved.allowlistFormat).toBe(2);
    expect(settings.read().allowlists['0123456789abcdef']).toEqual([
      'pnpm test *',
      'git status *',
      'pnpm lint *'
    ]);
    expect(settings.read().allowlistNote).toBe(true);

    // Dismissed: gone for good. New entries stay exact.
    settings.update({ allowlistNote: false, allowlists: { '0123456789abcdef': ['pnpm test'] } });
    expect(settings.read().allowlistNote).toBe(false);
    expect(settings.read().allowlists['0123456789abcdef']).toEqual(['pnpm test']);
  });

  it('has nothing to note for a fresh install or an empty list', () => {
    expect(settingsFile(path).read().allowlistNote).toBe(false);
    writeFileSync(path, JSON.stringify({ allowlists: { '0123456789abcdef': [] } }));
    expect(settingsFile(path).read().allowlistNote).toBe(false);
  });
});

describe('update channel', () => {
  let t: ReturnType<typeof tempProject>;
  let path: string;
  beforeEach(() => {
    t = tempProject('bridge-settings-');
    path = join(t.base, 'settings.json');
  });
  afterEach(() => t.cleanup());

  it('is unset until the user picks one, and only stable or beta', () => {
    const settings = settingsFile(path);
    expect(settings.read().updateChannel).toBeUndefined();
    settings.update({ updateChannel: 'beta' });
    expect(settings.read().updateChannel).toBe('beta');
    writeFileSync(path, JSON.stringify({ updateChannel: 'nightly' }));
    expect(settings.read().updateChannel).toBeUndefined();
  });
});
