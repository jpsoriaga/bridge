import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A real temp folder with helpers to lay out files. Call `cleanup` in afterEach. */
export function tempProject(prefix = 'bridge-project-') {
  // `.native` expands Windows short names (C:\Users\RUNNER~1), as the app's own realpath does.
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const root = join(base, 'project');
  mkdirSync(root);
  return {
    base,
    root,
    write(rel: string, content: string | Buffer, at = root) {
      const abs = join(at, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    // Windows can hold a folder a just-finished command ran in for a moment (EPERM).
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  };
}

/** Whether this machine lets us create symlinks (Windows without the privilege doesn't). */
export function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-symlink-probe-'));
  try {
    writeFileSync(join(dir, 'file'), '');
    symlinkSync(dir, join(dir, 'dir-link'), 'junction');
    symlinkSync(join(dir, 'file'), join(dir, 'file-link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
