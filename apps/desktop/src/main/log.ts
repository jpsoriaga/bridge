// The app's log: what happened (started, connected, paired, opened a project, refused a
// request, ran a command, checked for updates), for bug reports. Never file contents,
// command output, pairing codes, keys or tokens: callers log events, and every line still
// goes through `logLine` (home folder as `~`, likely secrets and key-like runs redacted).
//
// userData/logs/bridge.log, rotated at 5 MB: bridge.log.1 and bridge.log.2 are the older
// ones, so at most 3 files. Help → Open logs folder shows them; Help → Copy diagnostics
// takes the last 50 lines.

import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { join } from 'node:path';
import { DIAGNOSTICS_LOG_LINES, logLine } from '@bridge/shared';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './perms';

export const LOG_FILE = 'bridge.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** bridge.log and two older ones. */
export const LOG_FILES = 3;
/** Lines kept in memory for diagnostics (only the last 50 are copied). */
const RECENT_LINES = 200;
/** How much of the last file is read back at startup, for the recent lines. */
const TAIL_BYTES = 64 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogOptions {
  /** The folder, userData/logs. */
  dir: string;
  /** Shown as `~` in every line. */
  home?: string;
  maxBytes?: number;
  files?: number;
  now?: () => Date;
}

export class Log {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly files: number;
  private readonly now: () => Date;
  private size = 0;
  private readonly recentLines: string[];

  constructor(private readonly options: LogOptions) {
    this.path = join(options.dir, LOG_FILE);
    this.maxBytes = options.maxBytes ?? MAX_LOG_BYTES;
    this.files = options.files ?? LOG_FILES;
    this.now = options.now ?? (() => new Date());
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
    this.recentLines = readTail(this.path).slice(-RECENT_LINES);
  }

  get dir(): string {
    return this.options.dir;
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  /** The last `count` lines, oldest first, from this launch and the end of the last one. */
  recent(count = DIAGNOSTICS_LOG_LINES): string[] {
    return this.recentLines.slice(-count);
  }

  private write(level: LogLevel, message: string): void {
    const line = `${this.now().toISOString()} ${level.padEnd(5)} ${logLine(message, this.options.home)}`;
    this.recentLines.push(line);
    if (this.recentLines.length > RECENT_LINES) this.recentLines.shift();
    const bytes = Buffer.byteLength(line) + 1;
    // Logging never takes the app down: a full disk or a read-only folder loses lines.
    try {
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      mkdirSync(this.options.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      appendFileSync(this.path, `${line}\n`, { mode: PRIVATE_FILE_MODE });
      this.size += bytes;
    } catch {
      // Nowhere better to report it.
    }
  }

  /** bridge.log → .1 → .2; the oldest beyond `files` is deleted. */
  private rotate(): void {
    rmSync(`${this.path}.${this.files - 1}`, { force: true });
    for (let i = this.files - 2; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        // Not there yet.
      }
    }
    renameSync(this.path, `${this.path}.1`);
    this.size = 0;
  }
}

/** The last whole lines of `path`, up to `TAIL_BYTES` of them. */
function readTail(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = statSync(path);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line may be cut, and the last is the empty string after the final newline.
    if (length < size) lines.shift();
    return lines.filter((line) => line !== '');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
