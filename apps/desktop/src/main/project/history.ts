import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const BACKUP_MAX_OPS = 500;

export interface OpRecord {
  opId: string;
  /** Epoch ms. */
  time: number;
  /** Relative POSIX path, as the sandbox normalised it. For a rename, the new path. */
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  /** For a rename: the old path. */
  from?: string;
  /** sha256 of the file before the op. Null for a create. */
  beforeHash: string | null;
  /** sha256 of the file after it. Null for a delete. */
  afterHash: string | null;
  /** For a delete: the file's permission bits, restored by undo. */
  mode?: number;
  /** Epoch ms when undone. */
  undoneAt?: number;
  /** `chat`: applied from a diff card in the chat. */
  source?: 'chat';
  /** `auto`: Bridge applied it on its own (Auto-apply or Full auto), not a click. */
  trigger?: 'auto';
  /** The Full auto run that made it. */
  loopId?: string;
  /** Full auto did it on its own although it normally waits for a click ("auto-approved"). */
  autoApproved?: true;
  /** Bytes, not text: an image the chat made, or a download. */
  binary?: true;
  /** `download`: fetched from a URL. */
  origin?: 'download';
}

interface LogFile {
  v: 1;
  ops: OpRecord[];
}

const HASH = /^[0-9a-f]{64}$/;

function isOpRecord(value: unknown): value is OpRecord {
  const op = value as Partial<OpRecord> | null;
  return (
    typeof op === 'object' &&
    op !== null &&
    typeof op.opId === 'string' &&
    /^[0-9a-z-]{1,64}$/.test(op.opId) &&
    typeof op.time === 'number' &&
    typeof op.path === 'string' &&
    (op.kind === 'create' ||
      op.kind === 'modify' ||
      op.kind === 'delete' ||
      op.kind === 'rename') &&
    (op.from === undefined || (op.kind === 'rename' && typeof op.from === 'string')) &&
    (op.kind !== 'rename' || typeof op.from === 'string') &&
    (op.beforeHash === null || (typeof op.beforeHash === 'string' && HASH.test(op.beforeHash))) &&
    (op.afterHash === null || (typeof op.afterHash === 'string' && HASH.test(op.afterHash))) &&
    (op.afterHash !== null || op.kind === 'delete') &&
    (op.mode === undefined || (Number.isInteger(op.mode) && op.mode >= 0 && op.mode <= 0o7777)) &&
    (op.undoneAt === undefined || typeof op.undoneAt === 'number') &&
    (op.source === undefined || op.source === 'chat') &&
    (op.trigger === undefined || op.trigger === 'auto') &&
    (op.loopId === undefined ||
      (typeof op.loopId === 'string' && /^[\w-]{1,64}$/.test(op.loopId))) &&
    (op.autoApproved === undefined || op.autoApproved === true) &&
    (op.binary === undefined || op.binary === true) &&
    (op.origin === undefined || op.origin === 'download')
  );
}

/** Stable per project folder, so its backups survive restarts. */
export function projectId(realRoot: string): string {
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
}

export const newOpId = (): string => randomUUID();

export interface HistoryOptions {
  maxAgeMs?: number;
  maxOps?: number;
  now?: () => number;
}

/**
 * One project's backups and operation log, under `userData/backups/<projectId>/`:
 * `log.json` plus one `<opId>/` folder per op holding `before` (the old bytes) for a
 * modify, delete or rename, or nothing for a create. Never inside the project.
 */
export class History {
  private ops: OpRecord[] = [];
  private maxAgeMs: number;
  private readonly maxOps: number;
  private readonly now: () => number;

  private constructor(
    readonly dir: string,
    options: HistoryOptions
  ) {
    this.maxAgeMs = options.maxAgeMs ?? BACKUP_MAX_AGE_MS;
    this.maxOps = options.maxOps ?? BACKUP_MAX_OPS;
    this.now = options.now ?? Date.now;
  }

  static async open(dir: string, options: HistoryOptions = {}): Promise<History> {
    const history = new History(dir, options);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const file = JSON.parse(await readFile(history.logPath, 'utf8')) as Partial<LogFile>;
      history.ops = Array.isArray(file.ops) ? file.ops.filter(isOpRecord) : [];
    } catch {
      history.ops = [];
    }
    await history.prune();
    return history;
  }

  private get logPath(): string {
    return join(this.dir, 'log.json');
  }

  private opDir(opId: string): string {
    return join(this.dir, opId);
  }

  /** Newest first. */
  list(): readonly OpRecord[] {
    return [...this.ops].reverse();
  }

  get(opId: string): OpRecord | undefined {
    return this.ops.find((op) => op.opId === opId);
  }

  /** Newest write that hasn't been undone. */
  lastUndoable(): OpRecord | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (this.ops[i]!.undoneAt === undefined) return this.ops[i];
    }
    return undefined;
  }

  /**
   * Step 1 of an op: save what's there now. `null` records that nothing was. `after`, for
   * a write, keeps what Bridge wrote, so the app can show the diff later even if the file
   * has changed since.
   */
  async backup(opId: string, before: Buffer | null, after?: Buffer): Promise<void> {
    await mkdir(this.opDir(opId), { recursive: true, mode: 0o700 });
    if (before !== null) await writeFile(join(this.opDir(opId), 'before'), before, { mode: 0o600 });
    if (after) await writeFile(join(this.opDir(opId), 'after'), after, { mode: 0o600 });
  }

  /** What a write put in the file, if it was kept. Null otherwise. */
  async readAfter(opId: string): Promise<Buffer | null> {
    return readFile(join(this.opDir(opId), 'after')).catch(() => null);
  }

  /** How long ops and their backups are kept. Prunes at once. */
  async setMaxAge(ms: number): Promise<void> {
    this.maxAgeMs = ms;
    await this.prune();
  }

  /** Forgets every op and deletes every backup for this project. Nothing can be undone after. */
  async clear(): Promise<void> {
    this.ops = [];
    await this.prune();
  }

  /** Step 3, after the file is written: log it and prune. */
  async commit(op: OpRecord): Promise<void> {
    this.ops.push(op);
    await this.prune();
  }

  /** Throws if there is no backup, e.g. it was pruned or deleted by hand. */
  readBackup(opId: string): Promise<Buffer> {
    return readFile(join(this.opDir(opId), 'before'));
  }

  async markUndone(opId: string): Promise<void> {
    const op = this.get(opId);
    if (!op) return;
    op.undoneAt = this.now();
    await this.save();
  }

  /** Drops ops older than 7 days or beyond the newest 500, their backups, and strays. */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.maxAgeMs;
    this.ops = this.ops.filter((op) => op.time >= cutoff).slice(-this.maxOps);
    const keep = new Set(this.ops.map((op) => op.opId));
    await this.save();
    // Also removes backups whose write never completed (no log entry).
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !keep.has(entry.name)) {
        await rm(join(this.dir, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async save(): Promise<void> {
    const tmp = `${this.logPath}.tmp`;
    const file: LogFile = { v: 1, ops: this.ops };
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, this.logPath);
  }
}
