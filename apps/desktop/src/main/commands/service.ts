import {
  checkArgv,
  isInstallCommand,
  commandRefusal,
  deniedArgument,
  FILE_ERROR_MESSAGES,
  matchAllowlist,
  type BackgroundLogs,
  type BackgroundLogsParams,
  type BackgroundStarted,
  type BackgroundStartParams,
  type BackgroundStopParams,
  type BackgroundStopped,
  type FileErrorCode,
  type FileOutcome,
  type Mode,
  type RunParams,
  type RunStarted
} from '@bridge/shared';
import type { BackgroundRunner } from './background';
import { filterEnv } from './env';
import { BATCH_UNSAFE, isBatchFile, resolveExecutable } from './resolve';
import type { CommandRunner } from './runner';

export interface CommandServiceOptions {
  runner: CommandRunner;
  /** The open project's real root, or null. */
  root: () => string | null;
  mode: () => Mode;
  /** The open project's confirmed allowlist (empty until confirmed). */
  allowlist: () => readonly string[];
  /** The allowlist entries that are background processes: `@@START` only, never `@@RUN`. */
  background?: () => readonly string[];
  /** Runs background processes. Without it, every `bg_start` is refused. */
  processes?: BackgroundRunner;
  envPatterns: () => readonly string[];
  timeoutMs: () => number;
  /** For `<manager> install`; `timeoutMs` when not given. */
  installTimeoutMs?: () => number;
  /** The environment commands start from (with the login shell's PATH, once it's read). */
  env?: () =>
    | Readonly<Record<string, string | undefined>>
    | Promise<Readonly<Record<string, string | undefined>>>;
  platform?: NodeJS.Platform;
  /** A run was refused: for the activity list. */
  onRefused?: (argv: readonly string[], code: FileErrorCode) => void;
}

const fail = (code: FileErrorCode) => ({
  ok: false as const,
  error: { code, message: FILE_ERROR_MESSAGES[code] }
});

/**
 * `run` and `run_cancel` from the extension. Everything is checked here, whatever the
 * extension already checked: the mode for automatic runs, every word of the argv, the
 * allowlist, one command at a time, and where the program really is.
 */
export class CommandService {
  constructor(private readonly options: CommandServiceOptions) {}

  /** Whether `argv` matches an allowlist entry the user marked as a background process. */
  private isBackground(argv: readonly string[]): boolean {
    const entry = matchAllowlist(argv, this.options.allowlist());
    return entry !== null && (this.options.background?.() ?? []).includes(entry);
  }

  /**
   * The checks every command gets first, one-off or background: a project, the mode for
   * automatic ones, every word, the allowlist and denied options, and the entry's kind.
   */
  private check(
    argv: readonly string[],
    trigger: 'click' | 'auto',
    kind: 'task' | 'background'
  ): { ok: true; root: string } | { ok: false; code: FileErrorCode } {
    const root = this.options.root();
    if (root === null) return { ok: false, code: 'no-project' };
    if (trigger === 'auto' && this.options.mode() !== 'full-auto')
      return { ok: false, code: 'mode' };
    if (checkArgv(argv) !== null) return { ok: false, code: 'invalid-command' };
    const refusal = commandRefusal(argv, this.options.allowlist());
    if (refusal) return { ok: false, code: refusal };
    // A dev server never finishes, so `@@RUN` would only time out; a one-off isn't started
    // in the background either. The user picks the kind in the app.
    const background = this.isBackground(argv);
    if (kind === 'task' && background) return { ok: false, code: 'background-only' };
    if (kind === 'background' && !background) return { ok: false, code: 'not-background' };
    return { ok: true, root };
  }

  /** Where the program really is, with the environment it gets. */
  private async locate(
    argv: readonly string[],
    root: string
  ): Promise<
    { ok: true; file: string; env: Record<string, string> } | { ok: false; code: FileErrorCode }
  > {
    const platform = this.options.platform ?? process.platform;
    const env = filterEnv((await this.options.env?.()) ?? process.env, this.options.envPatterns());
    const resolved = await resolveExecutable(argv[0]!, { root, env, platform });
    if (!resolved.ok) return { ok: false, code: resolved.code };
    // The program as it really is on disk, too: an allowlisted path to a copy of npx is npx.
    if (deniedArgument([resolved.file, ...argv.slice(1)]) !== null) {
      return { ok: false, code: 'denied-flag' };
    }
    if (
      platform === 'win32' &&
      isBatchFile(resolved.file) &&
      argv.slice(1).some((arg) => BATCH_UNSAFE.test(arg))
    ) {
      return { ok: false, code: 'invalid-command' };
    }
    return { ok: true, file: resolved.file, env };
  }

  async run(params: RunParams): Promise<FileOutcome<RunStarted>> {
    const refuse = (code: FileErrorCode) => {
      this.options.onRefused?.(params.argv, code);
      return fail(code);
    };
    const checked = this.check(params.argv, params.trigger, 'task');
    if (!checked.ok) return refuse(checked.code);
    if (this.options.runner.current) return fail('busy');
    const located = await this.locate(params.argv, checked.root);
    if (!located.ok) return refuse(located.code);

    const started = this.options.runner.start({
      argv: [...params.argv],
      file: located.file,
      cwd: checked.root,
      env: located.env,
      timeoutMs:
        isInstallCommand(params.argv) && this.options.installTimeoutMs
          ? this.options.installTimeoutMs()
          : this.options.timeoutMs()
    });
    return started ? { ok: true, result: started } : fail('busy');
  }

  /**
   * `@@START`: a background entry, checked like any command, then started with no timeout.
   * Already running: restarted. At the cap: `too-many`.
   */
  async start(params: BackgroundStartParams): Promise<FileOutcome<BackgroundStarted>> {
    const refuse = (code: FileErrorCode) => {
      this.options.onRefused?.(params.argv, code);
      return fail(code);
    };
    const processes = this.options.processes;
    if (!processes) return refuse('not-background');
    const checked = this.check(params.argv, params.trigger, 'background');
    if (!checked.ok) return refuse(checked.code);
    const located = await this.locate(params.argv, checked.root);
    if (!located.ok) return refuse(located.code);
    const started = await processes.start({
      argv: [...params.argv],
      file: located.file,
      cwd: checked.root,
      env: located.env
    });
    return started ? { ok: true, result: started } : refuse('too-many');
  }

  /** `@@STOP`: stops a background process. Never refused for the mode: stopping is safe. */
  async stop(params: BackgroundStopParams): Promise<FileOutcome<BackgroundStopped>> {
    const processes = this.options.processes;
    if (!processes || (!params.procId && !params.argv)) return fail('unknown-process');
    return { ok: true, result: { stopped: await processes.stop(params) } };
  }

  /** `@@LOGS`: a background process's recent lines (already redacted). */
  logs(params: BackgroundLogsParams): FileOutcome<BackgroundLogs> {
    const found =
      params.procId || params.argv
        ? this.options.processes?.logs(params, {
            ...(params.since !== undefined && { since: params.since }),
            ...(params.tail !== undefined && { tail: params.tail })
          })
        : null;
    return found ? { ok: true, result: found } : fail('unknown-process');
  }

  cancel(runId: string): FileOutcome<{ cancelled: boolean }> {
    return this.options.runner.cancel(runId)
      ? { ok: true, result: { cancelled: true } }
      : fail('unknown-run');
  }
}
