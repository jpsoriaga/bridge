import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, Reconnector } from './backoff';

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
    ]);
  });
});

describe('Reconnector', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires each attempt after its backoff delay', () => {
    const fireTimes: number[] = [];
    const start = Date.now();
    const reconnector: Reconnector = new Reconnector(() => {
      fireTimes.push(Date.now() - start);
      if (fireTimes.length < 7) reconnector.schedule();
    });

    reconnector.schedule();
    vi.advanceTimersByTime(999);
    expect(fireTimes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fireTimes).toEqual([1_000]);

    vi.runAllTimers();
    // Cumulative: 1, +2, +4, +8, +16, +30, +30 seconds.
    expect(fireTimes).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000]);
  });

  it('starts over at 1s after reset', () => {
    const task = vi.fn();
    const reconnector = new Reconnector(task);
    expect(reconnector.schedule()).toBe(1_000);
    expect(reconnector.schedule()).toBe(2_000);
    expect(reconnector.schedule()).toBe(4_000);
    reconnector.reset();
    expect(reconnector.schedule()).toBe(1_000);
  });

  it('keeps at most one attempt pending', () => {
    const task = vi.fn();
    const reconnector = new Reconnector(task);
    reconnector.schedule();
    reconnector.schedule();
    vi.advanceTimersByTime(10_000);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('cancel stops the pending attempt', () => {
    const task = vi.fn();
    const reconnector = new Reconnector(task);
    reconnector.schedule();
    expect(reconnector.pending).toBe(true);
    reconnector.cancel();
    expect(reconnector.pending).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(task).not.toHaveBeenCalled();
  });
});
