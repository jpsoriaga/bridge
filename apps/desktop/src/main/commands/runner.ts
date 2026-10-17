import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import crossSpawn from 'cross-spawn';
import { RUN_OUTPUT_CAP_BYTES, RUN_OUTPUT_CHUNK_CHARS, type RunResult } from '@bridge/shared';

/** After SIGTERM, a process group gets this long before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** After the command exits, its output pipes get this long to drain (a grandchild may hold them). */
export const DRAIN_MS = 1_000;
/** Live output is batched this long before it's sent. */
export const FLUSH_MS = 100;

/** CSI, OSC and two-character escape sequences. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Output as text a person or the chat can read: no colour codes, `\n` line breaks. */
export function cleanOutput(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\x1b/g, '');
}

/**
 * Keeps the first and the last `cap / 2` bytes of a stream, so a test run's summary at
 * the end survives a huge log in the middle.
 */
export class HeadTail {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;

  constructor(private readonly cap = RUN_OUTPUT_CAP_BYTES) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    const half = this.cap / 2;
    if (this.headBytes < half) {
      const take = chunk.subarray(0, half - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes - (this.tail[0]?.length ?? 0) >= half) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  get truncated(): boolean {
    return this.total > this.cap;
  }

  /** The kept bytes as text, with a note where the middle was dropped. */
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    let tail = Buffer.concat(this.tail);
    if (!this.truncated) return head + tail.toString('utf8');
    const half = this.cap / 2;
    tail = tail.subarray(Math.max(0, tail.length - half));
    const dropped = this.total - this.headBytes - tail.length;
    return `${head}\n[… ${dropped.toLocaleString('en-US')} bytes of output cut …]\n${tail.toString('utf8')}`;
  }
}

export interface RunSpec {
  /** The argv the user allowed. `argv[0]` is replaced by `file` when spawning. */
  argv: string[];
  /** Absolute path of the program, from `resolveExecutable`. */
  file: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface RunnerEvents {
  onOutput(runId: string, chunk: string): void;
  onExit(result: RunResult): void;
  /** A run started or ended. */
  onChange?(): void;
}

export interface RunnerDeps {
  platform?: NodeJS.Platform;
  /** Spawns a process. Defaults to Node's spawn, or cross-spawn on Windows. */
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => number;
}

interface Active {
  runId: string;
  argv: string[];
  child: ChildProcess;
  settle(status: RunResult['status']): void;
}

/**
 * Runs one command at a time with `shell: false`, no stdin, in its own process group
 * (POSIX) so a timeout or Stop kills everything it started. On Windows, `.cmd` shims
 * can't be spawned without a shell, so cross-spawn wraps them in `cmd.exe /d /s /c` with
 * every argument escaped; it's used only there. See PLAN.md, "Phase 5 decisions".
 */
export class CommandRunner {
  private active: Active | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: NonNullable<RunnerDeps['spawn']>;
  private readonly now: () => number;

  constructor(
    private readonly events: RunnerEvents,
    deps: RunnerDeps = {}
  ) {
    this.platform = deps.platform ?? process.platform;
    this.spawn = deps.spawn ?? (this.platform === 'win32' ? crossSpawn : nodeSpawn);
    this.now = deps.now ?? Date.now;
  }

  get current(): { runId: string; argv: string[] } | null {
    return this.active ? { runId: this.active.runId, argv: this.active.argv } : null;
  }

  /** Starts a run, or returns null if one is already going. */
  start(spec: RunSpec): { runId: string } | null {
    if (this.active) return null;
    const runId = randomUUID();
    const started = this.now();
    const output = new HeadTail();
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    let pending = '';
    let streamed = 0;
    let streaming = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      while (pending.length > 0) {
        const chunk = pending.slice(0, RUN_OUTPUT_CHUNK_CHARS);
        pending = pending.slice(chunk.length);
        this.events.onOutput(runId, chunk);
      }
    };
    const onData = (stream: 0 | 1) => (data: Buffer) => {
      output.push(data);
      if (!streaming) return;
      const room = RUN_OUTPUT_CAP_BYTES / 2 - streamed;
      const part = data.length > room ? data.subarray(0, room) : data;
      pending += cleanOutput(decoders[stream]!.write(part));
      streamed += part.length;
      if (streamed >= RUN_OUTPUT_CAP_BYTES / 2) {
        // Past the kept head the live view stops; the end arrives with the result.
        streaming = false;
        pending += '\n[… more output; the end is shown when the command finishes …]\n';
      }
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };

    let child: ChildProcess;
    try {
      child = this.spawn(spec.file, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Its own process group, so killing -pid reaches grandchildren.
        detached: this.platform !== 'win32'
      });
    } catch {
      this.finish(runId, spec.argv, started, 'failed', null, null, '', false);
      return { runId };
    }

    let done = false;
    let exited = false;
    /** Set by cancel or timeout: how the run will be reported, however it ends. */
    let stopping: RunResult['status'] | null = null;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (ended: RunResult['status']) => {
      if (done) return;
      done = true;
      const status = stopping ?? ended;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      flush();
      // Whatever it left behind (watchers, servers) goes too: one command at a time.
      this.killTree(child);
      const text = cleanOutput(output.text());
      this.finish(runId, spec.argv, started, status, exitCode, signal, text, output.truncated);
    };

    this.active = {
      runId,
      argv: spec.argv,
      child,
      settle: (status) => {
        // Cancel and timeout: kill first, report once the process is gone (or soon after).
        if (done || stopping) return;
        stopping = status;
        this.killTree(child);
        clearTimeout(timer);
        timer = setTimeout(() => settle(status), KILL_GRACE_MS + 500);
        if (exited) settle(status);
      }
    };
    this.events.onChange?.();

    child.stdout?.on('data', onData(0));
    child.stderr?.on('data', onData(1));
    child.once('error', () => settle('failed'));
    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      signal = sig;
      // Give the pipes a moment, in case a grandchild still holds them open.
      drainTimer = setTimeout(() => settle('exited'), DRAIN_MS);
    });
    child.once('close', () => settle('exited'));
    timer = setTimeout(
      () => this.active?.runId === runId && this.active.settle('timed-out'),
      spec.timeoutMs
    );
    return { runId };
  }

  /** Stops the run. Its `run_exit` says `cancelled`. */
  cancel(runId: string): boolean {
    if (!this.active || this.active.runId !== runId) return false;
    this.active.settle('cancelled');
    return true;
  }

  cancelAll(): void {
    this.active?.settle('cancelled');
  }

  private finish(
    runId: string,
    argv: string[],
    started: number,
    status: RunResult['status'],
    exitCode: number | null,
    signal: string | null,
    output: string,
    truncated: boolean
  ): void {
    if (this.active?.runId === runId) this.active = null;
    this.events.onExit({
      runId,
      argv,
      status,
      exitCode,
      signal,
      durationMs: Math.max(0, Math.round(this.now() - started)),
      output,
      truncated
    });
    this.events.onChange?.();
  }

  /** The whole tree: the process group on POSIX, `taskkill /T` on Windows. */
  private killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (this.platform === 'win32') {
      const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      try {
        nodeSpawn(taskkill, ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true
        }).on('error', () => undefined);
      } catch {
        // Already gone.
      }
      return;
    }
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
        return true;
      } catch {
        return false;
      }
    };
    if (signalGroup('SIGTERM')) {
      setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS).unref();
    }
  }
}
