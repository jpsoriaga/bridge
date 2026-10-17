import { createHash, randomBytes } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  MAX_FILE_BYTES,
  TREE_MAX_DEPTH,
  TREE_MAX_ENTRIES,
  type FileErrorCode,
  type ReadResult,
  type TreeEntry,
  type TreeResult,
  type UndoResult,
  type WriteParams,
  type WriteResult
} from '@bridge/shared';
import { newOpId, type History } from './history';
import { checkPath, type Sandbox } from './sandbox';

/** A refusal with a code the extension can see. Never carries an absolute path. */
export class FileOpError extends Error {
  constructor(readonly code: FileErrorCode) {
    super(code);
  }
}

/** The filesystem calls a write commits with. Tests swap one in to simulate a crash. */
export interface WriteFs {
  rename: typeof fs.rename;
  link: typeof fs.link;
}
const realFs: WriteFs = { rename: fs.rename, link: fs.link };

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const BINARY_SNIFF_BYTES = 8 * 1024;
const isBinary = (data: Buffer) => data.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** The first line break decides: CRLF or LF. A file with none counts as LF. */
export function detectEol(text: string): 'lf' | 'crlf' {
  const lf = text.indexOf('\n');
  return lf > 0 && text[lf - 1] === '\r' ? 'crlf' : 'lf';
}

export function withEol(text: string, eol: 'lf' | 'crlf'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

async function resolveOrThrow(sandbox: Sandbox, path: unknown) {
  const resolved = await sandbox.resolve(path);
  if (!resolved.ok) throw new FileOpError(resolved.code);
  return resolved;
}

/** Reads at most MAX_FILE_BYTES, refusing anything bigger before reading it. */
async function readCapped(abs: string): Promise<Buffer> {
  const handle = await fs.open(abs, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new FileOpError('not-a-file');
    if (stats.size > MAX_FILE_BYTES) throw new FileOpError('too-large');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readFile(sandbox: Sandbox, path: unknown): Promise<ReadResult> {
  const target = await resolveOrThrow(sandbox, path);
  if (target.kind === 'missing') throw new FileOpError('not-found');
  if (target.kind === 'dir') throw new FileOpError('not-a-file');
  const data = await readCapped(target.abs);
  if (isBinary(data)) throw new FileOpError('binary');
  const content = data.toString('utf8');
  return { content, hash: sha256(data), eol: detectEol(content) };
}

/**
 * Writes `data` to a temp file beside `abs`, flushes it, then moves it into place, so the
 * target is either the old bytes or the new ones, never half of each. With `exclusive`,
 * the move fails with `exists` if something appeared at `abs` in the meantime.
 */
export async function atomicWrite(
  abs: string,
  data: Buffer,
  options: { exclusive: boolean; mode?: number },
  writeFs: WriteFs = realFs
): Promise<void> {
  const tmp = join(dirname(abs), `.${basename(abs)}.bridge-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(data);
      if (options.mode !== undefined) await handle.chmod(options.mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!options.exclusive) {
      await writeFs.rename(tmp, abs);
      return;
    }
    // link() refuses to replace an existing file, which rename() would do silently.
    try {
      await writeFs.link(tmp, abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new FileOpError('exists');
      if (!['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
      // No hard links here (e.g. FAT). Still exclusive, just not atomic.
      try {
        await fs.copyFile(tmp, abs, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FileOpError('exists');
        }
        throw copyError;
      }
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function writeFile(
  sandbox: Sandbox,
  history: History,
  params: WriteParams,
  writeFs: WriteFs = realFs
): Promise<WriteResult> {
  if (Buffer.byteLength(params.content, 'utf8') > MAX_FILE_BYTES) {
    throw new FileOpError('too-large');
  }
  const target = await resolveOrThrow(sandbox, params.path);
  if (target.kind === 'dir') throw new FileOpError('not-a-file');

  if (target.kind === 'file') {
    // No baseHash means the caller meant to create a file, and one is already here.
    if (params.baseHash === undefined) throw new FileOpError('exists');
    // Modify: only on top of exactly what the caller read.
    const before = await readCapped(target.abs);
    if (sha256(before) !== params.baseHash) throw new FileOpError('conflict');
    const data = Buffer.from(withEol(params.content, detectEol(before.toString('utf8'))), 'utf8');
    if (data.length > MAX_FILE_BYTES) throw new FileOpError('too-large');
    const { mode } = await fs.stat(target.abs);

    const opId = newOpId();
    await history.backup(opId, before);
    await atomicWrite(target.abs, data, { exclusive: false, mode: mode & 0o7777 }, writeFs);
    const afterHash = sha256(data);
    await history.commit({
      opId,
      time: Date.now(),
      path: target.rel,
      kind: 'modify',
      beforeHash: params.baseHash,
      afterHash
    });
    return { opId, kind: 'modify', hash: afterHash };
  }

  // Create. A baseHash here means the caller read a file that has since been deleted.
  if (params.baseHash !== undefined) throw new FileOpError('conflict');
  const data = Buffer.from(params.content, 'utf8');
  // Missing parents sit under the nearest existing (checked) directory.
  await fs.mkdir(dirname(target.abs), { recursive: true });
  const opId = newOpId();
  await history.backup(opId, null);
  await atomicWrite(target.abs, data, { exclusive: true }, writeFs);
  const afterHash = sha256(data);
  await history.commit({
    opId,
    time: Date.now(),
    path: target.rel,
    kind: 'create',
    beforeHash: null,
    afterHash
  });
  return { opId, kind: 'create', hash: afterHash };
}

/**
 * Reverts one write: restores the backup of a modify, or removes a created file. Refuses
 * with `conflict` if the file no longer holds what Bridge wrote, unless `force`.
 */
export async function undo(
  sandbox: Sandbox,
  history: History,
  opId: string,
  options: { force?: boolean } = {}
): Promise<UndoResult> {
  const op = history.get(opId);
  if (!op) throw new FileOpError('unknown-op');
  if (op.undoneAt !== undefined) throw new FileOpError('already-undone');

  const target = await resolveOrThrow(sandbox, op.path);
  if (target.kind === 'dir') throw new FileOpError('not-a-file');
  const currentHash = target.kind === 'file' ? sha256(await readCapped(target.abs)) : null;
  if (currentHash !== op.afterHash && !options.force) throw new FileOpError('conflict');

  if (op.kind === 'modify') {
    let backup: Buffer;
    try {
      backup = await history.readBackup(opId);
    } catch {
      throw new FileOpError('io-error');
    }
    if (target.kind === 'missing') await fs.mkdir(dirname(target.abs), { recursive: true });
    const mode = target.kind === 'file' ? (await fs.stat(target.abs)).mode & 0o7777 : undefined;
    await atomicWrite(target.abs, backup, { exclusive: false, mode });
  } else if (target.kind === 'file') {
    await fs.rm(target.abs);
  }
  await history.markUndone(opId);
  return { opId, path: op.path };
}

/** Never listed. Built output and framework caches. */
export const TREE_SKIP_DIRS: readonly string[] = ['dist/', 'out/', 'build/', '.next/'];
/** Shown as one collapsed entry, never opened. */
const COLLAPSED_DIRS = new Set(['node_modules']);

interface GitignoreScope {
  /** Relative directory the .gitignore lives in; '' for the root. */
  base: string;
  rules: Ignore;
}

function gitignored(scopes: readonly GitignoreScope[], rel: string, isDir: boolean): boolean {
  for (const { base, rules } of scopes) {
    if (base !== '' && !rel.startsWith(`${base}/`)) continue;
    const inner = base === '' ? rel : rel.slice(base.length + 1);
    if (rules.ignores(isDir ? `${inner}/` : inner)) return true;
  }
  return false;
}

/**
 * Lists the project depth-first, sorted by name. Honours every .gitignore on the way down,
 * the denylist, and TREE_SKIP_DIRS. Symlinks are listed only if they point inside the
 * project and outside the denylist, and symlinked directories are never descended into.
 */
export async function listTree(
  sandbox: Sandbox,
  limits: { maxEntries?: number; maxDepth?: number } = {}
): Promise<TreeResult> {
  const maxEntries = limits.maxEntries ?? TREE_MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? TREE_MAX_DEPTH;
  const skip = ignore().add([...TREE_SKIP_DIRS]);
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function entryType(abs: string, dirent: Dirent) {
    if (!dirent.isSymbolicLink()) {
      if (dirent.isDirectory()) return { type: 'dir' as const, size: 0, follow: true };
      if (dirent.isFile())
        return { type: 'file' as const, size: (await fs.lstat(abs)).size, follow: false };
      return null;
    }
    let real: string;
    try {
      real = await fs.realpath(abs);
    } catch {
      return null;
    }
    if (real === sandbox.root || !sandbox.contains(real)) return null;
    if (sandbox.denylist.matches(sandbox.relativeOf(real))) return null;
    const stats = await fs.stat(real);
    if (stats.isDirectory()) return { type: 'dir' as const, size: 0, follow: false };
    if (stats.isFile()) return { type: 'file' as const, size: stats.size, follow: false };
    return null;
  }

  async function walk(abs: string, rel: string, depth: number, scopes: GitignoreScope[]) {
    let gitignore: string | null = null;
    try {
      gitignore = await fs.readFile(join(abs, '.gitignore'), 'utf8');
    } catch {
      // none here
    }
    const here =
      gitignore === null ? scopes : [...scopes, { base: rel, rules: ignore().add(gitignore) }];

    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return; // unreadable directory: leave it out
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const childRel =
        rel === '' ? dirent.name.normalize('NFC') : `${rel}/${dirent.name.normalize('NFC')}`;
      // Names the sandbox would refuse can't be read or written anyway.
      if (!checkPath(childRel).ok) continue;
      const childAbs = join(abs, dirent.name);

      if (dirent.isDirectory() && COLLAPSED_DIRS.has(dirent.name.toLowerCase())) {
        entries.push({ path: childRel, type: 'dir', size: 0, collapsed: true });
        continue;
      }
      if (sandbox.denylist.matches(childRel)) continue;

      const info = await entryType(childAbs, dirent);
      if (!info) continue;
      const isDir = info.type === 'dir';
      if (gitignored(here, childRel, isDir)) continue;
      if (isDir && skip.ignores(`${childRel}/`)) continue;

      entries.push({ path: childRel, type: info.type, size: info.size });
      if (isDir && info.follow) {
        if (depth + 1 > maxDepth) truncated = true;
        else await walk(childAbs, childRel, depth + 1, here);
      }
    }
  }

  await walk(sandbox.root, '', 1, []);
  return { entries, truncated };
}
