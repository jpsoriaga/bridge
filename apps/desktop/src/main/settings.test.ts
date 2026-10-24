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

describe('Full auto settings (1.3.0)', () => {
  let t: ReturnType<typeof tempProject>;
  let path: string;
  beforeEach(() => {
    t = tempProject('bridge-settings-');
    path = join(t.base, 'settings.json');
  });
  afterEach(() => t.cleanup());

  it('starts at a step limit of 25, with nothing extra approved', () => {
    const read = settingsFile(path).read();
    expect(read.stepLimit).toBe(25);
    expect(read.autoApprove).toEqual({ changes: false, gated: false, partial: false });
    expect(read.unlimitedNoteSeen).toBe(false);
  });

  it('moves the old default of 10 to 25 once, and keeps a limit the user chose', () => {
    writeFileSync(path, JSON.stringify({ stepLimit: 10 }));
    const settings = settingsFile(path);
    expect(settings.read().stepLimit).toBe(25);
    settings.update({});
    // Saved as 2: a 10 chosen from now on stays 10.
    settings.update({ stepLimit: 10 });
    expect(settings.read().stepLimit).toBe(10);
    writeFileSync(path, JSON.stringify({ stepLimit: 7 }));
    expect(settingsFile(path).read().stepLimit).toBe(7);
  });

  it('keeps Unlimited as null, and clamps anything else into 1–100', () => {
    writeFileSync(path, JSON.stringify({ stepLimit: null, stepLimitFormat: 2 }));
    expect(settingsFile(path).read().stepLimit).toBeNull();
    writeFileSync(path, JSON.stringify({ stepLimit: 500, stepLimitFormat: 2 }));
    expect(settingsFile(path).read().stepLimit).toBe(100);
    writeFileSync(path, JSON.stringify({ stepLimit: 'lots', stepLimitFormat: 2 }));
    expect(settingsFile(path).read().stepLimit).toBe(25);
  });

  it('keeps background entries only when they’re on that project’s allowlist', () => {
    writeFileSync(
      path,
      JSON.stringify({
        allowlistFormat: 2,
        allowlists: { '0123456789abcdef': ['npm run dev', 'npm test'] },
        backgroundAllowlists: {
          '0123456789abcdef': ['npm run dev', 'npm run watch'],
          ffffffffffffffff: ['npm start']
        }
      })
    );
    expect(settingsFile(path).read().backgroundAllowlists).toEqual({
      '0123456789abcdef': ['npm run dev']
    });
  });

  it('reads only true as on for each auto-approve setting', () => {
    writeFileSync(
      path,
      JSON.stringify({ autoApprove: { changes: true, gated: 'yes', partial: 1 } })
    );
    expect(settingsFile(path).read().autoApprove).toEqual({
      changes: true,
      gated: false,
      partial: false
    });
  });
});
