import { describe, expect, it } from 'vitest';
import { installNote, suggestAllowlist, suggestInstall } from './suggest';

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
    ).toEqual(['pnpm install', 'pnpm test', 'pnpm lint', 'pnpm build', 'git status', 'git diff']);
  });

  it('uses packageManager over lockfiles, and npm’s own spelling', () => {
    expect(
      suggestAllowlist(
        pkg({ test: 't', typecheck: 'tsc' }, { packageManager: 'yarn@4.1.0' }),
        () => true
      )
    ).toEqual(['yarn install', 'yarn test', 'yarn typecheck', 'git status', 'git diff']);
    expect(suggestAllowlist(pkg({ test: 't', lint: 'l' }), () => false)).toEqual([
      'npm install',
      'npm test',
      'npm run lint',
      'git status',
      'git diff'
    ]);
    expect(suggestAllowlist(pkg({ test: 't' }), (f) => f === 'bun.lockb')).toEqual([
      'bun install',
      'bun run test',
      'git status',
      'git diff'
    ]);
  });

  it('suggests git alone without a usable package.json', () => {
    expect(suggestAllowlist(null, () => false)).toEqual(['git status', 'git diff']);
    expect(suggestAllowlist('not json', () => false)).toEqual(['git status', 'git diff']);
    expect(suggestAllowlist('[]', () => false)).toEqual(['git status', 'git diff']);
    expect(suggestAllowlist('{"scripts": 1}', () => false)).toEqual([
      'npm install',
      'git status',
      'git diff'
    ]);
  });
});

describe('suggestInstall', () => {
  const only = (lockfile: string) => (file: string) => file === lockfile;

  it.each([
    ['package-lock.json', 'npm install'],
    ['pnpm-lock.yaml', 'pnpm install'],
    ['yarn.lock', 'yarn install'],
    ['bun.lock', 'bun install'],
    ['bun.lockb', 'bun install']
  ])('picks the manager from %s', (lockfile, command) => {
    expect(suggestInstall(pkg({}), only(lockfile))).toBe(command);
  });

  it('falls back to npm with no lockfile, and prefers packageManager', () => {
    expect(suggestInstall(pkg({}), () => false)).toBe('npm install');
    expect(suggestInstall(pkg({}, { packageManager: 'pnpm@10.0.0' }), only('yarn.lock'))).toBe(
      'pnpm install'
    );
  });

  it('is exact, with no *, so the chat can’t add a package through it', () => {
    expect(suggestInstall(pkg({}), () => false)).not.toContain('*');
  });

  it('suggests nothing without a package.json', () => {
    expect(suggestInstall(null, () => true)).toBeNull();
    expect(suggestInstall('nope', () => true)).toBeNull();
  });
});

describe('installNote', () => {
  it('offers the command once for a confirmed list that doesn’t allow it', () => {
    expect(installNote('npm install', ['npm test'], false)).toBe('npm install');
    expect(installNote('npm install', ['npm test'], true)).toBeNull();
  });

  it('stays quiet when there’s nothing to add or nothing confirmed yet', () => {
    expect(installNote('npm install', ['npm install'], false)).toBeNull();
    expect(installNote('npm install', ['npm install *'], false)).toBeNull();
    expect(installNote('npm install', null, false)).toBeNull();
    expect(installNote(null, ['npm test'], false)).toBeNull();
  });
});
