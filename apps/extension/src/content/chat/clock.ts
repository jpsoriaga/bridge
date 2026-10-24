import type { LoopReport } from '@bridge/shared';
import { ClockMessage, MAX_CLOCK_WAIT_MS, type ClockRequest } from '../../messages';

/** The content script's end of `CLOCK_PORT`, as `chrome.runtime.Port` has it. */
export interface ClockPort {
  postMessage(message: ClockRequest): void;
  onMessage: { addListener(listener: (raw: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export interface ClockDeps {
  /** Opens the port to the worker, or null if the extension can't be reached. */
  connect(): ClockPort | null;
  hidden(): boolean;
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** After the port closes under a running loop, wait this long before opening it again. */
export const CLOCK_RECONNECT_MS = 1_000;

const running = (report: LoopReport | null) =>
  report !== null && report.state !== 'idle' && report.state !== 'stopped';

/**
 * Full auto's timing, kept on time in a hidden tab. Chrome holds a hidden page's timers
 * back (to once a minute after about 5 minutes), and a content script's timers are the
 * page's. So while a loop runs, waits are timed by the worker over `CLOCK_PORT` and the
 * worker sends a tick every second while the tab is hidden (`onTick`, the controller's
 * poll). Without a port (no loop yet, or the extension out of reach) it's the page's own
 * timers. If the port closes mid-wait, the wait carries on with a page timer.
 */
export class Clock {
  private port: ClockPort | null = null;
  private report: LoopReport | null = null;
  private nextId = 0;
  private readonly waits = new Map<number, { fn: () => void; until: number }>();
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  /** Called on each of the worker's ticks while the tab is hidden and a loop runs. */
  onTick: () => void = () => undefined;

  constructor(private readonly deps: ClockDeps) {}

  /** Resolves after `ms`. */
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  /** Calls `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void {
    const wait = Math.min(Math.max(0, Math.round(ms)), MAX_CLOCK_WAIT_MS);
    const port = this.port;
    if (!port || ms > MAX_CLOCK_WAIT_MS) {
      const timer = this.deps.setTimeout(fn, ms);
      return () => this.deps.clearTimeout(timer);
    }
    const id = this.nextId++;
    this.waits.set(id, { fn, until: this.deps.now() + wait });
    this.post({ type: 'clock-wait', id, ms: wait });
    return () => void this.waits.delete(id);
  }

  /** The loop reported: a running loop keeps the port open. */
  update(report: LoopReport): void {
    this.report = report;
    this.sync();
  }

  /** The tab was hidden or shown. */
  visibilityChanged(): void {
    this.sync();
  }

  private sync(): void {
    if (running(this.report) && !this.port) this.port = this.open();
    this.post({
      type: 'clock-state',
      running: running(this.report),
      hidden: this.deps.hidden(),
      report: this.report
    });
  }

  private open(): ClockPort | null {
    let port: ClockPort | null;
    try {
      port = this.deps.connect();
    } catch {
      // The extension was reloaded under the page: page timers it is.
      return null;
    }
    if (!port) return null;
    port.onMessage.addListener((raw) => {
      const parsed = ClockMessage.safeParse(raw);
      if (!parsed.success || this.port !== port) return;
      if (parsed.data.type === 'clock-tick') {
        this.post({ type: 'clock-tock' });
        this.onTick();
        return;
      }
      const wait = this.waits.get(parsed.data.id);
      if (!wait) return;
      this.waits.delete(parsed.data.id);
      wait.fn();
    });
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.drop();
    });
    return port;
  }

  private post(message: ClockRequest): void {
    if (!this.port) return;
    try {
      this.port.postMessage(message);
    } catch {
      this.drop();
    }
  }

  /**
   * The port closed (the worker stopped or restarted): what's still waiting finishes on
   * page timers, and a running loop opens the port again.
   */
  private drop(): void {
    this.port = null;
    const now = this.deps.now();
    for (const { fn, until } of this.waits.values()) {
      this.deps.setTimeout(fn, Math.max(0, until - now));
    }
    this.waits.clear();
    if (!running(this.report)) return;
    if (this.reconnect !== undefined) this.deps.clearTimeout(this.reconnect);
    this.reconnect = this.deps.setTimeout(() => {
      if (running(this.report) && !this.port) this.sync();
    }, CLOCK_RECONNECT_MS);
  }
}
