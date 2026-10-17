import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A real temp folder with helpers to lay out files. Call `cleanup` in afterEach. */
export function tempProject(prefix = 'bridge-project-') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
    cleanup: () => rmSync(base, { recursive: true, force: true })
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
