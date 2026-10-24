import { createHash } from 'node:crypto';
import { MAX_BINARY_BYTES, type UploadParams } from '@bridge/shared';

/** An upload not finished or committed within this is dropped. */
export const UPLOAD_TTL_MS = 60_000;
/** Uploads in progress at once. Each holds at most MAX_BINARY_BYTES in memory. */
export const MAX_UPLOADS = 2;

interface Upload {
  chunks: Buffer[];
  size: number;
  touched: number;
}

/**
 * The chunks of binary writes on their way in, in memory only. A chunk must start where
 * the last one ended; anything else, past MAX_BINARY_BYTES, or past MAX_UPLOADS at once is
 * refused. `take` hands the bytes over once (to `write_binary`) and forgets them.
 */
export class Uploads {
  private readonly uploads = new Map<string, Upload>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds a chunk. Returns the bytes received so far, or null if it doesn't fit. */
  add(params: UploadParams): number | null {
    this.expire();
    const data = Buffer.from(params.data, 'base64');
    let upload = this.uploads.get(params.uploadId);
    if (!upload) {
      if (params.offset !== 0 || this.uploads.size >= MAX_UPLOADS) return null;
      upload = { chunks: [], size: 0, touched: this.now() };
      this.uploads.set(params.uploadId, upload);
    }
    if (params.offset !== upload.size || upload.size + data.length > MAX_BINARY_BYTES) {
      this.uploads.delete(params.uploadId);
      return null;
    }
    upload.chunks.push(data);
    upload.size += data.length;
    upload.touched = this.now();
    return upload.size;
  }

  /**
   * The whole upload, if it has exactly `size` bytes hashing to `sha256`; null otherwise.
   * Either way it's gone afterwards.
   */
  take(uploadId: string, size: number, sha256: string): Buffer | null {
    this.expire();
    const upload = this.uploads.get(uploadId);
    this.uploads.delete(uploadId);
    if (!upload || upload.size !== size) return null;
    const data = Buffer.concat(upload.chunks);
    return createHash('sha256').update(data).digest('hex') === sha256 ? data : null;
  }

  /** Drops one upload: its write was refused. */
  drop(uploadId: string): void {
    this.uploads.delete(uploadId);
  }

  /** Drops everything: the project switched or the socket went. */
  clear(): void {
    this.uploads.clear();
  }

  private expire(): void {
    const cutoff = this.now() - UPLOAD_TTL_MS;
    for (const [id, upload] of this.uploads) if (upload.touched < cutoff) this.uploads.delete(id);
  }
}
