import { chmod, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders Bridge keeps private: only the user can list or enter them. */
export const PRIVATE_DIR_MODE = 0o700;
/** Files Bridge keeps private: only the user can read or write them. */
export const PRIVATE_FILE_MODE = 0o600;

/** Bridge's own files directly in userData. Everything under `backups/` is Bridge's too. */
export const PRIVATE_FILES = ['settings.json', 'pairing.json', 'server-key.json'] as const;

/**
 * Tightens one path to `mode` if group or others can reach it. Symlinks are left alone (and
 * never followed). Returns whether it changed anything.
 */
async function tighten(path: string, kind: 'dir' | 'file'): Promise<boolean> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  if (kind === 'dir' ? !stats.isDirectory() : !stats.isFile()) return false;
  const want = kind === 'dir' ? PRIVATE_DIR_MODE : PRIVATE_FILE_MODE;
  if ((stats.mode & 0o077) === 0) return false;
  // Group and others lose everything; the owner keeps an execute bit a file already had.
  await chmod(path, kind === 'dir' ? want : (stats.mode & 0o700) | want);
  return true;
}

/** Every folder and file under `dir`, tightened. Symlinks are skipped, never followed. */
async function tightenTree(dir: string, fixed: string[]): Promise<void> {
  if (await tighten(dir, 'dir')) fixed.push(dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await tightenTree(path, fixed);
    else if (entry.isFile() && (await tighten(path, 'file'))) fixed.push(path);
  }
}

/**
 * At startup, on POSIX: userData is 0700, Bridge's own files in it are 0600, and the
 * backups and operation logs are 0700 folders and 0600 files. Anything looser (an older
 * build, a restored backup, a umask of 000) is fixed. Returns the paths it changed. Chromium's
 * own files in userData are left to Chromium. Windows has no modes; ACLs on the profile
 * folder already keep it to the user.
 */
export async function securePrivateData(
  userData: string,
  platform: NodeJS.Platform = process.platform
): Promise<string[]> {
  if (platform === 'win32') return [];
  const fixed: string[] = [];
  if (await tighten(userData, 'dir')) fixed.push(userData);
  for (const name of PRIVATE_FILES) {
    const path = join(userData, name);
    if (await tighten(path, 'file')) fixed.push(path);
  }
  await tightenTree(join(userData, 'backups'), fixed);
  return fixed;
}
