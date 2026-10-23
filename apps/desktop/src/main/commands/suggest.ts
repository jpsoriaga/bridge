import { matchAllowlist, type InstallManager } from '@bridge/shared';
import { isValidAllowlistEntry } from '../settings';

/** Scripts worth offering, in the order they're listed. */
const SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'format:check', 'build'];

type Manager = InstallManager;

/** `packageManager` in package.json first, then the lockfile; npm with neither. */
function managerOf(pkg: Record<string, unknown>, has: (file: string) => boolean): Manager {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const name = /^(pnpm|yarn|bun|npm)@/.exec(declared)?.[1] as Manager | undefined;
  if (name) return name;
  if (has('package-lock.json')) return 'npm';
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lock') || has('bun.lockb')) return 'bun';
  return 'npm';
}

function scriptCommand(manager: Manager, script: string): string {
  switch (manager) {
    case 'npm':
      return script === 'test' ? 'npm test' : `npm run ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `${manager} ${script}`;
  }
}

function parsePackage(packageJson: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = packageJson === null ? null : JSON.parse(packageJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The project's install command (`npm install`, `pnpm install`, `yarn install` or
 * `bun install`), exact, with no `*`: it installs what package.json lists and can't add a
 * package. Null without a usable package.json.
 */
export function suggestInstall(
  packageJson: string | null,
  has: (file: string) => boolean
): string | null {
  const pkg = parsePackage(packageJson);
  return pkg === null ? null : `${managerOf(pkg, has)} install`;
}

/**
 * Allowlist entries to suggest when a project is opened for the first time: the install
 * command, the usual check scripts from its package.json, run with its package manager,
 * plus read-only git. The user confirms them in the app; nothing is allowed until then.
 */
export function suggestAllowlist(
  packageJson: string | null,
  has: (file: string) => boolean
): string[] {
  const suggestions: string[] = [];
  // Not JSON: suggest git only.
  const pkg = parsePackage(packageJson) ?? {};
  const install = suggestInstall(packageJson, has);
  if (install !== null) suggestions.push(install);
  const scripts =
    typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const manager = managerOf(pkg, has);
  for (const script of SCRIPTS) {
    if (typeof scripts[script] === 'string') suggestions.push(scriptCommand(manager, script));
  }
  suggestions.push('git status', 'git diff');
  return suggestions.filter(isValidAllowlistEntry);
}

/**
 * The install command to offer once for a project whose allowlist was confirmed before
 * Bridge suggested it: only if the list doesn't already allow it and the project hasn't
 * answered (or never needed) the note. Null otherwise.
 */
export function installNote(
  install: string | null,
  allowlist: readonly string[] | null,
  seen: boolean
): string | null {
  if (install === null || allowlist === null || seen) return null;
  return matchAllowlist(install.split(' '), allowlist) === null ? install : null;
}
