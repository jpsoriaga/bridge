import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';

/** How long the login shell gets to start and print its environment. */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000;
/** Output beyond this is junk from the shell's startup files, not an environment. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MARKER_VAR = 'BRIDGE_ENV_MARKER';

/**
 * Where the PATH for commands comes from, for Settings:
 * - `login-shell`: read from `$SHELL -ilc env` at startup (macOS and Linux)
 * - `inherited`: the app's own environment (Windows, where apps get the full PATH)
 * - `fallback`: reading the login shell failed, so the app's own PATH is used
 */
export type PathSource = 'login-shell' | 'inherited' | 'fallback';

export interface LoginEnv {
  source: PathSource;
  /** The PATH commands get unless the user overrides it. */
  path: string;
  /** Why the login shell couldn't be read, in plain words. Only for `fallback`. */
  warning?: string;
}

/**
 * The variables printed by `env` between two marker lines. A shell's startup files (`.zshrc`,
 * `.bash_profile`) can print anything before or after, so only what's between the markers
 * counts. A line that doesn't start a `NAME=` continues the previous value (a multi-line
 * variable). Returns null if either marker is missing.
 */
export function parseEnvOutput(output: string, marker: string): Record<string, string> | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(marker);
  const end = start === -1 ? -1 : lines.indexOf(marker, start + 1);
  if (start === -1 || end === -1) return null;
  const env: Record<string, string> = {};
  let last: string | null = null;
  for (const line of lines.slice(start + 1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      last = match[1]!;
      env[last] = match[2]!;
    } else if (last !== null) {
      env[last] += `\n${line}`;
    }
  }
  delete env[MARKER_VAR];
  return env;
}

/** A PATH worth using: at least one absolute entry, no control characters. */
export function isUsablePath(
  value: unknown,
  platform: NodeJS.Platform = process.platform
): value is string {
  const path = platform === 'win32' ? win32 : posix;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value) &&
    value.split(path.delimiter).some((dir) => path.isAbsolute(dir))
  );
}

/** `env` with its PATH replaced, whatever its spelling (Windows has `Path`). */
export function withPath(
  env: Readonly<Record<string, string | undefined>>,
  path: string
): Record<string, string | undefined> {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'PATH') delete out[key];
  out.PATH = path;
  return out;
}

export interface ReadLoginEnvOptions {
  /** The user's login shell. Defaults to `$SHELL`, then the account's shell. */
  shell?: string;
  timeoutMs?: number;
  /** The app's own environment: the starting point and the fallback. */
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

function defaultShell(env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env.SHELL) return env.SHELL;
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the PATH the user's login shell sets up. An app opened from the Dock or a desktop
 * launcher gets only the system PATH, so `pnpm` from nvm, Volta or Homebrew isn't found.
 *
 * Runs `$SHELL -ilc '<print marker>; env; <print marker>'` once, with no stdin, in its own
 * process group, and kills the group after `timeoutMs`. The script is a constant: the
 * marker reaches it through the environment, so nothing is spliced into shell text. Never
 * throws; on any failure it returns the app's own PATH with a warning.
 */
export async function readLoginEnv(options: ReadLoginEnvOptions = {}): Promise<LoginEnv> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const ownPath = env.PATH ?? '';
  if (platform === 'win32') return { source: 'inherited', path: ownPath };

  const fallback = (warning: string): LoginEnv => ({ source: 'fallback', path: ownPath, warning });
  const shell = options.shell ?? defaultShell(env);
  if (!shell || !isAbsolute(shell)) return fallback('Bridge couldn’t tell which shell you use.');

  const marker = `__BRIDGE_ENV_${randomBytes(12).toString('hex')}__`;
  const script = `printf '\\n%s\\n' "$${MARKER_VAR}"; env; printf '\\n%s\\n' "$${MARKER_VAR}"`;
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS;

  return new Promise<LoginEnv>((resolve) => {
    let settled = false;
    let output = '';
    let bytes = 0;
    const done = (result: LoginEnv) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-ilc', script], {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Its own process group: no controlling terminal to grab, and the timeout kills
        // anything the startup files left running.
        detached: true,
        env: { ...env, [MARKER_VAR]: marker }
      });
    } catch {
      done(fallback('Bridge couldn’t start your login shell.'));
      return;
    }

    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      done(
        fallback(
          `Your login shell took longer than ${Math.round(timeoutMs / 1000)}s to start, so Bridge used its own PATH.`
        )
      );
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        kill();
        done(
          fallback('Your login shell printed too much at startup, so Bridge used its own PATH.')
        );
        return;
      }
      output += chunk;
    });
    child.on('error', () => done(fallback('Bridge couldn’t start your login shell.')));
    child.on('close', () => {
      // Whatever the startup files left in the group goes too.
      kill();
      const parsed = parseEnvOutput(output, marker);
      if (!parsed) {
        done(fallback('Bridge couldn’t read the environment from your login shell.'));
      } else if (!isUsablePath(parsed.PATH)) {
        done(fallback('Your login shell didn’t set a PATH Bridge could use.'));
      } else {
        done({ source: 'login-shell', path: parsed.PATH });
      }
    });
  });
}

/**
 * Reads the login environment at most once per process. Every caller shares the first
 * call's result, so the user's shell never runs twice in one launch.
 */
export function loginEnvOnce(
  read: () => Promise<LoginEnv> = () => readLoginEnv()
): () => Promise<LoginEnv> {
  let pending: Promise<LoginEnv> | null = null;
  return () => (pending ??= read());
}
