import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUsablePath, loginEnvOnce, parseEnvOutput, readLoginEnv } from './login-env';

const posix = process.platform !== 'win32';
const M = '__BRIDGE_ENV_test__';

describe('parseEnvOutput', () => {
  it('takes only what is between the markers', () => {
    const output = [
      'Welcome back! (from .zshrc)',
      'PATH=/junk/from/zshrc',
      '',
      M,
      'HOME=/Users/me',
      'PATH=/opt/homebrew/bin:/usr/bin',
      M,
      'PATH=/junk/after',
      'bye'
    ].join('\n');
    expect(parseEnvOutput(output, M)).toEqual({
      HOME: '/Users/me',
      PATH: '/opt/homebrew/bin:/usr/bin'
    });
  });

  it('joins multi-line values and keeps "=" inside values', () => {
    const output = `${M}\nFUNC=() {\n  echo hi\n}\nA=b=c\n${M}\n`;
    expect(parseEnvOutput(output, M)).toEqual({ FUNC: '() {\n  echo hi\n}', A: 'b=c' });
  });

  it('handles CRLF and drops the marker variable', () => {
    const output = `${M}\r\nBRIDGE_ENV_MARKER=${M}\r\nPATH=/bin\r\n${M}\r\n`;
    expect(parseEnvOutput(output, M)).toEqual({ PATH: '/bin' });
  });

  it('returns null without both markers', () => {
    expect(parseEnvOutput('PATH=/bin\n', M)).toBeNull();
    expect(parseEnvOutput(`${M}\nPATH=/bin\n`, M)).toBeNull();
    // A marker inside a longer line doesn't count.
    expect(parseEnvOutput(`x${M}\nPATH=/bin\n${M}x\n`, M)).toBeNull();
  });
});

describe('isUsablePath', () => {
  it('needs an absolute entry and no control characters', () => {
    expect(isUsablePath('/usr/bin:/bin')).toBe(true);
    expect(isUsablePath('relative:./bin')).toBe(false);
    expect(isUsablePath('/usr/bin\n/bin')).toBe(false);
    expect(isUsablePath('')).toBe(false);
    expect(isUsablePath(undefined)).toBe(false);
  });
});

describe.runIf(posix)('readLoginEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-shell-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake login shell: runs `body`, then the script Bridge passes as `-ilc <script>`. */
  const fakeShell = (body: string) => {
    const file = join(dir, 'fake-shell');
    writeFileSync(file, `#!/bin/sh\n${body}\nexec /bin/sh -c "$2"\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it('reads PATH from the login shell, ignoring what .zshrc prints', async () => {
    const shell = fakeShell(
      'echo "PATH=/not/this"; printf "no newline at the end"; PATH=/opt/tool/bin:/usr/bin:/bin; export PATH'
    );
    const result = await readLoginEnv({ shell, env: { PATH: '/usr/bin', HOME: dir } });
    expect(result).toEqual({ source: 'login-shell', path: '/opt/tool/bin:/usr/bin:/bin' });
  });

  it('falls back to the app’s PATH after the timeout, and kills the shell', async () => {
    const pidFile = join(dir, 'pid');
    const shell = fakeShell(`echo $$ > ${pidFile}; sleep 30`);
    const started = Date.now();
    const result = await readLoginEnv({ shell, timeoutMs: 2_000, env: { PATH: '/usr/bin:/bin' } });
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(result.source).toBe('fallback');
    expect(result.path).toBe('/usr/bin:/bin');
    expect(result.warning).toMatch(/longer than/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('falls back when the shell fails, is missing, or prints no environment', async () => {
    const env = { PATH: '/usr/bin' };
    const failing = await readLoginEnv({ shell: fakeShell('exit 3'), env });
    expect(failing).toMatchObject({ source: 'fallback', path: '/usr/bin' });
    const missing = await readLoginEnv({ shell: join(dir, 'nope'), env });
    expect(missing).toMatchObject({ source: 'fallback', path: '/usr/bin' });
    const relative = await readLoginEnv({ shell: 'zsh', env });
    expect(relative).toMatchObject({ source: 'fallback', path: '/usr/bin' });
  });

  it('falls back when the login PATH is unusable', async () => {
    const shell = fakeShell('PATH=relative/bin; export PATH');
    const result = await readLoginEnv({ shell, env: { PATH: '/usr/bin' } });
    expect(result).toMatchObject({ source: 'fallback', path: '/usr/bin' });
  });

  it('uses the app’s own environment on Windows', async () => {
    const result = await readLoginEnv({ platform: 'win32', env: { PATH: 'C:\\bin' } });
    expect(result).toEqual({ source: 'inherited', path: 'C:\\bin' });
  });
});

describe('loginEnvOnce', () => {
  it('runs the shell once however often it is asked', async () => {
    const read = vi.fn(async () => ({ source: 'login-shell' as const, path: '/bin' }));
    const get = loginEnvOnce(read);
    const [a, b] = await Promise.all([get(), get()]);
    await get();
    expect(read).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });
});
