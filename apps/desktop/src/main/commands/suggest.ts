import { isValidAllowlistEntry } from '../settings';

/** Scripts worth offering, in the order they're listed. */
const SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'format:check', 'build'];

type Manager = 'pnpm' | 'yarn' | 'bun' | 'npm';

function managerOf(pkg: Record<string, unknown>, has: (file: string) => boolean): Manager {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const name = /^(pnpm|yarn|bun|npm)@/.exec(declared)?.[1] as Manager | undefined;
  if (name) return name;
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

/**
 * Allowlist entries to suggest when a project is opened for the first time: the usual
 * check scripts from its package.json, run with its package manager, plus read-only git.
 * The user confirms them in the app; nothing is allowed until then.
 */
export function suggestAllowlist(
  packageJson: string | null,
  has: (file: string) => boolean
): string[] {
  const suggestions: string[] = [];
  let pkg: Record<string, unknown> = {};
  try {
    const parsed: unknown = packageJson === null ? null : JSON.parse(packageJson);
    if (typeof parsed === 'object' && parsed !== null) pkg = parsed as Record<string, unknown>;
  } catch {
    // Not JSON. Suggest git only.
  }
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
