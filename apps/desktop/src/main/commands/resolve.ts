import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter as posixDelimiter, isAbsolute, join, sep, win32 } from 'node:path';

export type Resolved =
  | { ok: true; file: string }
  | { ok: false; code: 'command-not-found' | 'project-binary' | 'invalid-command' };

export interface ResolveOptions {
  /** The project's real root. Commands run here, and nothing from inside it runs by name. */
  root: string;
  /** The PATH (and on Windows, PATHEXT) the command would get. */
  env: Readonly<Record<string, string>>;
  platform?: NodeJS.Platform;
}

const isInside = (child: string, parent: string, separator: string) =>
  child === parent || child.startsWith(parent.endsWith(separator) ? parent : parent + separator);

/** `./x`, `bin/x`, `/usr/bin/x`, `C:\x`: a path rather than a name to look up. */
export function isPathLike(word: string): boolean {
  return word.includes('/') || word.includes('\\');
}

function envValue(env: Readonly<Record<string, string>>, name: string): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? '' : (env[key] ?? '');
}

async function isExecutableFile(file: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    if (platform !== 'win32') await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns `argv[0]` into the absolute path of the file to run.
 *
 * A bare name is looked up on the PATH, skipping relative PATH entries (they would resolve
 * against the project). If what it finds is inside the project (a PATH entry pointing at
 * `node_modules/.bin`, say), it's refused with `project-binary`: an allowlisted name must
 * not quietly run a file the chat can write.
 *
 * A path (`./scripts/check.sh`, `node_modules/.bin/vitest`) only gets here when the
 * allowlist names that exact path, which is how a project-local program is allowed. A
 * relative one is taken from the project root and must stay inside it.
 */
export async function resolveExecutable(
  word: string,
  { root, env, platform = process.platform }: ResolveOptions
): Promise<Resolved> {
  const path = platform === 'win32' ? win32 : { isAbsolute, join, delimiter: posixDelimiter, sep };
  const separator = platform === 'win32' ? '\\' : sep;
  const realRoot = await realpath(root);

  if (isPathLike(word)) {
    if (!path.isAbsolute(word) && word.split(/[\\/]/).includes('..')) {
      return { ok: false, code: 'invalid-command' };
    }
    const file = path.isAbsolute(word) ? word : path.join(realRoot, word);
    if (!(await isExecutableFile(file, platform))) return { ok: false, code: 'command-not-found' };
    const real = await realpath(file);
    if (!path.isAbsolute(word) && !isInside(real, realRoot, separator)) {
      return { ok: false, code: 'invalid-command' };
    }
    return { ok: true, file: real };
  }

  const extensions =
    platform === 'win32'
      ? [
          ...(/\.[A-Za-z0-9]+$/.test(word) ? [''] : []),
          ...(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        ]
      : [''];
  const delimiter = platform === 'win32' ? ';' : posixDelimiter;
  for (const dir of envValue(env, 'PATH').split(delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, word + ext.toLowerCase());
      if (!(await isExecutableFile(candidate, platform))) continue;
      const real = await realpath(candidate);
      if (isInside(real, realRoot, separator)) return { ok: false, code: 'project-binary' };
      // A symlinked shim (Homebrew, Volta) runs as the link's name; keep the link.
      return { ok: true, file: candidate };
    }
  }
  return { ok: false, code: 'command-not-found' };
}

/** Batch files run through cmd.exe, which re-reads their arguments. */
export const isBatchFile = (file: string) => /\.(?:bat|cmd)$/i.test(file);

/**
 * Characters cmd.exe acts on even inside quotes, through a shim's `%*`. An argument for a
 * `.cmd`/`.bat` file that has one of these is refused rather than trusted to escaping
 * (the "BatBadBut" class of bugs). See PLAN.md, "Phase 5 decisions".
 */
export const BATCH_UNSAFE = /["%!^&|<>()\r\n]/;
