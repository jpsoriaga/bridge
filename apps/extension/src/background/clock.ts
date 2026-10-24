import { PAUSE_REASON_TEXT, type LoopReport } from '@bridge/shared';
import { ClockRequest, type ClockMessage } from '../messages';

/** The worker's end of a tab's `CLOCK_PORT`, as `chrome.runtime.Port` has it. */
export interface ClockPeer {
  postMessage(message: ClockMessage): void;
  onMessage: { addListener(listener: (raw: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface TabClockState {
  running: boolean;
  hidden: boolean;
  report: LoopReport | null;
}

export interface ClockServeDeps {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  /** The tab said whether its loop runs and whether it's hidden. */
  onState(state: TabClockState): void;
  /** The port closed: the tab's content script is gone (closed, unloaded, discarded). */
  onGone(): void;
}

/** How often a hidden tab with a running loop gets a tick. */
export const CLOCK_TICK_MS = 1_000;

/**
 * Times a chat tab's waits and ticks with the worker's timers, which Chrome doesn't hold
 * back for a hidden tab. Every message is parsed; anything else is ignored.
 */
export function serveClock(port: ClockPeer, deps: ClockServeDeps): void {
  const waits = new Map<number, ReturnType<typeof setTimeout>>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const post = (message: ClockMessage) => {
    if (!open) return;
    try {
      port.postMessage(message);
    } catch {
      // The tab went; onDisconnect cleans up.
    }
  };
  const stopTicks = () => {
    if (ticker !== undefined) deps.clearInterval(ticker);
    ticker = undefined;
  };

  port.onMessage.addListener((raw) => {
    const parsed = ClockRequest.safeParse(raw);
    if (!parsed.success || !open) return;
    const message = parsed.data;
    switch (message.type) {
      case 'clock-wait': {
        const existing = waits.get(message.id);
        if (existing !== undefined) deps.clearTimeout(existing);
        // At most 100 waits in flight per tab; Full auto has one or two.
        if (waits.size >= 100 && existing === undefined) return;
        waits.set(
          message.id,
          deps.setTimeout(() => {
            waits.delete(message.id);
            post({ type: 'clock-wake', id: message.id });
          }, message.ms)
        );
        return;
      }
      case 'clock-state':
        if (message.running && message.hidden) {
          ticker ??= deps.setInterval(() => post({ type: 'clock-tick' }), CLOCK_TICK_MS);
        } else stopTicks();
        deps.onState({ running: message.running, hidden: message.hidden, report: message.report });
        return;
      case 'clock-tock':
        // Only here so the worker hears from the tab: that keeps it running.
        return;
    }
  });

  port.onDisconnect.addListener(() => {
    open = false;
    stopTicks();
    for (const timer of waits.values()) deps.clearTimeout(timer);
    waits.clear();
    deps.onGone();
  });
}

/**
 * A running loop's report once its tab is gone (closed, unloaded or discarded): paused with
 * `tab-closed`, so the app and the side panel say so instead of the run silently stopping.
 * Null for a loop that wasn't running.
 */
export function goneTabReport(report: LoopReport | undefined): LoopReport | null {
  if (!report || report.state === 'idle' || report.state === 'stopped') return null;
  if (report.state === 'paused' && report.reason === 'tab-closed') return null;
  return {
    loopId: report.loopId,
    state: 'paused',
    step: report.step,
    limit: report.limit,
    reason: 'tab-closed',
    event: { kind: 'paused', text: PAUSE_REASON_TEXT['tab-closed'] }
  };
}
