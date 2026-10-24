import { MIME_TYPES, sniffType, typeOfPath, type BinaryType } from '@bridge/shared';

// The bytes of an image the chat made, from the page itself. No permission is needed: the
// image is already on chatgpt.com, so the content script reads it the way the page does
// (its own URL, a blob: or data: URL), or draws it when that fails. See PLAN.md, "1.3.0
// decisions".

/** Types the browser can re-encode an image into, when the path asks for another type. */
const ENCODABLE: readonly BinaryType[] = ['png', 'jpg', 'webp'];

/** `unreadable`: the page wouldn't hand the image over (cross-origin without CORS). */
export type ImageBytes =
  | { ok: true; bytes: Uint8Array<ArrayBuffer>; type: BinaryType }
  | { ok: false; error: string; unreadable?: true };

async function fetched(src: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    // From the cache if the page already loaded it; the page's own cookies for its own URL.
    const response = await fetch(src, { credentials: 'include', cache: 'force-cache' });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    // Cross-origin without CORS, or gone.
    return null;
  }
}

/** The image as the page drew it, re-encoded as PNG. Fails for a cross-origin image. */
async function drawn(img: HTMLImageElement): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    if (!img.complete) await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')?.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    // A tainted canvas (SecurityError).
    return null;
  }
}

/** `bytes` re-encoded as `type` (PNG, JPEG or WebP) by the browser. */
async function encoded(
  bytes: Uint8Array<ArrayBuffer>,
  from: BinaryType,
  type: BinaryType
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: MIME_TYPES[from] }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: MIME_TYPES[type], quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The image's bytes in the type `path` names: as the page loaded it if that's already the
 * type, else re-encoded (a WebP saved as `hero.png` becomes a real PNG). Says why not when
 * it can't (a cross-origin image the page won't hand over, or a type the browser can't make).
 */
export async function imageFor(img: HTMLImageElement, path: string): Promise<ImageBytes> {
  const want = typeOfPath(path);
  if (want === null || !MIME_TYPES[want].startsWith('image/')) {
    return { ok: false, error: 'Save an image as .png, .jpg, .webp or .gif.' };
  }
  const src = img.currentSrc || img.src;
  let bytes = src ? await fetched(src) : null;
  let type = bytes ? sniffType(bytes) : null;
  if (!bytes || !type || !MIME_TYPES[type].startsWith('image/')) {
    bytes = await drawn(img);
    type = bytes ? 'png' : null;
  }
  if (!bytes || !type) {
    return {
      ok: false,
      unreadable: true,
      error:
        'Bridge can’t read this image from the page. Download it from the chat and add it to the project yourself.'
    };
  }
  if (type === want) return { ok: true, bytes, type };
  if (!ENCODABLE.includes(want)) {
    return {
      ok: false,
      error: `This image is a ${type.toUpperCase()}. Save it as .${type}, .png, .jpg or .webp.`
    };
  }
  const converted = await encoded(bytes, type, want);
  return converted
    ? { ok: true, bytes: converted, type: want }
    : { ok: false, error: `Bridge couldn’t turn this ${type.toUpperCase()} into a .${want} file.` };
}
