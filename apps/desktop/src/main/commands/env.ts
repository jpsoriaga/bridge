/**
 * Environment variables a command never sees, as case-insensitive globs (`*` = anything).
 * Users can add to this in Settings but not remove from it. The rest of the user's
 * environment is inherited, because tools need PATH, HOME, proxies and the like.
 */
export const DEFAULT_ENV_DENYLIST: readonly string[] = [
  '*TOKEN*',
  '*SECRET*',
  '*KEY*',
  '*PASSWORD*',
  'AWS_*',
  'OPENAI_*',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'ELECTRON_RUN_AS_NODE'
];

/** Always set for commands: non-interactive, and no colour codes to strip. */
export const FORCED_ENV: Readonly<Record<string, string>> = { CI: '1', FORCE_COLOR: '0' };

export const MAX_ENV_PATTERNS = 50;

/** A pattern the user may add: a variable name with optional `*` wildcards. */
export function isValidEnvPattern(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_*]{1,100}$/.test(value) && value !== '*';
}

function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

/** The environment a command runs with: `env` minus every match, plus `FORCED_ENV`. */
export function filterEnv(
  env: Readonly<Record<string, string | undefined>>,
  extraPatterns: readonly string[] = []
): Record<string, string> {
  const deny = [...DEFAULT_ENV_DENYLIST, ...extraPatterns.filter(isValidEnvPattern)].map(
    globToRegExp
  );
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // Windows has env names like "=C:" for per-drive folders. Keep them out too.
    if (name.startsWith('=') || deny.some((re) => re.test(name))) continue;
    out[name] = value;
  }
  // Windows env names ignore case: drop any spelling of the forced names first.
  for (const name of Object.keys(out)) {
    if (Object.keys(FORCED_ENV).some((forced) => forced.toLowerCase() === name.toLowerCase())) {
      delete out[name];
    }
  }
  return { ...out, ...FORCED_ENV };
}
