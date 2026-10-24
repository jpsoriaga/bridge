import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConfig, LoopReport } from '@bridge/shared';
import { CLOCK_TICK_MS, goneTabReport, serveClock, type ClockPeer } from '../../background/clock';
import type { ClockMessage, ClockRequest } from '../../messages';
import { Clock, CLOCK_RECONNECT_MS, type ClockPort } from './clock';
import { FullAutoLoop, type LoopPage, type ReplyActions } from './loop';

const CONFIG: BridgeConfig = {
  mode: 'full-auto',
  allowlist: [],
  stepLimit: 10,
  pauseOnFailure: false,
  catchUpAfterSleep: true,
  uiGuidance: 'auto',
  running: null,
  background: [],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
};

const MINUTE = 60_000;

/**
 * Timers as Chrome runs them in a tab hidden for more than 5 minutes: each callback waits
 * for the next whole minute (intensive throttling). Visible, they run on time.
 */
function pageTimers(hidden: () => boolean) {
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const due = Date.now() + ms;
      const at = hidden() ? Math.ceil(due / MINUTE) * MINUTE : due;
      return setTimeout(fn, at - Date.now());
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
  };
}

/** Both ends of a clock port in memory, the worker's served by `serveClock`. */
function connectedPair(onState = vi.fn(), onGone = vi.fn()) {
  const toTab: ((raw: unknown) => void)[] = [];
  const toWorker: ((raw: unknown) => void)[] = [];
  const tabGone: (() => void)[] = [];
  const workerGone: (() => void)[] = [];
  const sent: ClockRequest[] = [];
  let open = true;
  const tab: ClockPort = {
    postMessage: (message) => {
      if (!open) throw new Error('closed');
      sent.push(message);
      for (const fn of toWorker) fn(structuredClone(message));
    },
    onMessage: { addListener: (fn) => void toTab.push(fn) },
    onDisconnect: { addListener: (fn) => void tabGone.push(fn) }
  };
  const peer: ClockPeer = {
    postMessage: (message: ClockMessage) => {
      if (!open) throw new Error('closed');
      for (const fn of toTab) fn(structuredClone(message));
    },
    onMessage: { addListener: (fn) => void toWorker.push(fn) },
    onDisconnect: { addListener: (fn) => void workerGone.push(fn) }
  };
  serveClock(peer, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (timer) => clearInterval(timer),
    onState,
    onGone
  });
  return {
    tab,
    peer: (raw: unknown) => toWorker.forEach((fn) => fn(raw)),
    sent,
    onState,
    onGone,
    /** The worker stopped: the tab's end closes. */
    workerStopped: () => {
      open = false;
      tabGone.forEach((fn) => fn());
    },
    /** The tab went: the worker's end closes. */
    tabClosed: () => {
      open = false;
      workerGone.forEach((fn) => fn());
    }
  };
}

const report = (state: LoopReport['state']): LoopReport => ({
  loopId: 'loop-1',
  state,
  step: 1,
  limit: 10
});

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Clock', () => {
  it('uses page timers until a loop runs, then the worker’s', async () => {
    const hidden = true;
    const pair = connectedPair();
    const connect = vi.fn(() => pair.tab);
    const clock = new Clock({
      connect,
      hidden: () => hidden,
      now: Date.now,
      ...pageTimers(() => hidden)
    });
    const early = vi.fn();
    clock.after(1_000, early);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    // Throttled: the page timer waits for the minute.
    expect(early).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(early).toHaveBeenCalledOnce();

    clock.update(report('waiting-reply'));
    expect(connect).toHaveBeenCalledOnce();
    expect(pair.onState).toHaveBeenLastCalledWith({
      running: true,
      hidden: true,
      report: report('waiting-reply')
    });
    const late = vi.fn();
    clock.after(1_000, late);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(late).toHaveBeenCalledOnce();
  });

  it('ticks every second only while the tab is hidden, and answers each tick', async () => {
    let hidden = false;
    const pair = connectedPair();
    const clock = new Clock({
      connect: () => pair.tab,
      hidden: () => hidden,
      now: Date.now,
      ...pageTimers(() => hidden)
    });
    const ticks = vi.fn();
    clock.onTick = ticks;
    clock.update(report('waiting-reply'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).not.toHaveBeenCalled();
    hidden = true;
    clock.visibilityChanged();
    await vi.advanceTimersByTimeAsync(5 * CLOCK_TICK_MS);
    expect(ticks).toHaveBeenCalledTimes(5);
    expect(pair.sent.filter((m) => m.type === 'clock-tock')).toHaveLength(5);
    clock.update(report('idle'));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ticks).toHaveBeenCalledTimes(5);
  });

  it('cancels a wait', async () => {
    const pair = connectedPair();
    const clock = new Clock({
      connect: () => pair.tab,
      hidden: () => true,
      now: Date.now,
      ...pageTimers(() => false)
    });
    clock.update(report('acting'));
    const fn = vi.fn();
    const cancel = clock.after(500, fn);
    cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('finishes a wait on a page timer when the worker stops, then reconnects', async () => {
    const pairs: ReturnType<typeof connectedPair>[] = [];
    const connect = vi.fn(() => {
      const pair = connectedPair();
      pairs.push(pair);
      return pair.tab;
    });
    const clock = new Clock({
      connect,
      hidden: () => false,
      now: Date.now,
      ...pageTimers(() => false)
    });
    clock.update(report('sending'));
    const fn = vi.fn();
    clock.after(2_000, fn);
    await vi.advanceTimersByTimeAsync(500);
    pairs[0]!.workerStopped();
    await vi.advanceTimersByTimeAsync(1_499);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CLOCK_RECONNECT_MS);
    expect(connect).toHaveBeenCalledTimes(2);
    // The restarted worker hears the loop's state again.
    expect(pairs[1]!.onState).toHaveBeenCalledWith(
      expect.objectContaining({ running: true, report: report('sending') })
    );
  });

  it('stays on page timers when the extension can’t be reached', () => {
    const clock = new Clock({
      connect: () => {
        throw new Error('Extension context invalidated.');
      },
      hidden: () => false,
      now: Date.now,
      ...pageTimers(() => false)
    });
    expect(() => clock.update(report('acting'))).not.toThrow();
  });
});

describe('serveClock', () => {
  it('ignores messages that don’t parse, and tells when the tab is gone', async () => {
    const pair = connectedPair();
    pair.peer({ type: 'clock-wait', id: -1, ms: 10 });
    pair.peer({ type: 'clock-wait', id: 1, ms: 10 * MINUTE });
    pair.peer({ type: 'clock-state', running: true });
    pair.peer('tick');
    expect(pair.onState).not.toHaveBeenCalled();
    pair.tabClosed();
    expect(pair.onGone).toHaveBeenCalledOnce();
  });

  it('pauses a running loop whose tab is gone, once', () => {
    expect(goneTabReport(report('waiting-reply'))).toEqual({
      loopId: 'loop-1',
      state: 'paused',
      step: 1,
      limit: 10,
      reason: 'tab-closed',
      event: { kind: 'paused', text: 'The chat tab was closed or unloaded.' }
    });
    const paused = goneTabReport(report('acting'))!;
    expect(goneTabReport(paused)).toBeNull();
    expect(goneTabReport(report('idle'))).toBeNull();
    expect(goneTabReport(report('stopped'))).toBeNull();
    expect(goneTabReport(undefined)).toBeNull();
  });
});

describe('Full auto in a tab hidden for 6 minutes', () => {
  /** A page whose composer takes 3s to be ready after each paste, like a "Pasted text" chip. */
  function page() {
    const state = { turns: 1, composer: '', readyAt: 0, sent: [] as { at: number }[] };
    const api: LoopPage = {
      conversationId: () => 'conv-1',
      userTurns: () => state.turns,
      composerText: () => state.composer,
      insert: (text) => {
        state.composer = text;
        state.readyAt = Date.now() + 3_000;
        return { ok: true, method: 'paste', chars: text.length };
      },
      attach: () => true,
      submit: () => {
        state.sent.push({ at: Date.now() });
        state.composer = '';
        state.turns += 1;
        return true;
      },
      composerBusy: () => Date.now() < state.readyAt,
      error: () => null,
      replyStatus: () => 'complete',
      replyLength: () => 0,
      stopReply: () => false,
      continueReply: () => false,
      online: () => true
    };
    return { state, api };
  }

  const editReply = (): ReplyActions => ({
    hasActions: true,
    done: false,
    formatIssues: false,
    markReminded: () => undefined,
    applyEdits: async () => undefined,
    edits: () => ({ applied: ['src/a.ts'], held: [] }),
    changes: () => ({ applied: [], pending: [] }),
    reads: [],
    readFiles: async () => ({ files: [], refused: [], disconnected: false }),
    markReadsSent: () => undefined,
    runs: [],
    interruption: null
  });

  function run(withWorker: boolean) {
    const hidden = () => true;
    const pair = connectedPair();
    const clock = new Clock({
      connect: () => (withWorker ? pair.tab : null),
      hidden,
      now: Date.now,
      ...pageTimers(hidden)
    });
    const { state, api } = page();
    const ticks = vi.fn();
    clock.onTick = ticks;
    const loop = new FullAutoLoop({
      page: api,
      config: () => CONFIG,
      report: (r) => clock.update(r),
      cancelRun: () => undefined,
      now: Date.now,
      sleep: (ms) => clock.sleep(ms),
      newId: () => 'loop-1'
    });
    return { loop, state, ticks };
  }

  it('still sends on time with the worker’s clock', async () => {
    const t = run(true);
    // A run starts at 0:30 and its first follow-up goes out.
    await vi.advanceTimersByTimeAsync(30_000);
    t.loop.onReply(editReply());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.state.sent).toHaveLength(1);
    expect(t.loop.state).toBe('waiting-reply');
    // Six minutes pass, hidden. The worker keeps ticking the whole time.
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(t.ticks.mock.calls.length).toBeGreaterThanOrEqual(6 * 60);
    // The next reply arrives at 6:40 (not on a minute): its follow-up waits only for the
    // composer (3s), not for Chrome's next minute.
    const at = Date.now();
    expect(at % MINUTE).not.toBe(0);
    t.loop.onReply(editReply());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(t.state.sent).toHaveLength(2);
    const took = t.state.sent[1]!.at - at;
    expect(took).toBeGreaterThanOrEqual(3_000);
    expect(took).toBeLessThan(3_500);
    expect(t.loop.step).toBe(2);
  });

  it('falls behind on page timers alone (what the worker’s clock fixes)', async () => {
    const t = run(false);
    await vi.advanceTimersByTimeAsync(30_000);
    t.loop.onReply(editReply());
    await vi.advanceTimersByTimeAsync(4_000);
    // The composer is ready after 3s, but the page's next timer runs at the minute.
    expect(t.state.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.state.sent).toHaveLength(1);
    expect(t.state.sent[0]!.at % MINUTE).toBe(0);
    expect(t.ticks).not.toHaveBeenCalled();
  });
});
