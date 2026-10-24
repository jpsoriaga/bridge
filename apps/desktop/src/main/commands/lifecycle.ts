/** Background processes are stopped after a sleep longer than this. */
export const LONG_SLEEP_MS = 30 * 60_000;

/** What `BackgroundLifecycle` needs of the runner. */
export interface StoppableProcesses {
  readonly runningCount: number;
  stopAll(): Promise<void>;
  /** Forgets the ones that ended too. */
  clear(): void;
}

/**
 * When background processes stop: the chat session ends, the project switches, the app
 * quits, or the computer sleeps for more than `LONG_SLEEP_MS`. Each stop kills the whole
 * tree of every process (see `BackgroundRunner`). `why` goes to the log.
 */
export class BackgroundLifecycle {
  private suspendedAt: number | null = null;
  private quitting = false;

  constructor(
    private readonly processes: StoppableProcesses,
    private readonly log: (why: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}

  private stop(why: string): Promise<void> {
    if (this.processes.runningCount === 0) return Promise.resolve();
    this.log(why);
    return this.processes.stopAll();
  }

  sessionEnded(): Promise<void> {
    return this.stop('the chat session ended');
  }

  /** A new project: its processes stop, and the old ones' records go. */
  async projectSwitched(): Promise<void> {
    await this.stop('the project switched');
    this.processes.clear();
  }

  suspended(): void {
    this.suspendedAt = this.now();
  }

  resumed(): Promise<void> {
    const at = this.suspendedAt;
    this.suspendedAt = null;
    return at !== null && this.now() - at > LONG_SLEEP_MS
      ? this.stop('the computer slept for more than 30 minutes')
      : Promise.resolve();
  }

  /**
   * The app is quitting. With processes running, returns a promise to wait for (quit again
   * once it settles); null when there's nothing to wait for. Only once: a second quit goes
   * through whatever is left.
   */
  beforeQuit(): Promise<void> | null {
    if (this.quitting || this.processes.runningCount === 0) return null;
    this.quitting = true;
    return this.stop('Bridge is quitting');
  }
}
