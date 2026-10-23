import { mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Denylist, Sandbox } from './sandbox';
import { canSymlink, tempProject } from './test-utils';

// Thousands of runs per property take about a second here, but can pass 5s on a busy CI
// runner under coverage.
vi.setConfig({ testTimeout: 30_000 });

// Any path the chat could send either resolves inside the project, off the denylist, or is
// refused. Random paths, thousands of times, over a project with links pointing out.

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
const denylist = new Denylist();

beforeAll(async () => {
  project = tempProject('bridge-sandbox-prop-');
  project.write('src/a.ts', 'a');
  project.write('.git/config', 'x');
  project.write('.env', 'X=1');
  project.write('outside/secret.txt', 'secret', project.base);
  if (canSymlink()) {
    symlinkSync(join(project.base, 'outside'), join(project.root, 'link-out'), 'junction');
    symlinkSync(join(project.root, 'src'), join(project.root, 'link-in'), 'junction');
    symlinkSync(join(project.root, '.git'), join(project.root, 'git-link'), 'junction');
    symlinkSync(join(project.root, 'missing'), join(project.root, 'dangling'), 'junction');
  }
  mkdirSync(join(project.root, 'node_modules/pkg'), { recursive: true });
  sandbox = await Sandbox.create(project.root);
});
afterAll(() => project.cleanup());

const segment = fc.oneof(
  fc.constantFrom(
    'src',
    'a.ts',
    'new.ts',
    '..',
    '.',
    '',
    '.git',
    '.GIT',
    '.git.',
    '.env',
    '.env.local',
    'link-out',
    'link-in',
    'git-link',
    'dangling',
    'node_modules',
    'pkg',
    'secret.txt',
    'id_rsa',
    'x.pem',
    'C:',
    'c:\\',
    '\\',
    '~',
    '%2e%2e',
    '\u0000',
    'a\u202eb',
    'secret.\u212Aey',
    'con',
    'a ',
    ' '
  ),
  fc.string({ maxLength: 8 })
);
const path = fc
  .tuple(fc.array(segment, { minLength: 1, maxLength: 6 }), fc.constantFrom('', '/', '//', './'))
  .map(([parts, lead]) => lead + parts.join('/'));

const inside = (real: string) => real === sandbox.root || real.startsWith(sandbox.root + sep);

describe('Sandbox.resolve (property)', () => {
  it('resolves inside the real root and off the denylist, or refuses', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(path, fc.string()), async (input) => {
        const resolved = await sandbox.resolve(input);
        if (!resolved.ok) return;
        expect(inside(resolved.abs), `${input} → ${resolved.abs}`).toBe(true);
        expect(resolved.abs).not.toBe(sandbox.root);
        expect(denylist.matches(resolved.rel), resolved.rel).toBe(false);
        // What exists on the way there is really inside: realpath of the nearest existing
        // ancestor.
        let probe = resolved.kind === 'missing' ? dirname(resolved.abs) : resolved.abs;
        for (;;) {
          try {
            probe = realpathSync(probe);
            break;
          } catch {
            probe = dirname(probe);
          }
        }
        expect(inside(probe), `${input}: ${probe}`).toBe(true);
        if (probe !== sandbox.root) expect(denylist.matches(sandbox.relativeOf(probe))).toBe(false);
        // Nothing absolute, nothing that climbs.
        expect(resolved.rel.split('/')).not.toContain('..');
        expect(resolved.rel.startsWith('/')).toBe(false);
      }),
      { numRuns: 3000 }
    );
  });
});
