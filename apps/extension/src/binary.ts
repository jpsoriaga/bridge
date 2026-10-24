import { UPLOAD_CHUNK_BYTES } from '@bridge/shared';

// Bytes as base64 between the page, the worker and the app: images the chat made, files
// to attach, downloads. Shared by the content script and the worker; no Node, no Buffer.

/** Base64 of `bytes`, built in slices so a 20 MB image doesn't overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const slice = 0x8000;
  for (let i = 0; i < bytes.length; i += slice) {
    binary += String.fromCharCode(...bytes.subarray(i, i + slice));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Raw bytes per upload chunk, a multiple of 3 so each chunk is whole base64 with no padding. */
export const UPLOAD_STEP = UPLOAD_CHUNK_BYTES - (UPLOAD_CHUNK_BYTES % 3);

/**
 * `data` (base64 of `size` bytes) cut into upload chunks: each one's offset in bytes and its
 * base64. An empty file is one empty chunk.
 */
export function uploadChunks(data: string, size: number): { offset: number; data: string }[] {
  const chunks: { offset: number; data: string }[] = [];
  for (let offset = 0; offset < size || chunks.length === 0; offset += UPLOAD_STEP) {
    chunks.push({
      offset,
      data: data.slice((offset / 3) * 4, ((offset + UPLOAD_STEP) / 3) * 4)
    });
  }
  return chunks;
}
