export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** 1s, 2s, 4s … capped at 30s. `attempt` starts at 0. */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_INITIAL_MS * 2 ** attempt);
}

/** Runs `task` after an exponentially growing delay. At most one run is pending. */
export class Reconnector {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly task: () => void) {}

  get pending(): boolean {
    return this.timer !== undefined;
  }

  /** Schedules the next attempt and returns its delay. */
  schedule(): number {
    this.cancel();
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.task();
    }, delay);
    return delay;
  }

  /** Call once connected, so the next drop starts again at 1s. */
  reset(): void {
    this.attempt = 0;
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
