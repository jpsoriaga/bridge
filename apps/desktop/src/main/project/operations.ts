import { createHash, randomBytes } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import {
  LIST_MAX_ENTRIES,
  looksBinary,
  matchTrailingNewline,
  MAX_BACKUP_BYTES,
  MAX_FILE_BYTES,
  TREE_MAX_DEPTH,
  TREE_MAX_ENTRIES,
  type DeleteParams,
  type DeleteResult,
  type FileErrorCode,
  type ListResult,
  type ReadResult,
  type RenameParams,
  type RenameResult,
  type StatResult,
  type TreeEntry,
  type TreeResult,
  type UndoResult,
  type WriteParams,
  type WriteResult
} from '@bridge/shared';
import { newOpId, type History, type OpRecord } from './history';
import { checkPath, type Sandbox } from './sandbox';

/** A refusal with a code the extension can see. Never carries an absolute path. */
export class FileOpError extends Error {
  constructor(readonly code: FileErrorCode) {
    super(code);
  }
}

/**
 * The filesystem calls a write commits with. Tests swap one in to simulate a crash, or a
 * folder swapped for a symlink just before the commit.
 */
export interface WriteFs {
  rename: typeof fs.rename;
  link: typeof fs.link;
  realpath: (path: string) => Promise<string>;
}
const realFs: WriteFs = { rename: fs.rename, link: fs.link, realpath: (path) => fs.realpath(path) };

/** Opens never follow a symlink in the last component, where the platform can (not Windows). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Opens a checked path for reading. A symlink that appeared there since the check is refused. */
export async function openRead(abs: string): Promise<fs.FileHandle> {
  try {
    return await fs.open(abs, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new FileOpError('outside-root');
    throw error;
  }
}

/**
 * A regular file with one name. A second hard link could be a file outside the project
 * (a link made from inside to anything the user can read), and nothing tells them apart.
 */
function checkRegular(stats: Stats): void {
  if (!stats.isFile()) throw new FileOpError('not-a-file');
  if (stats.nlink > 1) throw new FileOpError('hardlink');
}

/**
 * Right before a commit (rename, link, remove): the folder the change lands in must still
 * resolve inside the project and off the denylist. Narrows the window in which a local
 * process could swap a checked folder for a symlink that points elsewhere.
 */
async function assertInside(sandbox: Sandbox, dir: string, writeFs: WriteFs): Promise<void> {
  let real: string;
  try {
    real = await writeFs.realpath(dir);
  } catch {
    throw new FileOpError('outside-root');
  }
  if (!sandbox.contains(real)) throw new FileOpError('outside-root');
  if (real !== sandbox.root && sandbox.denylist.matches(sandbox.relativeOf(real))) {
    throw new FileOpError('denied');
  }
}

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const BINARY_SNIFF_BYTES = 8 * 1024;
const isBinary = (data: Buffer) => data.subarray(0, BINARY_SNIFF_BYTES).includes(0);
const BOM = '﻿';
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The first line break decides: CRLF or LF. A file with none counts as LF. */
export function detectEol(text: string): 'lf' | 'crlf' {
  const lf = text.indexOf('\n');
  return lf > 0 && text[lf - 1] === '\r' ? 'crlf' : 'lf';
}

export function withEol(text: string, eol: 'lf' | 'crlf'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * A text file's bytes as Bridge sees them: refuses binary (`binary`) and anything that
 * isn't valid UTF-8 (`encoding`), and splits off a UTF-8 byte order mark.
 */
export function decodeText(data: Buffer): { content: string; bom: boolean } {
  if (isBinary(data)) throw new FileOpError('binary');
  let text: string;
  try {
    text = utf8.decode(data);
  } catch {
    throw new FileOpError('encoding');
  }
  const bom = text.startsWith(BOM);
  return { content: bom ? text.slice(1) : text, bom };
}

async function resolveOrThrow(sandbox: Sandbox, path: unknown) {
  const resolved = await sandbox.resolve(path);
  if (!resolved.ok) throw new FileOpError(resolved.code);
  return resolved;
}

/**
 * Reads at most `cap` bytes of a regular, singly linked file, refusing anything bigger
 * before reading it. The checks are on the open handle, so they hold for what is read.
 */
async function readCapped(
  abs: string,
  cap = MAX_FILE_BYTES
): Promise<{ data: Buffer; stats: Stats }> {
  const handle = await openRead(abs);
  try {
    const stats = await handle.stat();
    checkRegular(stats);
    if (stats.size > cap) throw new FileOpError('too-large');
    return { data: await handle.readFile(), stats };
  } finally {
    await handle.close();
  }
}

export async function readFile(sandbox: Sandbox, path: unknown): Promise<ReadResult> {
  const target = await resolveOrThrow(sandbox, path);
  if (target.kind === 'missing') throw new FileOpError('not-found');
  if (target.kind === 'dir') throw new FileOpError('not-a-file');
  const { data } = await readCapped(target.abs);
  const { content, bom } = decodeText(data);
  return { content, hash: sha256(data), eol: detectEol(content), bom };
}

/** Streams a file through SHA-256, refusing anything over MAX_BACKUP_BYTES. */
async function hashFile(abs: string): Promise<{ hash: string; size: number }> {
  const handle = await openRead(abs);
  try {
    const stats = await handle.stat();
    checkRegular(stats);
    if (stats.size > MAX_BACKUP_BYTES) throw new FileOpError('too-large');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { hash: hash.digest('hex'), size: stats.size };
  } finally {
    await handle.close();
  }
}

/** Size and hash of any regular file, text or binary, up to MAX_BACKUP_BYTES. */
export async function statFile(sandbox: Sandbox, path: unknown): Promise<StatResult> {
  const target = await resolveOrThrow(sandbox, path);
  if (target.kind === 'missing') throw new FileOpError('not-found');
  if (target.kind === 'dir') throw new FileOpError('not-a-file');
  return hashFile(target.abs);
}

/**
 * Writes `data` to a temp file beside `abs`, flushes it, then moves it into place, so the
 * target is either the old bytes or the new ones, never half of each. With `exclusive`,
 * the move fails with `exists` if something appeared at `abs` in the meantime.
 */
export async function atomicWrite(
  abs: string,
  data: Buffer,
  options: { exclusive: boolean; mode?: number; sandbox?: Sandbox },
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
    if (options.sandbox) await assertInside(options.sandbox, dirname(abs), writeFs);
    if (!options.exclusive) {
      await writeFs.rename(tmp, abs);
      return;
    }
    await exclusiveMove(tmp, abs, writeFs, true);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

const NO_HARD_LINKS = ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'];

/**
 * Puts `from` at `to`, failing with `exists` if anything is at `to`: link() refuses to
 * replace a file, which rename() would do silently. `from` is left in place for the caller
 * to remove. On filesystems without hard links (FAT) it falls back to an exclusive copy,
 * which is still exclusive, just not atomic.
 */
async function exclusiveMove(from: string, to: string, writeFs: WriteFs, copy: boolean) {
  try {
    await writeFs.link(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new FileOpError('exists');
    if (!NO_HARD_LINKS.includes(code ?? '')) throw error;
    try {
      if (copy) await fs.copyFile(from, to, constants.COPYFILE_EXCL);
      else {
        // A rename: no link, so check, then move. Not exclusive under a race.
        if (await exists(to)) throw new FileOpError('exists');
        await writeFs.rename(from, to);
      }
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new FileOpError('exists');
      }
      throw copyError;
    }
  }
}

const exists = (abs: string) =>
  fs.lstat(abs).then(
    () => true,
    () => false
  );

/** A write as the sandbox sees it. `trigger` only labels the op; the server checks it. */
export type WriteInput = Omit<WriteParams, 'trigger'> & Partial<Pick<WriteParams, 'trigger'>>;

/** Labels every op record carries. */
function labels(params: { source?: 'chat'; trigger?: 'click' | 'auto'; loopId?: string }) {
  return {
    ...(params.source && { source: params.source }),
    ...(params.trigger === 'auto' && { trigger: 'auto' as const }),
    ...(params.loopId && { loopId: params.loopId })
  };
}

export async function writeFile(
  sandbox: Sandbox,
  history: History,
  params: WriteInput,
  writeFs: WriteFs = realFs
): Promise<WriteResult> {
  if (Buffer.byteLength(params.content, 'utf8') > MAX_FILE_BYTES) {
    throw new FileOpError('too-large');
  }
  if (looksBinary(params.content)) throw new FileOpError('binary');
  const target = await resolveOrThrow(sandbox, params.path);
  if (target.kind === 'dir') throw new FileOpError('not-a-file');

  if (target.kind === 'file') {
    // No baseHash means the caller meant to create a file, and one is already here.
    if (params.baseHash === undefined) throw new FileOpError('exists');
    // Modify: only on top of exactly what the caller read.
    const { data: before, stats } = await readCapped(target.abs);
    if (sha256(before) !== params.baseHash) throw new FileOpError('conflict');
    // Never overwrite what Bridge wouldn't read: binary or non-UTF-8 files stay as they are.
    const old = decodeText(before);
    // Keep the file's shape: line endings, byte order mark, and a missing final newline.
    const content = params.content.startsWith(BOM) ? params.content.slice(1) : params.content;
    const text = withEol(matchTrailingNewline(content, old.content), detectEol(old.content));
    const data = Buffer.from((old.bom ? BOM : '') + text, 'utf8');
    if (data.length > MAX_FILE_BYTES) throw new FileOpError('too-large');
    const opId = newOpId();
    await history.backup(opId, before, data);
    await atomicWrite(
      target.abs,
      data,
      { exclusive: false, mode: stats.mode & 0o7777, sandbox },
      writeFs
    );
    const afterHash = sha256(data);
    await history.commit({
      opId,
      time: Date.now(),
      path: target.rel,
      kind: 'modify',
      beforeHash: params.baseHash,
      afterHash,
      ...labels(params)
    });
    return { opId, kind: 'modify', hash: afterHash };
  }

  // Create. A baseHash here means the caller read a file that has since been deleted.
  if (params.baseHash !== undefined) throw new FileOpError('conflict');
  const data = Buffer.from(params.content, 'utf8');
  // Missing parents sit under the nearest existing (checked) directory.
  await fs.mkdir(dirname(target.abs), { recursive: true });
  const opId = newOpId();
  await history.backup(opId, null, data);
  await atomicWrite(target.abs, data, { exclusive: true, sandbox }, writeFs);
  const afterHash = sha256(data);
  await history.commit({
    opId,
    time: Date.now(),
    path: target.rel,
    kind: 'create',
    beforeHash: null,
    afterHash,
    ...labels(params)
  });
  return { opId, kind: 'create', hash: afterHash };
}

/** The bytes of an existing file at a checked path, if they still hash to `baseHash`. */
async function readExpected(
  abs: string,
  baseHash: string
): Promise<{ data: Buffer; stats: Stats }> {
  const read = await readCapped(abs, MAX_BACKUP_BYTES);
  if (sha256(read.data) !== baseHash) throw new FileOpError('conflict');
  return read;
}

/** Deletes one file after backing it up. Refuses with `conflict` if it changed since `baseHash`. */
export async function deleteFile(
  sandbox: Sandbox,
  history: History,
  params: Omit<DeleteParams, 'trigger'> & Partial<Pick<DeleteParams, 'trigger'>>,
  writeFs: WriteFs = realFs
): Promise<DeleteResult> {
  const target = await resolveOrThrow(sandbox, params.path);
  if (target.kind === 'missing') throw new FileOpError('not-found');
  if (target.kind === 'dir') throw new FileOpError('not-a-file');
  const { data, stats } = await readExpected(target.abs, params.baseHash);

  const opId = newOpId();
  await history.backup(opId, data);
  await assertInside(sandbox, dirname(target.abs), writeFs);
  await fs.rm(target.abs);
  await history.commit({
    opId,
    time: Date.now(),
    path: target.rel,
    kind: 'delete',
    beforeHash: params.baseHash,
    afterHash: null,
    mode: stats.mode & 0o7777,
    ...labels(params)
  });
  return { opId };
}

/** Both paths name the same file: a case-only rename on a case-insensitive disk. */
async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** `App.tsx` → `app.tsx` where both names open the same file: through a temp name. */
async function caseRename(from: string, to: string): Promise<void> {
  const tmp = join(
    dirname(from),
    `.${basename(from)}.bridge-${randomBytes(6).toString('hex')}.tmp`
  );
  await fs.rename(from, tmp);
  try {
    await fs.rename(tmp, to);
  } catch (error) {
    await fs.rename(tmp, from).catch(() => undefined);
    throw error;
  }
}

/**
 * Moves one file, backing it up first. Refuses with `exists` if something is already at
 * the new path (unless it's the same file under another case, on a case-insensitive disk),
 * and with `conflict` if the file changed since `baseHash`. Missing folders of the new path
 * are created under its nearest existing, checked folder.
 */
export async function renameFile(
  sandbox: Sandbox,
  history: History,
  params: Omit<RenameParams, 'trigger'> & Partial<Pick<RenameParams, 'trigger'>>,
  writeFs: WriteFs = realFs
): Promise<RenameResult> {
  const source = await resolveOrThrow(sandbox, params.from);
  const dest = await resolveOrThrow(sandbox, params.to);
  if (source.kind === 'missing') throw new FileOpError('not-found');
  if (source.kind === 'dir') throw new FileOpError('not-a-file');
  if (dest.rel === source.rel) throw new FileOpError('exists');
  const caseOnly =
    dest.kind === 'file' &&
    dest.rel.toLowerCase() === source.rel.toLowerCase() &&
    (await sameFile(source.abs, dest.abs));
  if (dest.kind !== 'missing' && !caseOnly) throw new FileOpError('exists');
  const { data } = await readExpected(source.abs, params.baseHash);

  const opId = newOpId();
  await history.backup(opId, data);
  if (caseOnly) {
    await assertInside(sandbox, dirname(source.abs), writeFs);
    await caseRename(source.abs, dest.abs);
  } else {
    await fs.mkdir(dirname(dest.abs), { recursive: true });
    await assertInside(sandbox, dirname(source.abs), writeFs);
    await assertInside(sandbox, dirname(dest.abs), writeFs);
    await exclusiveMove(source.abs, dest.abs, writeFs, false);
    await fs.rm(source.abs, { force: true });
  }
  await history.commit({
    opId,
    time: Date.now(),
    path: dest.rel,
    from: source.rel,
    kind: 'rename',
    beforeHash: params.baseHash,
    afterHash: params.baseHash,
    ...labels(params)
  });
  return { opId, hash: params.baseHash };
}

/** Puts a backup back at a checked path, replacing what's there only if `replace`. */
async function restore(
  sandbox: Sandbox,
  history: History,
  op: OpRecord,
  abs: string,
  options: { replace: boolean; mode?: number }
): Promise<void> {
  let backup: Buffer;
  try {
    backup = await history.readBackup(op.opId);
  } catch {
    throw new FileOpError('io-error');
  }
  await fs.mkdir(dirname(abs), { recursive: true });
  await atomicWrite(abs, backup, { exclusive: !options.replace, mode: options.mode, sandbox });
}

const currentHash = async (target: { kind: string; abs: string }) =>
  target.kind === 'file' ? (await hashFile(target.abs)).hash : null;

/**
 * Reverts one op: restores the backup of a modify, removes a created file, puts a deleted
 * file back, or moves a renamed file back. Refuses with `conflict` if the file no longer
 * holds what Bridge left there (or, for a delete or rename, something now sits where the
 * file goes back), unless `force`.
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
  const force = options.force === true;

  const target = await resolveOrThrow(sandbox, op.path);
  if (target.kind === 'dir') throw new FileOpError('not-a-file');

  switch (op.kind) {
    case 'modify': {
      if ((await currentHash(target)) !== op.afterHash && !force) {
        throw new FileOpError('conflict');
      }
      const mode = target.kind === 'file' ? (await fs.lstat(target.abs)).mode & 0o7777 : undefined;
      await restore(sandbox, history, op, target.abs, { replace: true, mode });
      break;
    }
    case 'create':
      if ((await currentHash(target)) !== op.afterHash && !force) {
        throw new FileOpError('conflict');
      }
      if (target.kind === 'file') {
        await assertInside(sandbox, dirname(target.abs), realFs);
        await fs.rm(target.abs);
      }
      break;
    case 'delete':
      // Something new at the path: don't replace it without asking.
      if (target.kind === 'file' && !force) throw new FileOpError('conflict');
      await restore(sandbox, history, op, target.abs, { replace: force, mode: op.mode });
      break;
    case 'rename': {
      const source = await resolveOrThrow(sandbox, op.from);
      if (source.kind === 'dir') throw new FileOpError('not-a-file');
      const caseOnly = source.kind === 'file' && (await sameFile(source.abs, target.abs));
      const moved = (await currentHash(target)) === op.afterHash;
      if (moved && (source.kind === 'missing' || caseOnly)) {
        await assertInside(sandbox, dirname(target.abs), realFs);
        if (caseOnly) await caseRename(target.abs, source.abs);
        else {
          await fs.mkdir(dirname(source.abs), { recursive: true });
          await assertInside(sandbox, dirname(source.abs), realFs);
          await exclusiveMove(target.abs, source.abs, realFs, false);
          await fs.rm(target.abs, { force: true });
        }
        break;
      }
      if (!force) throw new FileOpError('conflict');
      // Forced: the old path gets the backup, and whatever is at the new path goes.
      if (caseOnly) {
        await restore(sandbox, history, op, target.abs, { replace: true });
        await caseRename(target.abs, source.abs);
      } else {
        await restore(sandbox, history, op, source.abs, { replace: true });
        if (target.kind === 'file') await fs.rm(target.abs);
      }
      break;
    }
  }
  await history.markUndone(opId);
  return { opId, path: op.path };
}

/** Never listed. Built output and framework caches. */
export const TREE_SKIP_DIRS: readonly string[] = ['dist/', 'out/', 'build/', '.next/'];
/** Shown as one collapsed entry, never opened. */
const COLLAPSED_DIRS = new Set(['node_modules']);
const skipDirs = ignore().add([...TREE_SKIP_DIRS]);

export interface GitignoreScope {
  /** Relative directory the .gitignore lives in; '' for the root. */
  base: string;
  rules: Ignore;
}

export function gitignored(
  scopes: readonly GitignoreScope[],
  rel: string,
  isDir: boolean
): boolean {
  for (const { base, rules } of scopes) {
    if (base !== '' && !rel.startsWith(`${base}/`)) continue;
    const inner = base === '' ? rel : rel.slice(base.length + 1);
    if (rules.ignores(isDir ? `${inner}/` : inner)) return true;
  }
  return false;
}

/** `scopes` plus the folder's own .gitignore, if it has one. */
export async function withGitignore(
  scopes: GitignoreScope[],
  abs: string,
  rel: string
): Promise<GitignoreScope[]> {
  try {
    const text = await fs.readFile(join(abs, '.gitignore'), 'utf8');
    return [...scopes, { base: rel, rules: ignore().add(text) }];
  } catch {
    return scopes; // none here
  }
}

/** Whether Bridge lists a path at all: the sandbox's names, the denylist and skip dirs. */
export function isListed(
  sandbox: Sandbox,
  scopes: readonly GitignoreScope[],
  rel: string,
  isDir: boolean
): boolean {
  if (!checkPath(rel).ok || sandbox.denylist.matches(rel)) return false;
  if (gitignored(scopes, rel, isDir)) return false;
  return !(isDir && skipDirs.ignores(`${rel}/`));
}

type Child = TreeEntry & { abs: string; follow: boolean };

/** One folder's entries as Bridge lists them, sorted by name. */
async function children(
  sandbox: Sandbox,
  abs: string,
  rel: string,
  scopes: readonly GitignoreScope[],
  onEntry: (child: Child) => Promise<boolean>
): Promise<void> {
  async function entryType(childAbs: string, dirent: Dirent) {
    if (!dirent.isSymbolicLink()) {
      if (dirent.isDirectory()) return { type: 'dir' as const, size: 0, follow: true };
      if (dirent.isFile())
        return { type: 'file' as const, size: (await fs.lstat(childAbs)).size, follow: false };
      return null;
    }
    let real: string;
    try {
      real = await fs.realpath(childAbs);
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

  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return; // unreadable directory: leave it out
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const dirent of dirents) {
    const name = dirent.name.normalize('NFC');
    const childRel = rel === '' ? name : `${rel}/${name}`;
    // Names the sandbox would refuse can't be read or written anyway.
    if (!checkPath(childRel).ok) continue;
    const childAbs = join(abs, dirent.name);

    if (dirent.isDirectory() && COLLAPSED_DIRS.has(dirent.name.toLowerCase())) {
      const more = await onEntry({
        path: childRel,
        type: 'dir',
        size: 0,
        collapsed: true,
        abs: childAbs,
        follow: false
      });
      if (!more) return;
      continue;
    }
    if (sandbox.denylist.matches(childRel)) continue;

    const info = await entryType(childAbs, dirent);
    if (!info || !isListed(sandbox, scopes, childRel, info.type === 'dir')) continue;
    const more = await onEntry({ path: childRel, ...info, abs: childAbs });
    if (!more) return;
  }
}

const entryOf = ({ path, type, size, collapsed }: Child): TreeEntry => ({
  path,
  type,
  size,
  ...(collapsed && { collapsed })
});

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
  const entries: TreeEntry[] = [];
  let truncated = false;

  async function walk(abs: string, rel: string, depth: number, scopes: GitignoreScope[]) {
    const here = await withGitignore(scopes, abs, rel);
    await children(sandbox, abs, rel, here, async (child) => {
      if (entries.length >= maxEntries) {
        truncated = true;
        return false;
      }
      entries.push(entryOf(child));
      if (child.type === 'dir' && child.follow) {
        if (depth + 1 > maxDepth) truncated = true;
        else await walk(child.abs, child.path, depth + 1, here);
      }
      return true;
    });
  }

  await walk(sandbox.root, '', 1, []);
  return { entries, truncated };
}

/**
 * One folder's entries (`dir` '' is the root), with the same rules as `listTree`, for a
 * tree that loads a folder at a time. Every .gitignore from the root down to it applies.
 */
export async function listDir(
  sandbox: Sandbox,
  dir: string,
  maxEntries = LIST_MAX_ENTRIES
): Promise<ListResult> {
  let abs = sandbox.root;
  let base = '';
  let scopes = await withGitignore([], abs, '');
  if (dir !== '') {
    const target = await resolveOrThrow(sandbox, dir);
    if (target.kind === 'missing') throw new FileOpError('not-found');
    if (target.kind !== 'dir') throw new FileOpError('not-a-file');
    const segments = target.rel.split('/');
    // Each ancestor must be listed itself (not ignored or skipped), and adds its .gitignore.
    let rel = '';
    let at = sandbox.root;
    for (const segment of segments) {
      rel = rel === '' ? segment : `${rel}/${segment}`;
      at = join(at, segment);
      if (!isListed(sandbox, scopes, rel, true) || COLLAPSED_DIRS.has(segment.toLowerCase())) {
        throw new FileOpError('denied');
      }
      scopes = await withGitignore(scopes, at, rel);
    }
    abs = target.abs;
    base = target.rel;
  }
  const entries: TreeEntry[] = [];
  let truncated = false;
  await children(sandbox, abs, base, scopes, async (child) => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return false;
    }
    entries.push(entryOf(child));
    return true;
  });
  return { entries, truncated };
}
