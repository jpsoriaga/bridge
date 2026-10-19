import {
  checkArgv,
  commandRefusal,
  deniedArgument,
  FILE_ERROR_MESSAGES,
  type FileErrorCode,
  type FileOutcome,
  type Mode,
  type RunParams,
  type RunStarted
} from '@bridge/shared';
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
  envPatterns: () => readonly string[];
  timeoutMs: () => number;
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

  async run(params: RunParams): Promise<FileOutcome<RunStarted>> {
    const refuse = (code: FileErrorCode) => {
      this.options.onRefused?.(params.argv, code);
      return fail(code);
    };
    const root = this.options.root();
    if (root === null) return refuse('no-project');
    if (params.trigger === 'auto' && this.options.mode() !== 'full-auto') return refuse('mode');
    if (checkArgv(params.argv) !== null) return refuse('invalid-command');
    const refusal = commandRefusal(params.argv, this.options.allowlist());
    if (refusal) return refuse(refusal);
    if (this.options.runner.current) return fail('busy');

    const platform = this.options.platform ?? process.platform;
    const env = filterEnv((await this.options.env?.()) ?? process.env, this.options.envPatterns());
    const resolved = await resolveExecutable(params.argv[0]!, { root, env, platform });
    if (!resolved.ok) return refuse(resolved.code);
    // The program as it really is on disk, too: an allowlisted path to a copy of npx is npx.
    if (deniedArgument([resolved.file, ...params.argv.slice(1)]) !== null) {
      return refuse('denied-flag');
    }
    if (
      platform === 'win32' &&
      isBatchFile(resolved.file) &&
      params.argv.slice(1).some((arg) => BATCH_UNSAFE.test(arg))
    ) {
      return refuse('invalid-command');
    }

    const started = this.options.runner.start({
      argv: [...params.argv],
      file: resolved.file,
      cwd: root,
      env,
      timeoutMs: this.options.timeoutMs()
    });
    return started ? { ok: true, result: started } : fail('busy');
  }

  cancel(runId: string): FileOutcome<{ cancelled: boolean }> {
    return this.options.runner.cancel(runId)
      ? { ok: true, result: { cancelled: true } }
      : fail('unknown-run');
  }
}
