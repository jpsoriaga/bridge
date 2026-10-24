// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig } from '@bridge/shared';
import type { WorkerRequest } from '../../messages';
import type { Ask } from './cards/diff-card';
import { ChatController } from './controller';

// The controller against a saved chat page: long conversations that unmount and remount
// messages, other tabs owning the session, and the extension reloading under the page.

const FIXTURES = join(__dirname, '../../../fixtures/chatgpt');
const page = readFileSync(join(FIXTURES, 'single-edit.html'), 'utf8');
const interrupted = readFileSync(join(FIXTURES, 'interrupted.html'), 'utf8');

const CONFIG: BridgeConfig = {
  mode: 'auto-apply',
  allowlist: [],
  stepLimit: 10,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  running: null,
  background: [],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
};

let calls: WorkerRequest[];
let session: 'active' | 'elsewhere';
let controller: ChatController | null;
/** What `chat-sync` says the app's config is: null while it's out of reach. */
let syncConfig: BridgeConfig | null;

const ask = vi.fn(async (request: WorkerRequest) => {
  calls.push(request);
  switch (request.type) {
    case 'chat-sync':
      return {
        connected: syncConfig !== null,
        session,
        config: syncConfig,
        chipCorner: 'bottom-right'
      };
    case 'card-get':
      return {};
    case 'chat-read':
      return { ok: false, error: { code: 'not-found', message: 'missing' } };
    case 'chat-write':
      return { ok: true, result: { opId: 'op-1', kind: 'create', hash: 'b'.repeat(64) } };
    case 'chat-move-here':
      session = 'active';
      return 'active';
    default:
      return true;
  }
}) as unknown as Ask;

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const hosts = (kind: string) => document.querySelectorAll(`[data-bridge-host="${kind}"]`);
const count = (type: WorkerRequest['type']) => calls.filter((c) => c.type === type).length;

beforeEach(() => {
  calls = [];
  session = 'active';
  syncConfig = CONFIG;
  controller = null;
  vi.stubGlobal('chrome', { runtime: { id: 'bridge-test', getURL: (p: string) => p } });
  history.replaceState(null, '', '/c/conv-1234abcd');
  // An empty conversation first, so the reply that lands next counts as new.
  document.body.innerHTML = '<main class="relative"></main><div id="composer"></div>';
});

afterEach(() => {
  controller?.invalidate();
  vi.unstubAllGlobals();
});

async function startWithNewReply(html = page): Promise<ChatController> {
  controller = new ChatController(ask);
  controller.start();
  await wait();
  document.querySelector('main')!.outerHTML = html;
  // The page swapped <main>; the next poll re-attaches.
  await wait(1_400);
  return controller;
}

describe('ChatController', () => {
  it('puts a card under a new reply and auto-applies it once', async () => {
    await startWithNewReply();
    expect(hosts('diff-card')).toHaveLength(1);
    expect(count('chat-write')).toBe(1);
  });

  it('moves cards to a remounted message without rebuilding or acting again', async () => {
    await startWithNewReply();
    const reads = count('chat-read');
    // A long conversation unmounts the message as it scrolls away, then mounts a copy.
    const message = document.querySelector('[data-message-author-role="assistant"]')!;
    const parent = message.parentElement!;
    const copy = message.cloneNode(true) as Element;
    copy.querySelectorAll('[data-bridge-host]').forEach((host) => host.remove());
    message.remove();
    await wait();
    parent.append(copy);
    await wait();
    expect(copy.querySelectorAll('[data-bridge-host="diff-card"]')).toHaveLength(1);
    expect(count('chat-read')).toBe(reads);
    expect(count('chat-write')).toBe(1);
  });

  it('takes every card and the chip off the page when the extension reloads', async () => {
    const c = await startWithNewReply();
    expect(hosts('diff-card').length).toBeGreaterThan(0);
    c.invalidate();
    expect(hosts('diff-card')).toHaveLength(0);
    expect(hosts('loop-chip')).toHaveLength(0);
    const notice = hosts('page-notice')[0] as HTMLElement | undefined;
    expect(notice?.hidden).toBe(false);
    // Nothing more goes to the (dead) worker.
    const before = calls.length;
    c.setSession('active');
    await wait();
    expect(calls.length).toBe(before);
  });

  it('notices a dead runtime on its own, without a failed request', async () => {
    await startWithNewReply();
    vi.stubGlobal('chrome', { runtime: {} });
    await wait(1_200);
    expect(hosts('diff-card')).toHaveLength(0);
    expect((hosts('page-notice')[0] as HTMLElement | undefined)?.hidden).toBe(false);
  });

  it('shows “active in another tab” with Move here, and cards stay off', async () => {
    session = 'elsewhere';
    controller = new ChatController(ask);
    controller.start();
    await wait();
    const notice = hosts('page-notice')[0] as HTMLElement | undefined;
    expect(notice?.hidden).toBe(false);
    document.querySelector('main')!.outerHTML = page;
    await wait(1_400);
    // Not the owner: nothing is parsed or applied here.
    expect(hosts('diff-card')).toHaveLength(0);
    expect(count('chat-write')).toBe(0);
  });

  it('tells the worker at once when Start session asks where the tab is after navigating', async () => {
    const chat = await startWithNewReply();
    expect(hosts('diff-card')).toHaveLength(1);
    const syncs = count('chat-sync');
    // A new chat, before the next poll: locate notices, drops the old cards and syncs.
    history.pushState(null, '', '/');
    expect(chat.locate()).toEqual({ conversationId: null, layout: 'ok' });
    expect(hosts('diff-card')).toHaveLength(0);
    expect(count('chat-sync')).toBe(syncs + 1);
    expect(calls.at(-1)).toMatchObject({ type: 'chat-sync', conversationId: null });
    // Another chat: the same, with its id.
    history.pushState(null, '', '/c/conv-5678efgh');
    expect(chat.locate().conversationId).toBe('conv-5678efgh');
    expect(calls.at(-1)).toMatchObject({ type: 'chat-sync', conversationId: 'conv-5678efgh' });
  });

  it('applies only the whole blocks of a cut-off reply, and offers a continuation', async () => {
    await startWithNewReply(interrupted);
    expect(hosts('diff-card')).toHaveLength(2);
    // Auto-apply wrote the finished file; the one the cut fell in waits, marked partial.
    const writes = calls.filter((c) => c.type === 'chat-write');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: 'src/one.ts' });
    expect(hosts('interrupt-card')).toHaveLength(1);
    // Nothing reads as a format slip: the reply was cut, not misformatted.
    expect(hosts('format-card')).toHaveLength(0);
  });
});

describe('ChatController after sleep', () => {
  afterEach(() => vi.useRealTimers());

  it('notices the computer slept, reconnects at once and looks at the conversation again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    controller = new ChatController(ask);
    controller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.some((c) => c.type === 'chat-sync' && 'wake' in c)).toBe(false);
    // Timers stop while the lid is closed: the next poll comes minutes late.
    vi.setSystemTime(Date.now() + 3 * 60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.filter((c) => c.type === 'chat-sync').at(-1)).toMatchObject({ wake: true });
  });
});

describe('ChatController and the app’s config', () => {
  it('acts on a reply that finished while the app was out of reach, once it’s back', async () => {
    // The cause of files and edits left waiting for a click in Full auto: a reply that
    // finished while the connection was down (a reconnect, after sleep) was dropped.
    syncConfig = null;
    const ctl = await startWithNewReply();
    expect(hosts('diff-card')).toHaveLength(1);
    expect(count('chat-write')).toBe(0);
    ctl.setConfig(CONFIG);
    await wait();
    expect(count('chat-write')).toBe(1);
    // Once only: another config push doesn't act again.
    ctl.setConfig({ ...CONFIG, instance: 'launch-1' });
    await wait();
    expect(count('chat-write')).toBe(1);
  });

  it('does nothing with such a reply when the app comes back in Manual', async () => {
    syncConfig = null;
    const ctl = await startWithNewReply();
    ctl.setConfig({ ...CONFIG, mode: 'manual' });
    await wait();
    expect(count('chat-write')).toBe(0);
  });
});
