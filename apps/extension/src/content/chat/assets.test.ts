// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundProcess, BridgeConfig, ParsedEdit } from '@bridge/shared';
import type { WorkerRequest } from '../../messages';
import { AssetCard } from './cards/asset-card';
import { ChangeCard } from './cards/change-card';
import { DiffCard, type Ask } from './cards/diff-card';
import { DownloadCard } from './cards/download-card';
import { ProcessCard, READY_WAIT_MS } from './cards/process-card';
import { ReadCard } from './cards/read-card';
import { autoApply, autoSave, editSummary } from './controller';

// The cards 1.3.0 adds (START/STOP/LOGS, DOWNLOAD, Save to project) and what changed in
// the others (READ attaches images; Full auto's "Also approve automatically").

vi.mock('./images', () => ({
  imageFor: vi.fn(async (img: HTMLImageElement, path: string) =>
    // An image on another server that doesn't allow the page to read it.
    img.src.includes('cdn.example')
      ? { ok: false, unreadable: true, error: 'Bridge can’t read this image from the page.' }
      : path.endsWith('.png')
        ? { ok: true, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: 'png' }
        : { ok: false, error: 'Save an image as .png, .jpg, .webp or .gif.' }
  )
}));

const HASH = 'a'.repeat(64);

const CONFIG: BridgeConfig = {
  mode: 'full-auto',
  allowlist: ['npm run dev', 'npm test'],
  stepLimit: 25,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  uiGuidance: 'auto',
  running: null,
  background: ['npm run dev'],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
};

const proc = (overrides: Partial<BackgroundProcess> = {}): BackgroundProcess => ({
  procId: 'p-1',
  command: 'npm run dev',
  state: 'running',
  url: null,
  startedAt: Date.now(),
  endedAt: null,
  exitCode: null,
  signal: null,
  ...overrides
});

/** A worker that answers each request type with a canned outcome, and records them all. */
function worker(answers: Partial<Record<WorkerRequest['type'], unknown>> = {}) {
  const calls: WorkerRequest[] = [];
  const ask = vi.fn(async (request: WorkerRequest) => {
    calls.push(request);
    const answer = answers[request.type];
    if (typeof answer === 'function') return (answer as (r: WorkerRequest) => unknown)(request);
    return answer ?? true;
  }) as unknown as Ask;
  return { ask, calls };
}

const notFound = { ok: false, error: { code: 'not-found', message: 'missing' } };

beforeEach(() => {
  document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div>';
});

describe('ProcessCard', () => {
  it('starts a background entry, waits for its URL, and tells the chat where it runs', async () => {
    const w = worker({
      'chat-bg-start': { ok: true, result: { procId: 'p-1', restarted: false } }
    });
    const card = new ProcessCard('start', 'npm run dev', w.ask);
    card.setConfig(CONFIG);
    expect(card.refusal()).toBeNull();
    expect(card.waiting).toBe(true);
    const started = card.start({ trigger: 'auto', loopId: 'loop-1' });
    await Promise.resolve();
    // The app reports it running, then ready.
    card.setConfig({ ...CONFIG, processes: [proc()] });
    card.setConfig({ ...CONFIG, processes: [proc({ url: 'http://localhost:5173/' })] });
    expect(await started).toEqual({
      command: 'npm run dev',
      started: true,
      restarted: false,
      url: 'http://localhost:5173/'
    });
    expect(w.calls[0]).toEqual({
      type: 'chat-bg-start',
      argv: ['npm', 'run', 'dev'],
      trigger: 'auto',
      loopId: 'loop-1'
    });
    expect(card.waiting).toBe(false);
  });

  it('says so when the process ends right after starting, with its last lines', async () => {
    const w = worker({
      'chat-bg-start': { ok: true, result: { procId: 'p-1', restarted: true } },
      'chat-bg-logs': {
        ok: true,
        result: {
          procId: 'p-1',
          command: 'npm run dev',
          lines: ['EADDRINUSE :5173'],
          first: 0,
          next: 1
        }
      }
    });
    const card = new ProcessCard('start', 'npm run dev', w.ask);
    card.setConfig(CONFIG);
    const started = card.start();
    await Promise.resolve();
    card.setConfig({ ...CONFIG, processes: [proc({ state: 'exited', exitCode: 1 })] });
    expect(await started).toEqual({
      command: 'npm run dev',
      exited: 'exited with code 1',
      lines: ['EADDRINUSE :5173']
    });
  });

  it('goes on after a while if the process never prints a URL', async () => {
    vi.useFakeTimers();
    try {
      const w = worker({
        'chat-bg-start': { ok: true, result: { procId: 'p-1', restarted: false } }
      });
      const card = new ProcessCard('start', 'npm run dev', w.ask);
      card.setConfig({ ...CONFIG, processes: [] });
      const started = card.start();
      await vi.advanceTimersByTimeAsync(0);
      card.setConfig({ ...CONFIG, processes: [proc()] });
      await vi.advanceTimersByTimeAsync(READY_WAIT_MS);
      expect(await started).toMatchObject({ started: true, url: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses one-off commands and commands off the allowlist', async () => {
    const w = worker();
    const task = new ProcessCard('start', 'npm test', w.ask);
    task.setConfig(CONFIG);
    expect(task.refusal()).toContain('isn’t marked as a background process');
    const other = new ProcessCard('start', 'python3 -m http.server', w.ask);
    other.setConfig(CONFIG);
    expect(other.refusal()).toContain('allowlist');
    expect(await other.start()).toEqual({
      command: 'python3 -m http.server',
      refused: 'it isn’t on the allowlist in the Bridge app'
    });
    expect(w.calls).toEqual([]);
  });

  it('stops, and reads logs for Full auto', async () => {
    const w = worker({
      'chat-bg-stop': { ok: true, result: { stopped: true } },
      'chat-bg-logs': (r: WorkerRequest) =>
        r.type === 'chat-bg-logs' && r.tail === 80
          ? {
              ok: true,
              result: { procId: 'p-1', command: 'npm run dev', lines: ['ready'], first: 0, next: 1 }
            }
          : notFound
    });
    const stop = new ProcessCard('stop', 'npm run dev', w.ask);
    stop.setConfig({ ...CONFIG, processes: [proc()] });
    expect(await stop.stop({ trigger: 'auto' })).toEqual({ command: 'npm run dev', stopped: true });
    const logs = new ProcessCard('logs', 'npm run dev', w.ask);
    logs.setConfig({ ...CONFIG, processes: [proc({ url: 'http://localhost:5173/' })] });
    expect(await logs.readLogs()).toEqual({
      command: 'npm run dev',
      lines: ['ready'],
      url: 'http://localhost:5173/'
    });
  });

  it('reports a lost connection so Full auto can pause', async () => {
    const w = worker({
      'chat-bg-start': { ok: false, error: { code: 'not-connected', message: 'x' } }
    });
    const card = new ProcessCard('start', 'npm run dev', w.ask);
    card.setConfig(CONFIG);
    expect(await card.start({ trigger: 'auto' })).toEqual({ disconnected: true });
  });
});

describe('DownloadCard', () => {
  it('downloads only on a click, with the hash of the file it replaces, and undoes', async () => {
    const w = worker({
      'chat-stat': { ok: true, result: { size: 10, hash: HASH } },
      'chat-download': {
        ok: true,
        result: { opId: 'op-1', kind: 'modify', hash: HASH, size: 3, mime: 'image/svg+xml' }
      },
      'chat-undo': { ok: true, result: { opId: 'op-1', path: 'logo.svg' } }
    });
    const card = new DownloadCard(
      'k',
      { url: 'https://example.com/logo.svg', path: 'logo.svg' },
      w.ask,
      () => {}
    );
    await card.init(undefined);
    expect(card.waiting).toBe(true);
    expect(await card.fetch()).toBe(true);
    expect(w.calls.find((c) => c.type === 'chat-download')).toEqual({
      type: 'chat-download',
      url: 'https://example.com/logo.svg',
      path: 'logo.svg',
      baseHash: HASH
    });
    expect(card.state).toBe('applied');
    expect(card.summary).toBe('logo.svg (downloaded)');
    await card.undo();
    expect(card.state).toBe('undone');
  });

  it('never sends a download request with an automatic trigger', () => {
    // The worker request has no trigger at all; the worker always sends `click`.
    const shape = {
      type: 'chat-download',
      url: 'https://x',
      path: 'a.png'
    } satisfies WorkerRequest;
    expect('trigger' in shape).toBe(false);
  });

  it('blocks a link that isn’t https, or a name Bridge doesn’t save, without asking the app', async () => {
    const w = worker();
    const http = new DownloadCard(
      'k',
      { url: 'http://example.com/a.png', path: 'a.png' },
      w.ask,
      () => {}
    );
    await http.init(undefined);
    expect(http.waiting).toBe(false);
    expect(await http.fetch()).toBe(false);
    const exe = new DownloadCard(
      'k',
      { url: 'https://example.com/a.exe', path: 'a.exe' },
      w.ask,
      () => {}
    );
    await exe.init(undefined);
    expect(exe.waiting).toBe(false);
    expect(w.calls.filter((c) => c.type !== 'card-set')).toEqual([]);
  });

  it('shows what the app refused', async () => {
    const w = worker({
      'chat-stat': notFound,
      'chat-download': { ok: false, error: { code: 'unsupported-type', message: 'nope' } }
    });
    const card = new DownloadCard(
      'k',
      { url: 'https://example.com/fake.png', path: 'fake.png' },
      w.ask,
      () => {}
    );
    await card.init(undefined);
    expect(await card.fetch()).toBe(false);
    expect(card.state).toBe('pending');
  });
});

describe('AssetCard', () => {
  const image = () => {
    const img = document.createElement('img');
    img.src = 'https://chatgpt.com/backend-api/estuary/content?id=file-1';
    return img;
  };

  it('saves an image to the path the chat named, as a binary write, and undoes it', async () => {
    const w = worker({
      'chat-stat': notFound,
      'chat-write-binary': { ok: true, result: { opId: 'op-1', kind: 'create', hash: HASH } },
      'chat-undo': { ok: true, result: { opId: 'op-1', path: 'public/hero.png' } }
    });
    const card = new AssetCard('k', image(), 'public/hero.png', w.ask, () => {});
    card.init(undefined);
    expect(card.automatic).toBe(true);
    expect(await card.save({ trigger: 'auto', loopId: 'loop-1' })).toBe('saved');
    expect(w.calls.find((c) => c.type === 'chat-write-binary')).toEqual({
      type: 'chat-write-binary',
      path: 'public/hero.png',
      data: 'iVBORw==',
      trigger: 'auto',
      loopId: 'loop-1'
    });
    expect(card.state).toBe('applied');
    expect(editSummary([], [card]).applied).toEqual(['public/hero.png (image)']);
    await card.undo();
    expect(card.state).toBe('undone');
  });

  it('isn’t saved on its own without a path from the chat', async () => {
    const w = worker();
    const card = new AssetCard('k', image(), null, w.ask, () => {});
    card.init(undefined);
    expect(card.automatic).toBe(false);
    await autoSave([card]);
    expect(w.calls.filter((c) => c.type === 'chat-write-binary')).toEqual([]);
  });

  it('asks before replacing a file on a click, and replaces it with its hash on the second', async () => {
    const w = worker({
      'chat-stat': { ok: true, result: { size: 3, hash: HASH } },
      'chat-write-binary': { ok: true, result: { opId: 'op-2', kind: 'modify', hash: HASH } }
    });
    const card = new AssetCard('k', image(), 'public/hero.png', w.ask, () => {});
    card.init(undefined);
    expect(await card.save()).toBe('held');
    expect(await card.save()).toBe('saved');
    expect(w.calls.find((c) => c.type === 'chat-write-binary')).toMatchObject({
      baseHash: HASH,
      trigger: 'click'
    });
  });

  it('says why when the image can’t be saved under that name', async () => {
    const w = worker();
    const card = new AssetCard('k', image(), 'public/hero.svg', w.ask, () => {});
    card.init(undefined);
    expect(await card.save({ trigger: 'auto' })).toBe('held');
    expect(editSummary([], [card]).held).toEqual([
      { path: 'public/hero.svg (image)', hold: 'blocked', reason: 'not saved' }
    ]);
  });
});

describe('AssetCard: an image the page won’t hand over', () => {
  const remote = (src: string) => {
    const img = document.createElement('img');
    img.src = src;
    return img;
  };

  it('offers Download from URL for an https image, which downloads only on a click', async () => {
    const w = worker({
      'chat-stat': notFound,
      'chat-download': {
        ok: true,
        result: { opId: 'op-3', kind: 'create', hash: HASH, size: 2048, mime: 'image/png' }
      }
    });
    const card = new AssetCard(
      'k',
      remote('https://cdn.example/files/hero.png?sig=abc'),
      'public/hero.png',
      w.ask,
      () => {}
    );
    card.init(undefined);
    // Full auto tries to save it on its own: it can't, and nothing is downloaded.
    expect(await card.save({ trigger: 'auto' })).toBe('held');
    expect(w.calls.some((c) => c.type === 'chat-download')).toBe(false);
    await card.downloadFromUrl();
    expect(w.calls.find((c) => c.type === 'chat-download')).toEqual({
      type: 'chat-download',
      url: 'https://cdn.example/files/hero.png?sig=abc',
      path: 'public/hero.png'
    });
    expect(card.state).toBe('applied');
  });

  it('offers nothing to download for an image without an https address', async () => {
    const w = worker({ 'chat-stat': notFound });
    const card = new AssetCard(
      'k',
      remote('http://cdn.example/hero.png'),
      'public/hero.png',
      w.ask,
      () => {}
    );
    card.init(undefined);
    expect(await card.save()).toBe('failed');
    await card.downloadFromUrl();
    expect(w.calls.some((c) => c.type === 'chat-download')).toBe(false);
  });
});

describe('ReadCard and images', () => {
  it('reads an image as bytes to attach, and text files as text', async () => {
    const w = worker({
      'chat-read-binary': {
        ok: true,
        result: { data: 'iVBORw==', size: 4, hash: HASH, mime: 'image/png' }
      },
      'chat-read': { ok: true, result: { content: 'x\n', hash: HASH, eol: 'lf', bom: false } }
    });
    const card = new ReadCard('k', ['shot.png', 'src/a.ts'], w.ask, () => {});
    await card.init(undefined);
    expect(w.calls.find((c) => c.type === 'chat-read-binary')).toEqual({
      type: 'chat-read-binary',
      path: 'shot.png'
    });
    expect(card.contents()).toEqual({
      files: [{ path: 'src/a.ts', content: 'x\n' }],
      images: [{ path: 'shot.png', name: 'shot.png', mime: 'image/png', data: 'iVBORw==' }],
      refused: [],
      disconnected: false
    });
    expect(card.message().text).toContain('Attached image: shot.png.');
  });

  it('lists a protected image as refused, and sends nothing for it', async () => {
    const w = worker({
      'chat-read-binary': { ok: false, error: { code: 'denied', message: 'x' } }
    });
    const card = new ReadCard('k', ['.git/x.png'], w.ask, () => {});
    await card.init(undefined);
    expect(card.contents()).toMatchObject({
      images: [],
      refused: [{ path: '.git/x.png', reason: 'protected file' }]
    });
  });
});

describe('Also approve automatically, on the cards', () => {
  const edit = (suspectedPartial: boolean): ParsedEdit => ({
    path: 'src/a.ts',
    content: '// ...rest unchanged\n',
    suspectedPartial,
    fence: 0
  });

  it('applies a partial-looking file in Full auto only when allowed, saying so to the app', async () => {
    const w = worker({
      'chat-read': notFound,
      'chat-write': { ok: true, result: { opId: 'op-1', kind: 'create', hash: HASH } }
    });
    const held = new DiffCard('k', edit(true), w.ask, () => {});
    await held.init(undefined);
    await autoApply([held], 'loop-1');
    expect(held.hold).toBe('partial');
    expect(w.calls.filter((c) => c.type === 'chat-write')).toEqual([]);

    const approved = new DiffCard('k', edit(true), w.ask, () => {});
    await approved.init(undefined);
    await autoApply([approved], 'loop-1', { approvePartial: true });
    expect(approved.state).toBe('applied');
    expect(w.calls.find((c) => c.type === 'chat-write')).toMatchObject({
      trigger: 'auto',
      autoApproved: true
    });
  });

  it('never applies a file that changed on disk on its own', async () => {
    const w = worker({
      'chat-read': notFound,
      'chat-write': { ok: false, error: { code: 'exists', message: 'x' } }
    });
    const card = new DiffCard('k', edit(false), w.ask, () => {});
    await card.init(undefined);
    await autoApply([card], 'loop-1', { approvePartial: true });
    expect(card.state).toBe('pending');
    expect(card.hold).toBe('conflict');
  });

  it('sends a delete with Full auto’s trigger when asked, and marks the card auto', async () => {
    const w = worker({
      'chat-stat': { ok: true, result: { size: 1, hash: HASH } },
      'chat-delete': { ok: true, result: { opId: 'op-1' } }
    });
    const card = new ChangeCard('k', { kind: 'delete', path: 'old.ts' }, w.ask, () => {});
    await card.init(undefined);
    expect(await card.apply({ trigger: 'auto', loopId: 'loop-1' })).toBe(true);
    expect(w.calls.find((c) => c.type === 'chat-delete')).toEqual({
      type: 'chat-delete',
      path: 'old.ts',
      baseHash: HASH,
      trigger: 'auto',
      loopId: 'loop-1'
    });
    expect(card.auto).toBe(true);
  });
});
