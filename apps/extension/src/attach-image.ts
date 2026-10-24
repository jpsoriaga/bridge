import { FILE_ERROR_LABELS } from '@bridge/shared';
import type { AttachmentFile, AttachRefusal } from './messages';
import { base64ToBytes, bytesToBase64 } from './binary';

// Images Bridge attaches to the chat (Send files, READ cards, Full auto follow-ups) are made
// to fit first: at most ATTACH_MAX_SIDE on the longest side and under ATTACH_MAX_BYTES.
// Only the copy that goes to the chat changes; the file on disk is never touched. Shared by
// the content script and the worker, which both have createImageBitmap and OffscreenCanvas.

/** The longest side, in pixels, of an image Bridge attaches. */
export const ATTACH_MAX_SIDE = 2048;
/** The largest image Bridge attaches. */
export const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
/** Each try after the first scales the image down by this much again. */
const SHRINK = 0.75;
/** Never shrink below this on the longest side to make the size fit; refuse instead. */
const MIN_SIDE = 512;
const JPEG_QUALITIES = [0.9, 0.8, 0.7];

/** A decoded image, from the browser or a test. */
export interface Picture {
  width: number;
  height: number;
  /** Whether any pixel, drawn at this size, is less than opaque. */
  hasAlpha(width: number, height: number): Promise<boolean>;
  encode(width: number, height: number, mime: string, quality?: number): Promise<Uint8Array>;
  close(): void;
}

export type Decode = (bytes: Uint8Array<ArrayBuffer>, mime: string) => Promise<Picture | null>;

export type PreparedImage =
  | { ok: true; file: AttachmentFile; resized: boolean; size: number }
  | { ok: false; reason: 'too-large' | 'unreadable' };

/** Decodes with the browser's own image decoder; null where there's none or it can't. */
export const browserDecode: Decode = async (bytes, mime) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
  const draw = (width: number, height: number) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No 2D canvas');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { canvas, context };
  };
  return {
    width: bitmap.width,
    height: bitmap.height,
    hasAlpha: async (width, height) => {
      const { data } = draw(width, height).context.getImageData(0, 0, width, height);
      for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true;
      return false;
    },
    encode: async (width, height, type, quality) => {
      const blob = await draw(width, height).canvas.convertToBlob({ type, quality });
      return new Uint8Array(await blob.arrayBuffer());
    },
    close: () => bitmap.close()
  };
};

/** The file name with the extension that matches `mime`. */
function renamed(name: string, mime: string): string {
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'jpg' && (current === 'jpg' || current === 'jpeg')) return name;
  return `${base}.${ext}`;
}

/**
 * The image as it should go to the chat: unchanged when it already fits, else scaled down
 * to ATTACH_MAX_SIDE and re-encoded under ATTACH_MAX_BYTES (PNG when it has transparency,
 * else JPEG), shrinking further only as far as MIN_SIDE. Refused when it still can't fit,
 * or when it's too big to send as it is and can't be decoded.
 */
export async function prepareAttachment(
  file: AttachmentFile,
  decode: Decode = browserDecode
): Promise<PreparedImage> {
  const bytes = base64ToBytes(file.data);
  const picture = await decode(bytes, file.mime);
  if (!picture) {
    // Can't look inside: send it as it is if it's small enough; the page decides.
    return bytes.length <= ATTACH_MAX_BYTES
      ? { ok: true, file, resized: false, size: bytes.length }
      : { ok: false, reason: 'unreadable' };
  }
  try {
    const longest = Math.max(picture.width, picture.height);
    if (longest <= ATTACH_MAX_SIDE && bytes.length <= ATTACH_MAX_BYTES) {
      return { ok: true, file, resized: false, size: bytes.length };
    }
    let scale = Math.min(1, ATTACH_MAX_SIDE / longest);
    const size = () => ({
      width: Math.max(1, Math.round(picture.width * scale)),
      height: Math.max(1, Math.round(picture.height * scale))
    });
    const first = size();
    const opaqueType = file.mime === 'image/jpeg';
    const mime =
      !opaqueType && (await picture.hasAlpha(first.width, first.height))
        ? 'image/png'
        : 'image/jpeg';
    for (;;) {
      const { width, height } = size();
      for (const quality of mime === 'image/png' ? [undefined] : JPEG_QUALITIES) {
        const out = await picture.encode(width, height, mime, quality);
        if (out.length <= ATTACH_MAX_BYTES) {
          return {
            ok: true,
            file: {
              name: renamed(file.name, mime),
              mime,
              data: bytesToBase64(out)
            },
            resized: true,
            size: out.length
          };
        }
      }
      if (Math.max(width, height) * SHRINK < MIN_SIDE) return { ok: false, reason: 'too-large' };
      scale *= SHRINK;
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    picture.close();
  }
}

/** Why an image wasn't attached, for cards and the side panel. */
export const IMAGE_REFUSALS: Record<'too-large' | 'unreadable', string> = {
  'too-large': `too large to attach, even scaled down (over ${ATTACH_MAX_BYTES / 1024 / 1024} MB)`,
  unreadable: 'not an image Bridge can read'
};

/** A refused attachment's reason, in words: the app's, or why the image can't go. */
export function attachRefusalText(code: AttachRefusal): string {
  if (code === 'image-too-large') return IMAGE_REFUSALS['too-large'];
  if (code === 'image-unreadable') return IMAGE_REFUSALS.unreadable;
  if (code === 'not-an-image') return 'not an image';
  return FILE_ERROR_LABELS[code];
}
