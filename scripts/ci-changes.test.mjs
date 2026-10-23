import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { changedFiles, classify } from './ci-changes.mjs';

describe('classify', () => {
  it('skips the app jobs for a change only under apps/site', () => {
    expect(classify(['apps/site/src/App.tsx', 'apps/site/README.md'])).toEqual({
      app: false,
      site: true
    });
  });

  it('skips the site job for an app-only change', () => {
    expect(classify(['apps/desktop/src/main/index.ts', 'packages/shared/src/parser.ts'])).toEqual({
      app: true,
      site: false
    });
  });

  it('runs both when shared inputs of the site change', () => {
    for (const file of [
      'packages/shared/assets/logo.svg',
      'packages/shared/src/tokens.css',
      'pnpm-lock.yaml',
      '.github/workflows/ci.yml'
    ]) {
      expect(classify([file]), file).toEqual({ app: true, site: true });
    }
  });

  it('runs everything when the changes are unknown', () => {
    expect(classify(null)).toEqual({ app: true, site: true });
  });
});

describe('changedFiles', () => {
  it('needs two real commits', () => {
    expect(changedFiles(undefined, 'abc')).toBeNull();
    expect(changedFiles('0000000000000000000000000000000000000000', 'abc')).toBeNull();
    expect(changedFiles('not-a-commit', 'also-not')).toBeNull();
  });

  it('lists the files between two commits', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(changedFiles(head, head)).toEqual([]);
  });
});
