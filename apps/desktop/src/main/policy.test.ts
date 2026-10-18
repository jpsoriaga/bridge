import { describe, expect, it, vi } from 'vitest';
import type { FileRequest, Mode } from '@bridge/shared';
import {
  changeRefusal,
  GatedFiles,
  guardedFiles,
  ModeState,
  writeRefusal,
  type ModeStore
} from './policy';

function memoryStore(mode: 'manual' | 'auto-apply' = 'manual') {
  const store: ModeStore & { saved: 'manual' | 'auto-apply' } = {
    saved: mode,
    read: () => ({ mode: store.saved }),
    update: ({ mode }) => {
      store.saved = mode;
    }
  };
  return store;
}

describe('GatedFiles', () => {
  const gated = new GatedFiles();

  it.each([
    'package.json',
    'packages/shared/package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lockb',
    '.npmrc',
    'apps/web/.npmrc',
    '.yarnrc',
    '.yarnrc.yml',
    'pnpm-workspace.yaml',
    '.github/workflows/ci.yml',
    '.github/workflows/nested/release.yaml',
    '.husky/pre-commit',
    '.githooks/pre-push',
    'lefthook.yml',
    '.pre-commit-config.yaml',
    'Dockerfile',
    'docker/Dockerfile',
    'dockerfile',
    'Makefile',
    'PACKAGE.JSON'
  ])('gates %s', (path) => {
    expect(gated.matches(path)).toBe(true);
  });

  it.each([
    'src/package.ts',
    'package.json.bak',
    'src/index.ts',
    '.github/CODEOWNERS',
    'docs/Makefile.md',
    'README.md'
  ])('leaves %s alone', (path) => {
    expect(gated.matches(path)).toBe(false);
  });

  it('adds the user’s patterns to the defaults', () => {
    const custom = new GatedFiles(['vitest.config.*', 'scripts/']);
    expect(custom.matches('vitest.config.ts')).toBe(true);
    expect(custom.matches('scripts/build.sh')).toBe(true);
    expect(custom.matches('package.json')).toBe(true);
  });

  it('never throws on odd paths', () => {
    for (const path of ['', '/abs', '../up', 'a//b', 'a/../b']) {
      expect(gated.matches(path)).toBe(false);
    }
  });
});

describe('writeRefusal', () => {
  const gated = new GatedFiles();
  const write = (path: string, trigger: 'click' | 'auto') => ({ path, trigger });

  it('always lets a click through to the sandbox', () => {
    for (const mode of ['manual', 'auto-apply', 'full-auto'] as Mode[]) {
      expect(writeRefusal(write('src/a.ts', 'click'), mode, gated)).toBeNull();
      expect(writeRefusal(write('package.json', 'click'), mode, gated)).toBeNull();
    }
  });

  it('refuses an automatic write in Manual mode', () => {
    expect(writeRefusal(write('src/a.ts', 'auto'), 'manual', gated)).toBe('mode');
  });

  it('allows an automatic write in Auto-apply and Full auto, except to a gated file', () => {
    for (const mode of ['auto-apply', 'full-auto'] as Mode[]) {
      expect(writeRefusal(write('src/a.ts', 'auto'), mode, gated)).toBeNull();
      expect(writeRefusal(write('package.json', 'auto'), mode, gated)).toBe('gated');
      expect(writeRefusal(write('.github/workflows/ci.yml', 'auto'), mode, gated)).toBe('gated');
    }
  });
});

describe('changeRefusal', () => {
  const gated = new GatedFiles();
  it('allows a click on any path, gated ones too', () => {
    expect(changeRefusal({ path: 'package.json', trigger: 'click' }, gated)).toBeNull();
    expect(changeRefusal({ from: 'a.ts', to: 'Makefile', trigger: 'click' }, gated)).toBeNull();
  });

  it('refuses every automatic delete and rename, in every mode', () => {
    expect(changeRefusal({ path: 'src/a.ts', trigger: 'auto' }, gated)).toBe('mode');
    expect(changeRefusal({ from: 'a.ts', to: 'b.ts', trigger: 'auto' }, gated)).toBe('mode');
    expect(changeRefusal({ path: 'package.json', trigger: 'auto' }, gated)).toBe('gated');
    expect(changeRefusal({ from: 'x.ts', to: '.husky/pre-push', trigger: 'auto' }, gated)).toBe(
      'gated'
    );
  });

  it('is enforced by guardedFiles before the sandbox, even in Full auto', async () => {
    const handled: FileRequest[] = [];
    const refused: string[] = [];
    const files = guardedFiles(
      {
        handle: async (request) => {
          handled.push(request);
          return { ok: true, result: {} };
        },
        refuse: (_op, _path, code) => {
          refused.push(code);
          return { ok: false, error: { code, message: code } };
        }
      },
      () => 'full-auto',
      () => gated
    );
    const base = { v: 4 as const, id: '1' };
    await files({
      ...base,
      type: 'delete',
      payload: { path: 'a.ts', baseHash: '0'.repeat(64), trigger: 'auto' }
    });
    await files({
      ...base,
      type: 'rename',
      payload: { from: 'a.ts', to: 'b.ts', baseHash: '0'.repeat(64), trigger: 'auto' }
    });
    await files({
      ...base,
      type: 'delete',
      payload: { path: 'a.ts', baseHash: '0'.repeat(64), trigger: 'click' }
    });
    expect(refused).toEqual(['mode', 'mode']);
    expect(handled.map((r) => r.type)).toEqual(['delete']);
  });
});

describe('guardedFiles', () => {
  it('answers a refused write itself and passes everything else on', async () => {
    const handle = vi.fn(async () => ({ ok: true as const, result: {} }));
    const refuse = vi.fn((_op: string, _path: unknown, code: 'mode' | 'gated') => ({
      ok: false as const,
      error: { code, message: code }
    }));
    let mode: Mode = 'manual';
    const files = guardedFiles(
      { handle, refuse: refuse as never },
      () => mode,
      () => new GatedFiles()
    );
    const write = (path: string, trigger: 'click' | 'auto'): FileRequest => ({
      v: 4,
      id: '1',
      type: 'write',
      payload: { path, content: 'x', trigger }
    });

    expect(await files(write('a.ts', 'auto'))).toMatchObject({ error: { code: 'mode' } });
    mode = 'auto-apply';
    expect(await files(write('package.json', 'auto'))).toMatchObject({ error: { code: 'gated' } });
    expect(handle).not.toHaveBeenCalled();
    expect(refuse).toHaveBeenCalledWith('write', 'package.json', 'gated');

    expect(await files(write('a.ts', 'auto'))).toEqual({ ok: true, result: {} });
    expect(await files(write('package.json', 'click'))).toEqual({ ok: true, result: {} });
    expect(await files({ v: 4, id: '2', type: 'read', payload: { path: 'package.json' } })).toEqual(
      { ok: true, result: {} }
    );
    expect(handle).toHaveBeenCalledTimes(3);
  });
});

describe('ModeState', () => {
  it('starts in the saved mode and saves Manual and Auto-apply', () => {
    const store = memoryStore('auto-apply');
    const modes = new ModeState(store);
    expect(modes.mode).toBe('auto-apply');
    modes.set('manual');
    expect(store.saved).toBe('manual');
    modes.set('auto-apply');
    expect(store.saved).toBe('auto-apply');
  });

  it('never saves Full auto, so a restart comes back in Manual', () => {
    const store = memoryStore('auto-apply');
    const modes = new ModeState(store);
    modes.set('full-auto');
    expect(modes.mode).toBe('full-auto');
    // "Restart": a new ModeState over the same settings.
    expect(new ModeState(store).mode).toBe('manual');
  });

  it('drops Full auto to Manual (End session, unpairing), and leaves the others alone', () => {
    const onChange = vi.fn();
    const modes = new ModeState(memoryStore(), onChange);
    modes.set('full-auto');
    expect(modes.dropFullAuto()).toBe(true);
    expect(modes.mode).toBe('manual');
    expect(onChange).toHaveBeenLastCalledWith('manual', 'full-auto');

    modes.set('auto-apply');
    expect(modes.dropFullAuto()).toBe(false);
    expect(modes.mode).toBe('auto-apply');
  });

  it('drops Full auto when the project switches, not when it stays', () => {
    const modes = new ModeState(memoryStore());
    modes.noteProject('/work/a');
    modes.set('full-auto');
    expect(modes.noteProject('/work/a')).toBe(false);
    expect(modes.mode).toBe('full-auto');
    expect(modes.noteProject('/work/b')).toBe(true);
    expect(modes.mode).toBe('manual');

    modes.set('full-auto');
    expect(modes.noteProject(null)).toBe(true);
    expect(modes.mode).toBe('manual');
  });

  it('keeps Auto-apply across a project switch', () => {
    const modes = new ModeState(memoryStore());
    modes.noteProject('/work/a');
    modes.set('auto-apply');
    expect(modes.noteProject('/work/b')).toBe(false);
    expect(modes.mode).toBe('auto-apply');
  });
});
