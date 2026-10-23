// The worker's recent events (connection changes, pairing steps, sessions, Full auto
// states), for the side panel's Copy diagnostics. Memory only: never chrome.storage, so it
// starts empty whenever Chrome stops and restarts the worker. Events only, never file
// contents, output, codes or keys; every line still goes through the shared `logLine`.

import { logLine } from '@bridge/shared';

const MAX_LINES = 200;

export class WorkerLog {
  private readonly lines: string[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  info(message: string): void {
    this.add('info', message);
  }

  warn(message: string): void {
    this.add('warn', message);
  }

  /** The last `count` lines, oldest first. */
  recent(count: number): string[] {
    return this.lines.slice(-count);
  }

  private add(level: 'info' | 'warn', message: string): void {
    this.lines.push(`${this.now().toISOString()} ${level.padEnd(5)} ${logLine(message)}`);
    if (this.lines.length > MAX_LINES) this.lines.shift();
  }
}
