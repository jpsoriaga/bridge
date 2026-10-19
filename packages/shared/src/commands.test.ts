import { describe, expect, it } from 'vitest';
import {
  checkArgv,
  formatArgv,
  commandRefusal,
  deniedArgument,
  matchAllowlist,
  programName,
  MAX_COMMAND_CHARS,
  parseAllowlistEntry,
  parseCommand,
  truncateMiddle,
  type CommandRejection
} from './commands';

describe('parseCommand', () => {
  it.each([
    ['pnpm test', ['pnpm', 'test']],
    ['  pnpm   lint  ', ['pnpm', 'lint']],
    ['pnpm test -- --run "a b"', ['pnpm', 'test', '--', '--run', 'a b']],
    ["git diff -- 'src/my file.ts'", ['git', 'diff', '--', 'src/my file.ts']],
    ['git diff --stat=100', ['git', 'diff', '--stat=100']],
    ['node a\\ b.js', ['node', 'a b.js']],
    ['make VAR=1', ['make', 'VAR=1']],
    ['echo ~', ['echo', '~']]
  ])('turns %j into argv', (text, argv) => {
    expect(parseCommand(text)).toEqual({ ok: true, argv });
  });

  it.each<[string, CommandRejection]>([
    // Operators.
    ['pnpm test | tee out', 'operator'],
    ['pnpm test && rm -rf /', 'operator'],
    ['pnpm test || true', 'operator'],
    ['git diff; rm -rf /', 'operator'],
    ['git diff;rm', 'operator'],
    ['pnpm test > out.txt', 'operator'],
    ['pnpm test >> out.txt', 'operator'],
    ['pnpm test < in.txt', 'operator'],
    ['pnpm test 2>&1', 'operator'],
    ['pnpm test &', 'operator'],
    ['(pnpm test)', 'operator'],
    ['pnpm test |& cat', 'operator'],
    // Substitution and variables.
    ['echo $(id)', 'substitution'],
    ['echo `id`', 'substitution'],
    ['echo "$(id)"', 'substitution'],
    ['echo $HOME', 'substitution'],
    ['echo ${HOME}', 'substitution'],
    ["echo '$HOME'", 'substitution'],
    ['cat <(ls)', 'operator'],
    // Globs.
    ['ls *.ts', 'glob'],
    ['ls src/?.ts', 'glob'],
    ['ls [ab].ts', 'glob'],
    ['ls "*.ts"', 'glob'],
    // Environment assignments.
    ['FOO=1 pnpm test', 'env-assignment'],
    ['NODE_OPTIONS=--require=./evil.js pnpm test', 'env-assignment'],
    ['_X=1 ls', 'env-assignment'],
    // Lines, control characters, comments, size.
    ['pnpm test\nrm -rf /', 'newline'],
    ['pnpm test\r\nrm', 'newline'],
    ['pnpm test\rrm', 'newline'],
    ['pnpm\x00test', 'control'],
    ['pnpm\x1btest', 'control'],
    ['pnpm test # and then', 'comment'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['""', 'empty'],
    [`pnpm test ${'x'.repeat(MAX_COMMAND_CHARS)}`, 'too-long']
  ])('rejects %j', (text, reason) => {
    expect(parseCommand(text)).toEqual({ ok: false, reason });
  });

  it('accepts exactly 1,000 characters', () => {
    const text = `pnpm ${'x'.repeat(MAX_COMMAND_CHARS - 5)}`;
    expect(text).toHaveLength(MAX_COMMAND_CHARS);
    expect(parseCommand(text).ok).toBe(true);
  });

  it('keeps shell characters inside quotes as plain words (there is no shell)', () => {
    expect(parseCommand('git log --grep "a;b|c"')).toEqual({
      ok: true,
      argv: ['git', 'log', '--grep', 'a;b|c']
    });
  });
});

describe('checkArgv', () => {
  it('accepts what parseCommand produces', () => {
    for (const text of ['pnpm test', 'git log --grep "a;b|c"', 'make VAR=1']) {
      const parsed = parseCommand(text);
      expect(parsed.ok && checkArgv(parsed.argv)).toBeNull();
    }
  });

  it.each<[string[], CommandRejection]>([
    [[], 'empty'],
    [[''], 'empty'],
    [['pnpm', 'test\nrm'], 'newline'],
    [['pnpm', 'te\x00st'], 'control'],
    [['echo', '$(id)'], 'substitution'],
    [['echo', '`id`'], 'substitution'],
    [['ls', '*.ts'], 'glob'],
    [['FOO=1', 'ls'], 'env-assignment'],
    [['pnpm', 'x'.repeat(MAX_COMMAND_CHARS)], 'too-long'],
    [Array.from({ length: 101 }, () => 'a'), 'too-long']
  ])('rejects %j', (argv, reason) => {
    expect(checkArgv(argv)).toBe(reason);
  });
});

describe('matchAllowlist', () => {
  const allowlist = [
    'pnpm test *',
    'pnpm lint',
    'git status',
    'git diff *',
    './scripts/check.sh *'
  ];
  const argv = (text: string) => {
    const parsed = parseCommand(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.argv;
  };

  it.each([
    ['pnpm test', 'pnpm test *'],
    ['pnpm test -- --run', 'pnpm test *'],
    ['pnpm test src/a.test.ts', 'pnpm test *'],
    ['pnpm lint', 'pnpm lint'],
    ['git status', 'git status'],
    ['git diff --stat', 'git diff *'],
    ['./scripts/check.sh --fast', './scripts/check.sh *']
  ])('allows %j', (text, entry) => {
    expect(matchAllowlist(argv(text), allowlist)).toBe(entry);
  });

  it.each([
    'pnpm testx',
    'pnpm tes',
    'pnpm',
    'pnpm Test',
    'pnpm run test',
    'npm test',
    'pnpmtest',
    '/usr/bin/pnpm test',
    'git',
    'git diffx',
    'git push',
    'scripts/check.sh',
    './scripts/check.sh.bak',
    'node_modules/.bin/vitest',
    // Exact entries take no extra arguments.
    'pnpm lint --fix',
    'git status --short'
  ])('refuses the near miss %j', (text) => {
    expect(matchAllowlist(argv(text), allowlist)).toBeNull();
  });

  it('never matches what the parser refuses', () => {
    expect(parseCommand('git diff; rm -rf /').ok).toBe(false);
    expect(parseCommand('pnpm test && curl x').ok).toBe(false);
    expect(parseCommand('pnpm test$(id)').ok).toBe(false);
  });

  it('ignores entries that are not valid commands', () => {
    expect(parseAllowlistEntry('pnpm test | cat')).toBeNull();
    expect(matchAllowlist(['pnpm', 'test'], ['pnpm test | cat'])).toBeNull();
    expect(parseAllowlistEntry('  pnpm   test ')).toEqual({
      words: ['pnpm', 'test'],
      extra: false
    });
    expect(parseAllowlistEntry('pnpm test *')).toEqual({ words: ['pnpm', 'test'], extra: true });
    // `*` only as the last word, never alone or inside a word.
    expect(parseAllowlistEntry('*')).toBeNull();
    expect(parseAllowlistEntry('pnpm * test')).toBeNull();
    expect(parseAllowlistEntry('pnpm test*')).toBeNull();
  });
});

describe('formatArgv', () => {
  it('quotes words with spaces or shell characters', () => {
    expect(formatArgv(['git', 'diff', '--', 'my file.ts'])).toBe('git diff -- "my file.ts"');
    expect(formatArgv(['git', 'log', '--grep', 'a;b'])).toBe('git log --grep "a;b"');
    expect(formatArgv(['echo', 'say "hi"'])).toBe('echo "say \\"hi\\""');
    expect(formatArgv(['pnpm', ''])).toBe('pnpm ""');
  });

  it('round-trips through parseCommand', () => {
    const argv = ['git', 'diff', '--', 'a b.ts', 'c"d', 'e\\f'];
    expect(parseCommand(formatArgv(argv))).toEqual({ ok: true, argv });
  });
});

describe('truncateMiddle', () => {
  it('leaves short output alone', () => {
    expect(truncateMiddle('ok\n', 100)).toBe('ok\n');
  });

  it('keeps the head and the tail around [truncated]', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const out = truncateMiddle(lines, 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.startsWith('line 0\n')).toBe(true);
    expect(out.endsWith('line 1999')).toBe(true);
    expect(out).toContain('\n[truncated]\n');
  });

  it('cuts a single long line without line breaks', () => {
    const out = truncateMiddle('x'.repeat(10_000), 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain('[truncated]');
  });
});

describe('deniedArgument', () => {
  it.each([
    [['git', '-C', '..', 'status'], '-C'],
    [['git', '-c', 'alias.x=!sh', 'x'], '-c'],
    [['git', '--git-dir=/tmp/x', 'status'], '--git-dir=/tmp/x'],
    [['git', '--work-tree', '/', 'status'], '--work-tree'],
    [['git', 'diff', '--output=/tmp/x'], '--output=/tmp/x'],
    [['git', 'diff', '--outp=/tmp/x'], '--outp=/tmp/x'],
    [['git', 'diff', '-o', 'x'], '-o'],
    [['git', 'fetch', '--upload-pack=sh'], '--upload-pack=sh'],
    [['git', 'rebase', '--exec', 'sh'], '--exec'],
    [['git', '--config-env=core.pager=X', 'log'], '--config-env=core.pager=X'],
    [['node', '-e', '1'], '-e'],
    [['node', '-pe', '1'], '-pe'],
    [['node', '--eval=1'], '--eval=1'],
    [['node', '--print', '1'], '--print'],
    [['node', '-r', 'x', 'a.js'], '-r'],
    [['node', '--import=x', 'a.js'], '--import=x'],
    [['node', '--experimental-loader', 'x', 'a.js'], '--experimental-loader'],
    [['pnpm', 'dlx', 'x'], 'dlx'],
    [['pnpm', 'exec', 'x'], 'exec'],
    [['npm', 'x', 'y'], 'x'],
    [['npm', '-g', 'install', 'x'], '-g'],
    [['yarn', '--cwd=/', 'test'], '--cwd=/'],
    [['pnpm', '--dir=/', 'test'], '--dir=/'],
    [['npm', '--prefix', '/', 'test'], '--prefix'],
    [['npx', 'cowsay'], 'npx'],
    [['pnpx', 'x'], 'pnpx'],
    [['bunx', 'x'], 'bunx'],
    [['/usr/local/bin/npx', 'x'], '/usr/local/bin/npx'],
    [['C:\\Program Files\\nodejs\\NPX.CMD', 'x'], 'C:\\Program Files\\nodejs\\NPX.CMD'],
    [['git.exe', '-C', 'x'], '-C']
  ])('refuses %j at %j', (argv, denied) => {
    expect(deniedArgument(argv)).toBe(denied);
  });

  it.each([
    ['git', 'status', '--short'],
    ['git', 'diff', '--stat'],
    ['git', 'log', '-1', '--oneline'],
    ['node', 'scripts/check.js', '--fast'],
    ['node', '--version'],
    ['pnpm', 'test', '--', '-e', 'exec', '--dir'],
    ['pnpm', 'test', 'src/exec.test.ts'],
    ['vitest', '-e'],
    ['cargo', 'test', '-C']
  ])('allows %j', (...argv) => {
    expect(deniedArgument(argv)).toBeNull();
  });

  it('names programs as the table does', () => {
    expect(programName('/usr/bin/GIT')).toBe('git');
    expect(programName('C:\\x\\pnpm.cmd')).toBe('pnpm');
    expect(programName('node.exe')).toBe('node');
  });

  it('says why a command may not run: off the list first, then a denied option', () => {
    expect(commandRefusal(['git', 'push'], ['git status'])).toBe('not-allowlisted');
    expect(commandRefusal(['git', '-C', 'x', 'status'], ['git *'])).toBe('denied-flag');
    expect(commandRefusal(['npx', 'x'], ['npx *'])).toBe('denied-flag');
    expect(commandRefusal(['git', 'status'], ['git status'])).toBeNull();
  });
});
