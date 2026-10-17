// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedEdit, ReadResult, WriteResult } from '@bridge/shared';
import type { RequestOutcome, WorkerRequest } from '../../messages';
import { ApplyAllBar, applyAllTargets } from './cards/apply-all';
import { DiffCard, type Ask } from './cards/diff-card';
import { insertIntoComposer } from './composer';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const edit = (path: string, content: string, suspectedPartial = false): ParsedEdit => ({
  path,
  content,
  suspectedPartial,
  fence: 0
});

/** A fake worker: a map of files on "disk", and every request it saw. */
function fakeWorker(files: Record<string, { content: string; hash: string }>) {
  const calls: WorkerRequest[] = [];
  let ops = 0;
  const writeOverride = new Map<string, RequestOutcome<WriteResult>>();
  const ask = vi.fn(async (request: WorkerRequest) => {
    calls.push(request);
    switch (request.type) {
      case 'chat-read': {
        const file = files[request.path];
        if (request.path.startsWith('.env')) {
          return { ok: false, error: { code: 'denied', message: 'protected' } };
        }
        return file
          ? ({ ok: true, result: { ...file, eol: 'lf' } } satisfies RequestOutcome<ReadResult>)
          : { ok: false, error: { code: 'not-found', message: 'missing' } };
      }
      case 'chat-write': {
        const forced = writeOverride.get(request.path);
        if (forced) return forced;
        const file = files[request.path];
        if (file && file.hash !== request.baseHash) {
          return { ok: false, error: { code: 'conflict', message: 'changed' } };
        }
        ops += 1;
        files[request.path] = { content: request.content, hash: HASH_B };
        return {
          ok: true,
          result: { opId: `op-${ops}`, kind: file ? 'modify' : 'create', hash: HASH_B }
        };
      }
      case 'chat-undo':
        return { ok: true, result: { opId: request.opId, path: 'x' } };
      default:
        return true;
    }
  });
  return { ask: ask as unknown as Ask, calls, files, writeOverride };
}

async function card(worker: ReturnType<typeof fakeWorker>, e: ParsedEdit, onChange = () => {}) {
  const c = new DiffCard('conv-1234:m:0:0000000000000000', e, worker.ask, onChange);
  await c.init(undefined);
  return c;
}

describe('DiffCard', () => {
  it('reads the file, diffs it and applies with the hash it read', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', 'new\n'));
    expect(c.badges).toEqual(['modified']);
    expect(c.applicable).toBe(true);

    expect(await c.apply()).toBe(true);
    expect(c.state).toBe('applied');
    expect(worker.calls).toContainEqual({
      type: 'chat-write',
      path: 'a.ts',
      content: 'new\n',
      baseHash: HASH_A
    });
    // Saved as pending when it appeared, then as applied with the op id.
    const saved = worker.calls.filter((c) => c.type === 'card-set');
    expect(saved.map((s) => s.type === 'card-set' && s.record.state)).toEqual([
      'pending',
      'applied'
    ]);
    expect(saved[1]?.type === 'card-set' && saved[1].record.opId).toBe('op-1');
  });

  it('creates a missing file without a base hash', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('new.ts', 'x\n'));
    expect(c.badges).toEqual(['new']);
    await c.apply();
    expect(worker.calls).toContainEqual({ type: 'chat-write', path: 'new.ts', content: 'x\n' });
  });

  it('re-reads and shows the new diff on conflict', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', 'new\n'));
    // Edited on disk after the card read it.
    worker.files['a.ts'] = { content: 'edited\n', hash: 'c'.repeat(64) };
    expect(await c.apply()).toBe(false);
    expect(c.state).toBe('pending');
    expect(c.badges).toEqual(['conflict']);
    expect(worker.calls.filter((r) => r.type === 'chat-read')).toHaveLength(2);
    // The second Apply uses the new hash and goes through.
    expect(await c.apply()).toBe(true);
  });

  it('marks an unchanged file as not applicable', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'same\r\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', 'same\n'));
    expect(c.badges).toEqual(['unchanged']);
    expect(c.applicable).toBe(false);
    expect(await c.apply()).toBe(false);
  });

  it('shows a refused path as blocked and never writes it', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('.env', 'SECRET=1\n'));
    expect(c.badges).toEqual(['blocked']);
    expect(await c.apply()).toBe(false);
    expect(worker.calls.some((r) => r.type === 'chat-write')).toBe(false);
  });

  it('needs a second click to apply a suspected partial file', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', '// ...rest unchanged\n', true));
    expect(c.badges).toEqual(['modified', 'partial?']);
    expect(await c.apply()).toBe(false);
    expect(worker.calls.some((r) => r.type === 'chat-write')).toBe(false);
    expect(await c.apply()).toBe(true);
  });

  it('undoes by op id, and rejects without writing', async () => {
    const worker = fakeWorker({});
    const a = await card(worker, edit('a.ts', 'x\n'));
    await a.apply();
    await a.undo();
    expect(a.state).toBe('undone');
    expect(worker.calls).toContainEqual({ type: 'chat-undo', opId: 'op-1' });

    const b = await card(worker, edit('b.ts', 'x\n'));
    b.reject();
    expect(b.state).toBe('rejected');
    expect(worker.calls.filter((r) => r.type === 'chat-write')).toHaveLength(1);
  });

  it('restores a saved state without reading the file', async () => {
    const worker = fakeWorker({});
    const c = new DiffCard('k', edit('a.ts', 'x\n'), worker.ask, () => {});
    await c.init({ state: 'applied', path: 'a.ts', opId: 'op-9', kind: 'create', updatedAt: 1 });
    expect(c.state).toBe('applied');
    expect(worker.calls).toEqual([]);
    await c.undo();
    expect(worker.calls).toContainEqual({ type: 'chat-undo', opId: 'op-9' });
  });

  it('does nothing once its session has ended', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('a.ts', 'x\n'));
    c.setDisabled(true);
    expect(c.applicable).toBe(false);
    c.reject();
    expect(c.state).toBe('pending');
  });

  it('renders chat text as text, never HTML', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('<img src=x onerror=alert(1)>.ts', '<script>x()</script>\n'));
    // The shadow root is closed, so check the host has no stray elements in the page.
    expect(c.host.children).toHaveLength(0);
    expect(document.querySelector('img, script')).toBeNull();
  });
});

describe('Apply all', () => {
  it('applies in order and stops at the first error', async () => {
    const worker = fakeWorker({});
    const cards = [
      await card(worker, edit('a.ts', 'a\n')),
      await card(worker, edit('b.ts', 'b\n')),
      await card(worker, edit('c.ts', 'c\n'))
    ];
    worker.writeOverride.set('b.ts', {
      ok: false,
      error: { code: 'io-error', message: 'disk' }
    });
    const bar = new ApplyAllBar(cards);
    expect(bar.visible).toBe(true);
    await bar.run();
    expect(cards.map((c) => c.state)).toEqual(['applied', 'pending', 'pending']);
    expect(
      worker.calls.filter((r) => r.type === 'chat-write').map((r) => 'path' in r && r.path)
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('skips suspected partial and unchanged files, and needs two targets', async () => {
    const worker = fakeWorker({ 'same.ts': { content: 's\n', hash: HASH_A } });
    const cards = [
      await card(worker, edit('a.ts', 'a\n')),
      await card(worker, edit('p.ts', '// ...\n', true)),
      await card(worker, edit('same.ts', 's\n'))
    ];
    expect(applyAllTargets(cards).map((c) => c.edit.path)).toEqual(['a.ts']);
    expect(new ApplyAllBar(cards).visible).toBe(false);
  });
});

describe('insertIntoComposer', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p></p></div></form>';
  });

  it('pastes text/plain into the ProseMirror composer and never submits', () => {
    const composer = document.querySelector('#prompt-textarea') as HTMLElement;
    let pasted = '';
    composer.addEventListener('paste', (event) => {
      pasted = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      event.preventDefault();
      composer.textContent = pasted;
    });
    const submit = vi.fn((event: Event) => event.preventDefault());
    document.querySelector('form')?.addEventListener('submit', submit);

    expect(insertIntoComposer('hello\nworld')).toEqual({ ok: true, method: 'paste', chars: 11 });
    expect(pasted).toBe('hello\nworld');
    expect(submit).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when the paste is ignored', () => {
    const exec = vi.fn(() => {
      (document.querySelector('#prompt-textarea') as HTMLElement).textContent = 'typed';
      return true;
    });
    document.execCommand = exec;
    expect(insertIntoComposer('typed')).toEqual({ ok: true, method: 'insert-text', chars: 5 });
    expect(exec).toHaveBeenCalledWith('insertText', false, 'typed');
  });

  it('says so when there is no composer', () => {
    document.body.innerHTML = '<main></main>';
    expect(insertIntoComposer('x')).toEqual({ ok: false, error: 'no-composer' });
  });
});
