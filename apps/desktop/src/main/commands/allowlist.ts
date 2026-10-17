export interface AllowedCommandDefinition {
  executable: string;
  allowedSubcommands: string[];
  description: string;
}

export const ALLOWED_COMMANDS: Record<string, AllowedCommandDefinition> = {
  git: {
    executable: 'git',
    allowedSubcommands: ['status', 'diff', 'log', 'branch'],
    description: 'Git source control read-only inspection'
  },
  pnpm: {
    executable: 'pnpm',
    allowedSubcommands: ['test', 'lint', 'typecheck'],
    description: 'pnpm package manager verification scripts'
  },
  npm: {
    executable: 'npm',
    allowedSubcommands: ['test', 'run lint', 'run typecheck'],
    description: 'npm verification scripts'
  }
};

export function isCommandAllowed(command: string, args: string[]): boolean {
  const def = ALLOWED_COMMANDS[command];
  if (!def) return false;

  if (args.length === 0) return false;
  const subcommand = args[0] || '';

  // Prevent injection or metacharacters in arguments
  const dangerousChars = /[;&|`$<>()\\]/;
  for (const arg of args) {
    if (dangerousChars.test(arg)) {
      return false;
    }
  }

  return def.allowedSubcommands.some((allowed) => {
    const parts = allowed.split(' ');
    if (parts.length === 1) {
      return subcommand === parts[0];
    }
    return parts.every((p, idx) => args[idx] === p);
  });
}
