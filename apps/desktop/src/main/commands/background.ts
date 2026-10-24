import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from 'cross-spawn';
import {
  BACKGROUND_LINE_CHARS,
  BACKGROUND_LOG_LINES,
  formatArgv,
  MAX_BACKGROUND_PROCESSES,
  readyUrl,
  redactSecrets,
  type BackgroundLogs,
  type BackgroundProcess
} from '@bridge/shared';
import { cleanOutput, KILL_GRACE_MS, killTree, TURN_BUDGET_BYTES } from './runner';

/** Ended processes kept in the list (with their logs), so the chat can see why one died. */
const MAX_ENDED = 5;

export interface BackgroundSpec {
  /** The argv the user allowed. `argv[0]` is replaced by `file` when spawning. */
  argv: string[];
  /** Absolute path of the program, from `resolveExecutable`. */
  file: string;
  cwd: string;
  env: Record<string, string>;
}

export interface BackgroundDeps {
  platform?: NodeJS.Platform;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
}

interface Proc {
  info: BackgroundProcess;
  argv: string[];
  child: ChildProcess | null;
  /** Kept lines, already redacted. `first` is the number of `lines[0]`. */
  lines: string[];
  first: number;
  partial: string[];
  /** Resolves when the process is gone. */
  gone: Promise<void>;
  stopping: boolean;
}

/**
 * Long-running commands (dev servers, watchers): no timeout, kept across chat turns, at most
 * `MAX_BACKGROUND_PROCESSES` at once. Each is spawned like a `@@RUN` command (`shell: false`,
 * no stdin, its own process group on POSIX, cross-spawn only on Windows) and stopped by
 * killing its whole tree. The last `BACKGROUND_LOG_LINES` lines of output are kept, redacted,
 * and the first local URL it prints is its address. See PLAN.md, "1.3.0 decisions".
 */
export class BackgroundRunner {
  private procs: Proc[] = [];
  private readonly platform: NodeJS.Platform;
  private readonly spawn: NonNullable<BackgroundDeps['spawn']>;
  private readonly now: () => number;

  constructor(
    /** A process started, found its URL, or ended. Not called per line. */
    private readonly onChange: () => void,
    deps: BackgroundDeps = {}
  ) {
    this.platform = deps.platform ?? process.platform;
    this.spawn = deps.spawn ?? (this.platform === 'win32' ? crossSpawn : nodeSpawn);
    this.now = deps.now ?? Date.now;
  }

  /** Every process this session knows, running first, as `status` reports them. */
  list(): BackgroundProcess[] {
    return this.procs.map((proc) => ({ ...proc.info }));
  }

  get runningCount(): number {
    return this.procs.filter((proc) => proc.info.state === 'running').length;
  }

  /** The running process for `argv`, if any. */
  running(argv: readonly string[]): BackgroundProcess | null {
    const command = formatArgv(argv);
    return (
      this.procs.find((p) => p.info.command === command && p.info.state === 'running')?.info ?? null
    );
  }

  /** A process by id, or by the command that started it (the newest one). */
  find(ref: { procId?: string; argv?: readonly string[] }): BackgroundProcess | null {
    return this.lookup(ref)?.info ?? null;
  }

  private lookup(ref: { procId?: string; argv?: readonly string[] }): Proc | undefined {
    if (ref.procId) return this.procs.find((p) => p.info.procId === ref.procId);
    if (!ref.argv) return undefined;
    const command = formatArgv(ref.argv);
    const matches = this.procs.filter((p) => p.info.command === command);
    return matches.find((p) => p.info.state === 'running') ?? matches.at(-1);
  }

  /**
   * Starts a process. One already running for the same command is stopped first (a
   * restart, never a duplicate). Null when `MAX_BACKGROUND_PROCESSES` others are running.
   */
  async start(spec: BackgroundSpec): Promise<{ procId: string; restarted: boolean } | null> {
    const command = formatArgv(spec.argv);
    const previous = this.procs.find(
      (p) => p.info.command === command && p.info.state === 'running'
    );
    if (!previous && this.runningCount >= MAX_BACKGROUND_PROCESSES) return null;
    if (previous) await this.stopProc(previous);
    // Its last run's record goes: the new one takes its place.
    this.procs = this.procs.filter((p) => p.info.command !== command);

    const procId = randomUUID();
    let resolveGone!: () => void;
    const proc: Proc = {
      info: {
        procId,
        command,
        state: 'running',
        url: null,
        startedAt: this.now(),
        endedAt: null,
        exitCode: null,
        signal: null
      },
      argv: [...spec.argv],
      child: null,
      lines: [],
      first: 0,
      partial: ['', ''],
      gone: new Promise((resolve) => (resolveGone = resolve)),
      stopping: false
    };
    this.procs.unshift(proc);

    let child: ChildProcess;
    try {
      child = this.spawn(spec.file, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so stopping it reaches everything it started.
        detached: this.platform !== 'win32'
      });
    } catch {
      this.end(proc, null, null);
      resolveGone();
      return { procId, restarted: previous !== undefined };
    }
    proc.child = child;

    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const budget = [0, 0];
    const onData = (stream: 0 | 1, source: NodeJS.ReadableStream) => (data: Buffer) => {
      budget[stream]! += data.length;
      if (budget[stream]! >= TURN_BUDGET_BYTES && !source.isPaused()) {
        // A process that prints without end blocks on its pipe instead of the app spinning.
        source.pause();
        setImmediate(() => {
          budget[stream] = 0;
          if (proc.info.state === 'running') source.resume();
        });
      }
      this.take(proc, stream, decoders[stream]!.write(data));
    };
    child.stdout?.on('data', onData(0, child.stdout));
    child.stderr?.on('data', onData(1, child.stderr));
    let settled = false;
    const settle = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      for (const stream of [0, 1] as const) this.take(proc, stream, decoders[stream]!.end(), true);
      // Whatever it left in its group (a watcher's helper) goes too.
      killTree(child, this.platform);
      this.end(proc, code, signal);
      resolveGone();
    };
    child.once('error', () => settle(null, null));
    child.once('exit', (code, signal) => settle(code, signal));
    this.prune();
    this.onChange();
    return { procId, restarted: previous !== undefined };
  }

  /** Stops one process and waits until it's gone. False if it wasn't running. */
  async stop(ref: { procId?: string; argv?: readonly string[] }): Promise<boolean> {
    const proc = this.lookup(ref);
    if (!proc || proc.info.state !== 'running') return false;
    await this.stopProc(proc);
    return true;
  }

  /** Stops every process: session end, project switch, quit, a long sleep. */
  async stopAll(): Promise<void> {
    await Promise.all(
      this.procs.filter((p) => p.info.state === 'running').map((p) => this.stopProc(p))
    );
  }

  /** Forgets ended processes too (a new project). Running ones should be stopped first. */
  clear(): void {
    const before = this.procs.length;
    this.procs = this.procs.filter((p) => p.info.state === 'running');
    if (this.procs.length !== before) this.onChange();
  }

  /** A process's log: lines numbered from 0, `since` onwards or the last `tail`. */
  logs(
    ref: { procId?: string; argv?: readonly string[] },
    options: { since?: number; tail?: number } = {}
  ): BackgroundLogs | null {
    const proc = this.lookup(ref);
    if (!proc) return null;
    const next = proc.first + proc.lines.length;
    let from = proc.first;
    if (options.since !== undefined) from = Math.max(proc.first, Math.min(options.since, next));
    if (options.tail !== undefined) from = Math.max(from, next - options.tail);
    return {
      procId: proc.info.procId,
      command: proc.info.command,
      lines: proc.lines.slice(from - proc.first),
      first: from,
      next
    };
  }

  private async stopProc(proc: Proc): Promise<void> {
    if (proc.info.state === 'running' && proc.child) {
      proc.stopping = true;
      killTree(proc.child, this.platform);
    }
    // SIGKILL follows SIGTERM after the grace period; give it a little longer to land.
    await Promise.race([
      proc.gone,
      new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS + 1_000).unref())
    ]);
    if (proc.info.state === 'running') this.end(proc, null, 'SIGKILL');
  }

  /** Output from one stream: complete lines are kept, the rest waits for its line break. */
  private take(proc: Proc, stream: 0 | 1, text: string, flush = false): void {
    const parts = (proc.partial[stream] + cleanOutput(text)).split('\n');
    proc.partial[stream] = flush ? '' : parts.pop()!;
    if (flush && parts.at(-1) === '') parts.pop();
    for (const raw of parts) {
      const line = redactSecrets(raw.slice(0, BACKGROUND_LINE_CHARS)).text.slice(
        0,
        BACKGROUND_LINE_CHARS
      );
      proc.lines.push(line);
      if (proc.lines.length > BACKGROUND_LOG_LINES) {
        proc.lines.shift();
        proc.first += 1;
      }
      if (proc.info.url === null && proc.info.state === 'running') {
        const url = readyUrl(raw);
        if (url) {
          proc.info.url = url;
          this.onChange();
        }
      }
    }
  }

  private end(proc: Proc, code: number | null, signal: string | null): void {
    if (proc.info.state !== 'running') return;
    proc.info.state = proc.stopping ? 'stopped' : 'exited';
    proc.info.exitCode = code;
    proc.info.signal = signal;
    proc.info.endedAt = this.now();
    this.prune();
    this.onChange();
  }

  /** Keeps every running process and the newest few that ended. */
  private prune(): void {
    let ended = 0;
    this.procs = this.procs.filter((p) => p.info.state === 'running' || ++ended <= MAX_ENDED);
  }
}
