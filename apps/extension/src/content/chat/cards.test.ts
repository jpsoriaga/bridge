// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildContinuation,
  FORMAT_FOOTER,
  FORMAT_REMINDER,
  type BridgeConfig,
  type ParsedEdit,
  type ReadResult,
  type RunResult,
  type WriteResult
} from '@bridge/shared';
import type { RequestOutcome, WorkerRequest } from '../../messages';
import { applyAllTargets, MessageBar, undoAllTargets } from './cards/message-bar';
import { DiffCard, type Ask } from './cards/diff-card';
import { FormatCard, issueLines } from './cards/format-card';
import { InterruptCard } from './cards/interrupt-card';
import { ReadCard } from './cards/read-card';
import { RunCard } from './cards/run-card';
import { autoApply, editSummary } from './controller';
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
  let runs = 0;
  const writeOverride = new Map<string, RequestOutcome<WriteResult>>();
  /** Paths the "app" refuses to write without a click. */
  const gated = new Set<string>(['package.json']);
  const ask = vi.fn(async (request: WorkerRequest) => {
    calls.push(request);
    switch (request.type) {
      case 'chat-read': {
        const file = files[request.path];
        if (request.path.startsWith('.env')) {
          return { ok: false, error: { code: 'denied', message: 'protected' } };
        }
        return file
          ? ({
              ok: true,
              result: { ...file, eol: 'lf', bom: false }
            } satisfies RequestOutcome<ReadResult>)
          : { ok: false, error: { code: 'not-found', message: 'missing' } };
      }
      case 'chat-write': {
        const forced = writeOverride.get(request.path);
        if (forced) return forced;
        if (request.trigger === 'auto' && gated.has(request.path)) {
          return { ok: false, error: { code: 'gated', message: 'gated' } };
        }
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
      case 'chat-run':
        runs += 1;
        return { ok: true, result: { runId: `run-${runs}` } };
      case 'chat-run-cancel':
        return { ok: true, result: { cancelled: true } };
      default:
        return true;
    }
  });
  return { ask: ask as unknown as Ask, calls, files, writeOverride, gated };
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

    expect(await c.apply()).toBe('applied');
    expect(c.state).toBe('applied');
    expect(c.auto).toBe(false);
    expect(worker.calls).toContainEqual({
      type: 'chat-write',
      path: 'a.ts',
      content: 'new\n',
      baseHash: HASH_A,
      trigger: 'click'
    });
    // Saved as pending when it appeared, then as applied with the op id.
    const saved = worker.calls.filter((c) => c.type === 'card-set');
    expect(saved.map((s) => s.type === 'card-set' && s.record.state)).toEqual([
      'pending',
      'applied'
    ]);
    expect(saved[1]?.type === 'card-set' && saved[1].record).toMatchObject({ opId: 'op-1' });
  });

  it('creates a missing file without a base hash', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('new.ts', 'x\n'));
    expect(c.badges).toEqual(['new']);
    await c.apply();
    expect(worker.calls).toContainEqual({
      type: 'chat-write',
      path: 'new.ts',
      content: 'x\n',
      trigger: 'click'
    });
  });

  it('re-reads and shows the new diff on conflict', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', 'new\n'));
    // Edited on disk after the card read it.
    worker.files['a.ts'] = { content: 'edited\n', hash: 'c'.repeat(64) };
    expect(await c.apply()).toBe('failed');
    expect(c.state).toBe('pending');
    expect(c.badges).toEqual(['conflict']);
    expect(worker.calls.filter((r) => r.type === 'chat-read')).toHaveLength(2);
    // The second Apply uses the new hash and goes through.
    expect(await c.apply()).toBe('applied');
  });

  it('marks an unchanged file as not applicable', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'same\r\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', 'same\n'));
    expect(c.badges).toEqual(['unchanged']);
    expect(c.applicable).toBe(false);
    expect(await c.apply()).toBe('not-applicable');
  });

  it('shows a refused path as blocked and never writes it', async () => {
    const worker = fakeWorker({});
    const c = await card(worker, edit('.env', 'SECRET=1\n'));
    expect(c.badges).toEqual(['blocked']);
    expect(await c.apply()).toBe('not-applicable');
    expect(worker.calls.some((r) => r.type === 'chat-write')).toBe(false);
  });

  it('needs a second click to apply a suspected partial file', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const c = await card(worker, edit('a.ts', '// ...rest unchanged\n', true));
    expect(c.badges).toEqual(['modified', 'partial?']);
    expect(await c.apply()).toBe('confirm');
    expect(worker.calls.some((r) => r.type === 'chat-write')).toBe(false);
    expect(await c.apply()).toBe('applied');
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
    const bar = new MessageBar(cards);
    expect(bar.visible).toBe(true);
    await bar.applyAll();
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
    expect(new MessageBar(cards).visible).toBe(false);
  });
});

describe('Auto-apply', () => {
  it('applies in order with trigger auto, and the card says Auto-applied', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const cards = [
      await card(worker, edit('a.ts', 'new\n')),
      await card(worker, edit('b.ts', 'b\n'))
    ];
    await autoApply(cards, 'loop-1');
    expect(cards.map((c) => c.state)).toEqual(['applied', 'applied']);
    expect(cards.every((c) => c.auto)).toBe(true);
    const writes = worker.calls.filter((r) => r.type === 'chat-write');
    expect(writes.map((r) => r.type === 'chat-write' && [r.path, r.trigger, r.loopId])).toEqual([
      ['a.ts', 'auto', 'loop-1'],
      ['b.ts', 'auto', 'loop-1']
    ]);
    const saved = worker.calls.flatMap((r) => (r.type === 'card-set' ? [r.record] : []));
    expect(saved.at(-1)).toMatchObject({ state: 'applied', auto: true });
    expect(cards[0]!.host.isConnected).toBe(false);
  });

  it('leaves partial, conflicting, blocked, gated and oversized edits for a click', async () => {
    const worker = fakeWorker({
      'a.ts': { content: 'old\n', hash: HASH_A },
      'package.json': { content: '{}\n', hash: HASH_A }
    });
    const partial = await card(worker, edit('p.ts', '// ...rest unchanged\n', true));
    const blocked = await card(worker, edit('.env', 'X=1\n'));
    const gated = await card(worker, edit('package.json', '{"x":1}\n'));
    const big = await card(worker, edit('big.ts', 'x'.repeat(1024 * 1024 + 1)));
    const conflict = await card(worker, edit('a.ts', 'new\n'));
    worker.files['a.ts'] = { content: 'edited\n', hash: 'c'.repeat(64) };
    const fine = await card(worker, edit('ok.ts', 'ok\n'));
    const cards = [partial, blocked, gated, big, conflict, fine];

    await autoApply(cards);
    expect(cards.map((c) => c.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'applied'
    ]);
    const written = worker.calls.flatMap((r) => (r.type === 'chat-write' ? [r.path] : []));
    // Partial, blocked and oversized never reach the app; gated and conflict are refused by it.
    expect(written).toEqual(['package.json', 'a.ts', 'ok.ts']);
    expect(editSummary(cards)).toEqual({
      applied: ['ok.ts'],
      held: [
        { path: 'p.ts', hold: 'partial', reason: 'may be partial' },
        { path: '.env', hold: 'blocked', reason: 'blocked' },
        { path: 'package.json', hold: 'gated', reason: 'gated file' },
        { path: 'big.ts', hold: 'blocked', reason: 'blocked' },
        { path: 'a.ts', hold: 'conflict', reason: 'changed on disk' }
      ]
    });

    // Each still applies on a click: the gated file too.
    expect(await gated.apply()).toBe('applied');
    expect(gated.auto).toBe(false);
  });

  it('never touches cards already applied, rejected or undone', async () => {
    const worker = fakeWorker({});
    const a = await card(worker, edit('a.ts', 'a\n'));
    const b = await card(worker, edit('b.ts', 'b\n'));
    b.reject();
    await a.apply();
    const before = worker.calls.filter((r) => r.type === 'chat-write').length;
    await autoApply([a, b]);
    expect(worker.calls.filter((r) => r.type === 'chat-write')).toHaveLength(before);
  });
});

describe('Undo all', () => {
  it('undoes a reply’s applied edits newest first, and shows with two or more', async () => {
    const worker = fakeWorker({});
    const cards = [
      await card(worker, edit('a.ts', 'a\n')),
      await card(worker, edit('b.ts', 'b\n')),
      await card(worker, edit('c.ts', 'c\n'))
    ];
    await autoApply(cards);
    const bar = new MessageBar(cards);
    expect(undoAllTargets(cards).map((c) => c.edit.path)).toEqual(['c.ts', 'b.ts', 'a.ts']);
    expect(bar.visible).toBe(true);
    await bar.undoAll();
    expect(cards.map((c) => c.state)).toEqual(['undone', 'undone', 'undone']);
    expect(worker.calls.flatMap((r) => (r.type === 'chat-undo' ? [r.opId] : []))).toEqual([
      'op-3',
      'op-2',
      'op-1'
    ]);
    expect(bar.visible).toBe(false);
  });
});

const CONFIG: BridgeConfig = {
  mode: 'manual',
  allowlist: ['pnpm test *', 'git status', 'node *'],
  stepLimit: 10,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  running: null,
  instance: 'launch-1'
};

const exit = (runId: string, exitCode: number, output = 'ok\n'): RunResult => ({
  runId,
  argv: ['pnpm', 'test'],
  status: 'exited',
  exitCode,
  signal: null,
  durationMs: 2500,
  output,
  truncated: false
});

describe('RunCard', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main></main><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div></form>';
    const composer = document.getElementById('prompt-textarea')!;
    composer.addEventListener('paste', (event) => {
      event.preventDefault();
      composer.textContent += (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    });
  });

  const runCard = (worker: ReturnType<typeof fakeWorker>, command: string) => {
    const registered: string[] = [];
    const c = new RunCard(command, worker.ask, (runId) => registered.push(runId));
    c.setConfig(CONFIG);
    return { card: c, registered };
  };

  it.each([
    ['pnpm test', 'allowlisted', null],
    ['pnpm test -- --run', 'allowlisted', null],
    ['pnpm testx', 'not allowed', 'it isn’t on the allowlist in the Bridge app'],
    ['git push', 'not allowed', 'it isn’t on the allowlist in the Bridge app'],
    ['git status --short', 'not allowed', 'it isn’t on the allowlist in the Bridge app'],
    [
      'node -e 1',
      'not allowed',
      'Bridge never allows -e here: it could run other code, write files or change folders'
    ],
    [
      'pnpm test && rm -rf /',
      'not allowed',
      'Bridge runs one command at a time, without |, &&, ;, < or >.'
    ]
  ])('badges %j as %s', (command, badge, refusal) => {
    const { card: c } = runCard(fakeWorker({}), command);
    expect(c.badge).toBe(badge);
    expect(c.refusal()).toBe(refusal);
  });

  it('runs with a click, streams output, and ends with the exit badge', async () => {
    const worker = fakeWorker({});
    const { card: c, registered } = runCard(worker, 'pnpm test');
    const done = c.run();
    await vi.waitFor(() => expect(registered).toEqual(['run-1']));
    expect(worker.calls).toContainEqual({
      type: 'chat-run',
      argv: ['pnpm', 'test'],
      trigger: 'click'
    });
    expect(c.badge).toBe('running');
    c.onOutput('FAIL a.test.ts\n');
    c.onExit(exit('run-1', 1, 'FAIL a.test.ts\n'));
    expect(await done).toMatchObject({ ok: true, result: { exitCode: 1 } });
    expect(c.badge).toBe('exit 1');
  });

  it.each([
    [{ status: 'timed-out', exitCode: null }, 'timed out'],
    [{ status: 'cancelled', exitCode: null }, 'cancelled'],
    [{ status: 'exited', exitCode: 0 }, 'exit 0']
  ] as const)('shows %j as %s', async (patch, badge) => {
    const { card: c } = runCard(fakeWorker({}), 'pnpm test');
    const done = c.run();
    await vi.waitFor(() => expect(c.running).toBe(true));
    await new Promise((r) => setTimeout(r, 0));
    c.onExit({ ...exit('run-1', 0), ...patch });
    await done;
    expect(c.badge).toBe(badge);
  });

  it('cancels by run id', async () => {
    const worker = fakeWorker({});
    const { card: c, registered } = runCard(worker, 'pnpm test');
    void c.run();
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    await c.cancel();
    expect(worker.calls).toContainEqual({ type: 'chat-run-cancel', runId: 'run-1' });
  });

  it('never asks to run a command that isn’t allowed', async () => {
    const worker = fakeWorker({});
    const { card: c } = runCard(worker, 'git push');
    expect(await c.run()).toMatchObject({ ok: false });
    expect(worker.calls.some((r) => r.type === 'chat-run')).toBe(false);
  });

  it('Send output inserts the result into the composer without sending', async () => {
    const worker = fakeWorker({});
    const { card: c, registered } = runCard(worker, 'pnpm test');
    let submitted = false;
    document.querySelector('form')!.addEventListener('submit', () => (submitted = true));
    const done = c.run();
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    c.onExit(exit('run-1', 1, 'FAIL\n'));
    await done;
    (c as unknown as { sendOutput(): void }).sendOutput();
    const text = document.getElementById('prompt-textarea')!.textContent ?? '';
    expect(text).toContain('Output of `pnpm test` (exit 1, 2.5s):');
    expect(text).toContain('FAIL');
    expect(text.endsWith(FORMAT_FOOTER)).toBe(true);
    expect(submitted).toBe(false);
  });

  it('says why when the app refuses it', async () => {
    const worker = fakeWorker({});
    (worker.ask as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'busy', message: 'busy' }
    }));
    const { card: c } = runCard(worker, 'pnpm test');
    expect(await c.run()).toEqual({
      ok: false,
      disconnected: false,
      message: 'Another command is still running.'
    });
    expect(c.badge).toBe('allowlisted');
  });
});

describe('ReadCard', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main></main><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div>';
    const composer = document.getElementById('prompt-textarea')!;
    composer.addEventListener('paste', (event) => {
      event.preventDefault();
      composer.textContent += (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    });
  });

  const KEY = 'conv-1234:m:read:0000000000000000';
  const saved = (worker: ReturnType<typeof fakeWorker>) =>
    worker.calls.flatMap((c) => (c.type === 'card-set' ? [c.record] : []));

  it('saves itself as pending when it first appears, then as sent', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'x\n', hash: HASH_A } });
    const sent = vi.fn();
    const c = new ReadCard(KEY, ['a.ts'], worker.ask, sent);
    await c.init();
    expect(saved(worker)).toEqual([
      { card: 'read', state: 'pending', updatedAt: expect.any(Number) }
    ]);

    // The Send button's handler.
    (c as unknown as { send(): void }).send();
    expect(document.getElementById('prompt-textarea')?.textContent).toContain('@@CONTEXT a.ts@@');
    expect(sent).toHaveBeenCalledWith([
      { path: 'a.ts', chars: expect.any(Number) as number, hash: expect.any(String) as string }
    ]);
    expect(saved(worker).at(-1)).toMatchObject({ card: 'read', state: 'sent' });
  });

  it('comes back as sent after a reload, without saving again', async () => {
    const worker = fakeWorker({ 'a.ts': { content: 'x\n', hash: HASH_A } });
    const c = new ReadCard(KEY, ['a.ts'], worker.ask, () => {});
    await c.init({ card: 'read', state: 'sent', updatedAt: 1 });
    expect(saved(worker)).toEqual([]);
    expect(c.sent).toBe(true);
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

/** The card's own row, through a shadow root forced open for the test. */
function openShadows() {
  const attach = HTMLElement.prototype.attachShadow;
  return vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (
    this: HTMLElement,
    init: ShadowRootInit
  ) {
    return attach.call(this, { ...init, mode: 'open' });
  });
}

function resultRow(host: HTMLElement) {
  const root = host.shadowRoot!;
  const words = [...root.querySelectorAll('.header .word')];
  return {
    result: root.querySelector('.card')?.getAttribute('data-result'),
    word: words.map((w) => [w.textContent, w.getAttribute('data-tone')]),
    note: root.querySelector('.word-note')?.textContent ?? null,
    iconTone: root.querySelector('.header svg')?.getAttribute('data-tone') ?? null,
    time: root.querySelector('.time') !== null
  };
}

describe('Applied rows', () => {
  it('say what happened, coloured by kind: green only for a new file, no check icon', async () => {
    const spy = openShadows();
    const worker = fakeWorker({ 'a.ts': { content: 'old\n', hash: HASH_A } });
    const modified = await card(worker, edit('a.ts', 'new\n'));
    const created = await card(worker, edit('b.ts', 'b\n'));
    await modified.apply();
    await created.apply();
    expect(resultRow(modified.host)).toEqual({
      result: 'modify',
      word: [['Modified', null]],
      note: null,
      iconTone: null,
      time: true
    });
    expect(resultRow(created.host)).toEqual({
      result: 'create',
      word: [['Created', 'success']],
      note: null,
      iconTone: 'success',
      time: true
    });
    spy.mockRestore();
  });

  it('mark automatic edits with a muted “auto”', async () => {
    const spy = openShadows();
    const worker = fakeWorker({});
    const created = await card(worker, edit('c.ts', 'c\n'));
    await autoApply([created]);
    expect(resultRow(created.host)).toMatchObject({ word: [['Created', 'success']], note: 'auto' });
    spy.mockRestore();
  });
});

describe('format fixed', () => {
  const badge = (host: HTMLElement) =>
    host.shadowRoot!.querySelector('[data-badge="format-fixed"]')?.textContent ?? null;

  it('shows on a diff card whose marker was missing its closing @@', async () => {
    const spy = openShadows();
    const worker = fakeWorker({});
    const fixed = await card(worker, { ...edit('a.ts', 'a\n'), formatFixed: true });
    const plain = await card(worker, edit('b.ts', 'b\n'));
    expect(badge(fixed.host)).toBe('format fixed');
    expect(badge(plain.host)).toBeNull();
    spy.mockRestore();
  });

  it('shows on RUN and READ cards when set before they render', async () => {
    const spy = openShadows();
    const worker = fakeWorker({ 'a.ts': { content: 'a\n', hash: HASH_A } });
    const run = new RunCard('pnpm test', worker.ask, () => {});
    run.formatFixed = true;
    run.setConfig(CONFIG);
    expect(badge(run.host)).toBe('format fixed');
    const read = new ReadCard('k', ['a.ts'], worker.ask, () => {});
    read.formatFixed = true;
    await read.init();
    expect(badge(read.host)).toBe('format fixed');
    spy.mockRestore();
  });
});

describe('FormatCard', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main></main><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div></form>';
    const composer = document.getElementById('prompt-textarea')!;
    composer.addEventListener('paste', (event) => {
      event.preventDefault();
      composer.textContent += (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
    });
  });

  it('says what Bridge could not read, three issues at most', () => {
    expect(
      issueLines([
        { kind: 'bad-marker', text: '`@@RUNS npm test@@`' },
        { kind: 'no-marker', text: 'src/app.ts' },
        { kind: 'no-block', text: '`@@FILE a.ts@@`' },
        { kind: 'placeholder', text: 'b.ts' },
        { kind: 'placeholder', text: 'c.ts' }
      ])
    ).toEqual([
      'Not a Bridge marker: `@@RUNS npm test@@`',
      'A code block under “src/app.ts” has no @@FILE marker.',
      'No code block after `@@FILE a.ts@@`',
      'And 2 more.'
    ]);
  });

  it('inserts the reminder into the composer without sending', () => {
    const spy = openShadows();
    let submitted = false;
    document.querySelector('form')!.addEventListener('submit', () => (submitted = true));
    const c = new FormatCard([{ kind: 'bad-marker', text: '@@RUN npm test' }]);
    document.body.append(c.host);
    const root = c.host.shadowRoot!;
    expect(root.querySelector('.title')?.textContent).toBe('The chat didn’t use Bridge’s format');
    expect(root.textContent).not.toMatch(/chatgpt|openai/i);
    root.querySelector<HTMLButtonElement>('[data-focus="remind"]')!.click();
    expect(document.getElementById('prompt-textarea')!.textContent).toBe(FORMAT_REMINDER);
    expect(submitted).toBe(false);
    expect(root.querySelector('.hint')?.textContent).toBe(
      'The reminder is in the message box. Press send.'
    );
    spy.mockRestore();
  });

  it('says when Full auto sent it, and turns off when the session ends', () => {
    const spy = openShadows();
    const c = new FormatCard([{ kind: 'no-block', text: '`@@FILE a.ts@@`' }]);
    c.markAutoSent();
    const root = c.host.shadowRoot!;
    expect(root.querySelector('.hint')?.textContent).toBe('Full auto sent a format reminder.');
    c.setDisabled(true);
    expect(root.querySelector<HTMLButtonElement>('[data-focus="remind"]')!.disabled).toBe(true);
    spy.mockRestore();
  });
});

describe('InterruptCard', () => {
  const cut = { marker: '@@FILE src/one.ts@@', cutOff: 'src/two.ts' };
  const fake = (canContinue: boolean) => {
    const inserted: string[] = [];
    let presses = 0;
    return {
      inserted,
      presses: () => presses,
      actions: {
        canContinue: () => canContinue,
        continueReply: () => {
          presses += 1;
          return canContinue;
        },
        insert: (text: string) => {
          inserted.push(text);
          return { ok: true as const, method: 'paste' as const, chars: text.length };
        }
      }
    };
  };

  it('says where the reply stopped and that the cut-off file isn’t applied', () => {
    const spy = openShadows();
    const c = new InterruptCard(cut, fake(false).actions);
    const root = c.host.shadowRoot!;
    expect(root.querySelector('.title')?.textContent).toBe('The chat’s reply was interrupted');
    expect([...root.querySelectorAll('.issue')].map((li) => li.textContent)).toEqual([
      'It stopped after @@FILE src/one.ts@@.',
      'src/two.ts was cut off, so Bridge won’t apply it.'
    ]);
    expect(root.textContent).not.toMatch(/chatgpt|openai/i);
    spy.mockRestore();
  });

  it('inserts the continuation without sending', () => {
    const spy = openShadows();
    const f = fake(false);
    const c = new InterruptCard(cut, f.actions);
    const root = c.host.shadowRoot!;
    expect(root.querySelector('[data-focus="continue"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-focus="continuation"]')!.click();
    expect(f.inserted).toEqual([buildContinuation(cut)]);
    expect(root.querySelector('.hint')?.textContent).toBe(
      'The request is in the message box. Press send.'
    );
    spy.mockRestore();
  });

  it('offers the page’s Continue generating first when it’s there', () => {
    const spy = openShadows();
    const f = fake(true);
    const c = new InterruptCard(cut, f.actions);
    const root = c.host.shadowRoot!;
    const primary = root.querySelector<HTMLButtonElement>('.btn-primary')!;
    expect(primary.textContent).toBe('Continue generating');
    primary.click();
    expect(f.presses()).toBe(1);
    expect(f.inserted).toEqual([]);
    expect(root.querySelector('.hint')?.textContent).toBe('The chat is continuing the same reply.');
    c.markAutoSent();
    expect(root.querySelector('.hint')?.textContent).toBe('Full auto asked the chat to continue.');
    c.setDisabled(true);
    expect(root.querySelector<HTMLButtonElement>('[data-focus="continuation"]')!.disabled).toBe(
      true
    );
    spy.mockRestore();
  });
});
