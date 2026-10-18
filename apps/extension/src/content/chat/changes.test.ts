// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { ParsedEdit, StatResult, WriteResult } from '@bridge/shared';
import type { RequestOutcome, WorkerRequest } from '../../messages';
import { ChangeCard, type FileChange } from './cards/change-card';
import { DiffCard, type Ask } from './cards/diff-card';
import { nearestCorner } from './cards/loop-chip';
import { applyAllTargets } from './cards/message-bar';
import { autoApply, changeSummary, markDuplicates } from './controller';
import { conversationMissing } from './selectors';

// DELETE and RENAME cards, and the edge cases of FILE cards: the same path twice in one
// reply, no-op edits, trailing newlines, binary or huge content, and files changing on disk.

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

type Disk = Record<string, { content: string; hash: string; size?: number }>;

/** A fake worker over a map of files on "disk", recording every request. */
function fakeWorker(disk: Disk) {
  const calls: WorkerRequest[] = [];
  let ops = 0;
  const ask = vi.fn(async (request: WorkerRequest) => {
    calls.push(request);
    const missing = { ok: false, error: { code: 'not-found', message: 'missing' } };
    switch (request.type) {
      case 'chat-read': {
        const file = disk[request.path];
        return file ? { ok: true, result: { ...file, eol: 'lf', bom: false } } : missing;
      }
      case 'chat-stat': {
        if (request.path.startsWith('.env')) {
          return { ok: false, error: { code: 'denied', message: 'protected' } };
        }
        const file = disk[request.path];
        return file
          ? ({
              ok: true,
              result: { size: file.size ?? file.content.length, hash: file.hash }
            } satisfies RequestOutcome<StatResult>)
          : missing;
      }
      case 'chat-write': {
        const file = disk[request.path];
        if (file && file.hash !== request.baseHash) {
          return { ok: false, error: { code: 'conflict', message: 'changed' } };
        }
        ops += 1;
        disk[request.path] = { content: request.content, hash: HASH_B };
        return {
          ok: true,
          result: { opId: `op-${ops}`, kind: file ? 'modify' : 'create', hash: HASH_B }
        } satisfies RequestOutcome<WriteResult>;
      }
      case 'chat-delete': {
        const file = disk[request.path];
        if (!file) return missing;
        if (file.hash !== request.baseHash) {
          return { ok: false, error: { code: 'conflict', message: 'changed' } };
        }
        delete disk[request.path];
        ops += 1;
        return { ok: true, result: { opId: `op-${ops}` } };
      }
      case 'chat-rename': {
        const file = disk[request.from];
        if (!file) return missing;
        if (disk[request.to] && request.to.toLowerCase() !== request.from.toLowerCase()) {
          return { ok: false, error: { code: 'exists', message: 'taken' } };
        }
        delete disk[request.from];
        disk[request.to] = file;
        ops += 1;
        return { ok: true, result: { opId: `op-${ops}`, hash: file.hash } };
      }
      case 'chat-undo':
        return { ok: true, result: { opId: request.opId, path: 'x' } };
      default:
        return true;
    }
  });
  return { ask: ask as unknown as Ask, calls, disk };
}

const edit = (path: string, content: string, fence = 0): ParsedEdit => ({
  path,
  content,
  suspectedPartial: false,
  fence
});

async function diffCard(worker: ReturnType<typeof fakeWorker>, e: ParsedEdit, slot = 0) {
  const card = new DiffCard(`conv-1234:m:${slot}:0000000000000000`, e, worker.ask, () => {});
  await card.init(undefined);
  return card;
}

async function changeCard(worker: ReturnType<typeof fakeWorker>, change: FileChange) {
  const card = new ChangeCard('conv-1234:m:d0:0000000000000000', change, worker.ask, () => {});
  await card.init(undefined);
  return card;
}

describe('ChangeCard: delete', () => {
  it('checks the file, deletes it on a click with the hash it saw, and undoes', async () => {
    const worker = fakeWorker({ 'old.ts': { content: 'x', hash: HASH_A, size: 2048 } });
    const card = await changeCard(worker, { kind: 'delete', path: 'old.ts' });
    expect(card.badges).toEqual(['delete']);
    expect(card.applicable).toBe(true);
    expect(await card.apply()).toBe(true);
    expect(worker.calls).toContainEqual({ type: 'chat-delete', path: 'old.ts', baseHash: HASH_A });
    expect(card.state).toBe('applied');
    const saved = worker.calls.filter((c) => c.type === 'card-set');
    expect(saved.at(-1)).toMatchObject({
      record: { card: 'change', state: 'applied', opId: 'op-1', appliedAt: expect.any(Number) }
    });
    await card.undo();
    expect(card.state).toBe('undone');
  });

  it('has nothing to delete when the file isn’t there, and refuses protected files', async () => {
    const worker = fakeWorker({});
    const gone = await changeCard(worker, { kind: 'delete', path: 'gone.ts' });
    expect(gone.badges).toEqual(['missing']);
    expect(gone.applicable).toBe(false);
    const secret = await changeCard(worker, { kind: 'delete', path: '.env' });
    expect(secret.badges).toEqual(['blocked']);
    expect(secret.applicable).toBe(false);
  });

  it('never applies on its own: the summary lists it as pending until clicked', async () => {
    const worker = fakeWorker({ 'old.ts': { content: 'x', hash: HASH_A } });
    const card = await changeCard(worker, { kind: 'delete', path: 'old.ts' });
    expect(changeSummary([card])).toEqual({ applied: [], pending: ['old.ts (deleted)'] });
    await card.apply();
    expect(changeSummary([card])).toEqual({ applied: ['old.ts (deleted)'], pending: [] });
  });

  it('flags a change on disk before the click', async () => {
    const worker = fakeWorker({ 'old.ts': { content: 'x', hash: HASH_A } });
    const card = await changeCard(worker, { kind: 'delete', path: 'old.ts' });
    worker.disk['old.ts'] = { content: 'edited', hash: HASH_B };
    await card.refresh();
    expect(card.badges).toEqual(['delete', 'conflict']);
    // It deletes what's there now, with the new hash.
    await card.apply();
    expect(worker.calls).toContainEqual({ type: 'chat-delete', path: 'old.ts', baseHash: HASH_B });
  });
});

describe('ChangeCard: rename', () => {
  it('moves the file on a click', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'a', hash: HASH_A } });
    const card = await changeCard(worker, { kind: 'rename', from: 'a.ts', to: 'lib/b.ts' });
    expect(card.badges).toEqual(['rename']);
    expect(card.summary).toBe('a.ts → lib/b.ts (renamed)');
    expect(await card.apply()).toBe(true);
    expect(worker.calls).toContainEqual({
      type: 'chat-rename',
      from: 'a.ts',
      to: 'lib/b.ts',
      baseHash: HASH_A
    });
  });

  it('won’t rename onto a taken path', async () => {
    const worker = fakeWorker({
      'a.ts': { content: 'a', hash: HASH_A },
      'b.ts': { content: 'b', hash: HASH_B }
    });
    const card = await changeCard(worker, { kind: 'rename', from: 'a.ts', to: 'b.ts' });
    expect(card.badges).toEqual(['exists']);
    expect(card.applicable).toBe(false);
  });

  it('allows a case-only rename that finds the same file at the new name', async () => {
    const file = { content: 'app', hash: HASH_A };
    // A case-insensitive disk: both names open the same file.
    const worker = fakeWorker({ 'src/App.tsx': file, 'src/app.tsx': file });
    const card = await changeCard(worker, {
      kind: 'rename',
      from: 'src/App.tsx',
      to: 'src/app.tsx'
    });
    expect(card.badges).toEqual(['rename']);
    expect(card.applicable).toBe(true);
  });
});

describe('the same path twice in one reply', () => {
  it('shows both with a warning, and Apply all and Auto-apply take the last one', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const first = await diffCard(worker, edit('a.ts', 'first\n', 0), 0);
    const other = await diffCard(worker, edit('b.ts', 'b\n', 1), 1);
    const last = await diffCard(worker, edit('a.ts', 'last\n', 2), 2);
    markDuplicates([first, other, last]);
    expect([first.duplicate, other.duplicate, last.duplicate]).toEqual(['earlier', null, 'later']);
    expect(applyAllTargets([first, other, last])).toEqual([other, last]);

    await autoApply([first, other, last]);
    const writes = worker.calls.filter((c) => c.type === 'chat-write');
    expect(writes.map((w) => w.type === 'chat-write' && w.content)).toEqual(['b\n', 'last\n']);
    expect(first.state).toBe('pending');
  });
});

describe('FILE card edge cases', () => {
  it('shows an edit that changes nothing as unchanged, with Apply disabled', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'same\n', hash: HASH_A } });
    const card = await diffCard(worker, edit('a.ts', 'same\n'));
    expect(card.badges).toEqual(['unchanged']);
    expect(card.applicable).toBe(false);
  });

  it('treats a file without a final newline as unchanged when only that differs', async () => {
    // The chat format always ends content with a newline; the app keeps the file's own.
    const worker = fakeWorker({ 'a.ts': { content: 'no newline', hash: HASH_A } });
    const card = await diffCard(worker, edit('a.ts', 'no newline\n'));
    expect(card.badges).toEqual(['unchanged']);
  });

  it('refuses binary or huge content without reading or diffing it', async () => {
    const worker = fakeWorker({});
    const binary = await diffCard(worker, edit('img.png', 'PNG\u0000\u0001'));
    expect(binary.badges).toEqual(['blocked']);
    expect(binary.applicable).toBe(false);
    const huge = await diffCard(worker, edit('big.txt', 'x'.repeat(1024 * 1024 + 1)));
    expect(huge.badges).toEqual(['blocked']);
    expect(worker.calls.filter((c) => c.type === 'chat-read')).toEqual([]);
    expect(await huge.apply({ trigger: 'auto' })).toBe('not-applicable');
  });

  it('flags a file that changed on disk as a conflict, with the new diff', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const card = await diffCard(worker, edit('a.ts', 'new\n'));
    worker.disk['a.ts'] = { content: 'edited elsewhere\n', hash: HASH_B };
    await card.refresh();
    expect(card.badges).toEqual(['conflict']);
    // Auto-apply leaves it for a click.
    expect(card.autoHold()).toBe('conflict');
    // A refresh that finds the same file changes nothing.
    const quiet = await diffCard(
      fakeWorker({ 'b.ts': { content: 'b\n', hash: HASH_A } }),
      edit('b.ts', 'c\n')
    );
    await quiet.refresh();
    expect(quiet.badges).toEqual(['modified']);
  });

  it('keeps when it was applied', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const card = await diffCard(worker, edit('a.ts', 'new\n'));
    await card.apply();
    const saved = worker.calls.filter((c) => c.type === 'card-set').at(-1);
    expect(saved).toMatchObject({ record: { state: 'applied', appliedAt: expect.any(Number) } });
  });
});

describe('page chip corners', () => {
  it('snaps to the nearest corner', () => {
    expect(nearestCorner(10, 10, 1000, 800)).toBe('top-left');
    expect(nearestCorner(990, 10, 1000, 800)).toBe('top-right');
    expect(nearestCorner(10, 790, 1000, 800)).toBe('bottom-left');
    expect(nearestCorner(990, 790, 1000, 800)).toBe('bottom-right');
  });
});

describe('conversationMissing', () => {
  it('spots a deleted conversation or a 404, and never a page with messages', () => {
    document.body.innerHTML = '<main><h1>Conversation not found</h1></main>';
    expect(conversationMissing()).toBe(true);
    document.body.innerHTML = '<main><p>Unable to load conversation abc</p></main>';
    expect(conversationMissing()).toBe(true);
    document.body.innerHTML =
      '<main><div data-message-author-role="assistant"><p>Conversation not found</p></div></main>';
    expect(conversationMissing()).toBe(false);
    document.body.innerHTML = '<main><h1>What can I help with?</h1></main>';
    expect(conversationMissing()).toBe(false);
  });
});
