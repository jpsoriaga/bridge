import { describe, expect, it } from 'vitest';
import { suggestAllowlist } from './suggest';

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', scripts, ...extra });

describe('suggestAllowlist', () => {
  it('offers the check scripts with the project’s package manager, plus read-only git', () => {
    const has = (file: string) => file === 'pnpm-lock.yaml';
    expect(
      suggestAllowlist(
        pkg({ test: 'vitest', lint: 'eslint .', dev: 'vite', build: 'vite build', deploy: 'x' }),
        has
      )
    ).toEqual(['pnpm test', 'pnpm lint', 'pnpm build', 'git status', 'git diff']);
  });

  it('uses packageManager over lockfiles, and npm’s own spelling', () => {
    expect(
      suggestAllowlist(
        pkg({ test: 't', typecheck: 'tsc' }, { packageManager: 'yarn@4.1.0' }),
        () => true
      )
    ).toEqual(['yarn test', 'yarn typecheck', 'git status', 'git diff']);
    expect(suggestAllowlist(pkg({ test: 't', lint: 'l' }), () => false)).toEqual([
      'npm test',
      'npm run lint',
      'git status',
      'git diff'
    ]);
    expect(suggestAllowlist(pkg({ test: 't' }), (f) => f === 'bun.lockb')).toEqual([
      'bun run test',
      'git status',
      'git diff'
    ]);
  });

  it('suggests git alone without a usable package.json', () => {
    expect(suggestAllowlist(null, () => false)).toEqual(['git status', 'git diff']);
    expect(suggestAllowlist('not json', () => false)).toEqual(['git status', 'git diff']);
    expect(suggestAllowlist('{"scripts": 1}', () => false)).toEqual(['git status', 'git diff']);
  });
});
