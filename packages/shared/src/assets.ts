import type { FileErrorCode } from './files';

// Binary files: images the chat makes, downloads, and images Bridge attaches to a message.
// Bridge decides what a file is from its bytes, never from its name alone, and writes only
// these types. See PLAN.md, "1.3.0 decisions".

/** The types Bridge saves (`@@ASSET`, `@@DOWNLOAD`), by the name each goes by. */
export const BINARY_TYPES = [
  'png',
  'jpg',
  'webp',
  'gif',
  'svg',
  'ico',
  'avif',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'mp3',
  'wav',
  'mp4',
  'webm',
  'json',
  'txt'
] as const;
export type BinaryType = (typeof BINARY_TYPES)[number];

export const MIME_TYPES: Record<BinaryType, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  json: 'application/json',
  txt: 'text/plain'
};

/** Images the chat can see as an attachment. */
export const ATTACHABLE_TYPES: readonly BinaryType[] = ['png', 'jpg', 'webp', 'gif'];

const EXTENSIONS: Record<string, BinaryType> = {
  ...Object.fromEntries(BINARY_TYPES.map((type) => [type, type])),
  jpeg: 'jpg'
};

/** The type a path's extension names, or null if it isn't one Bridge saves. */
export function typeOfPath(path: string): BinaryType | null {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase();
  return ext ? (EXTENSIONS[ext] ?? null) : null;
}

/** A raster image the chat can see when it's attached (`@@READ` on an image). */
export function isAttachablePath(path: string): boolean {
  const type = typeOfPath(path);
  return type !== null && ATTACHABLE_TYPES.includes(type);
}

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));
const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((byte, i) => bytes[at + i] === byte);

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Control characters no text file holds (tab, line breaks and form feed are fine). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f]/;

/** The bytes as UTF-8 text without NULs, or null. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** Text that a browser would take for a web page. Never saved as .txt or .json. */
const HTML = /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>]|<iframe[\s>])/i;
/** An SVG document: an optional XML declaration, comments and doctype, then `<svg`. */
const SVG =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;

/** ISO base media (`ftyp`) brands: AVIF still images, and MP4 video. */
const AVIF_BRANDS = new Set(['avif', 'avis']);
const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'M4V '
]);

function isoBrand(bytes: Uint8Array): BinaryType | null {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return null;
  const size = Math.min(
    bytes.length,
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  );
  const brands = [ascii(bytes, 8, 12)];
  for (let at = 16; at + 4 <= size; at += 4) brands.push(ascii(bytes, at, at + 4));
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
  if (brands.some((brand) => MP4_BRANDS.has(brand))) return 'mp4';
  return null;
}

/**
 * What the bytes are, from their first bytes (magic numbers), or null if they're none of
 * `BINARY_TYPES`. Text types are checked last: SVG by its root element, JSON by parsing,
 * plain text as UTF-8 that isn't a web page.
 */
export function sniffType(bytes: Uint8Array): BinaryType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'wav';
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 22) return 'ico';
  if (ascii(bytes, 0, 4) === 'wOFF') return 'woff';
  if (ascii(bytes, 0, 4) === 'wOF2') return 'woff2';
  if (ascii(bytes, 0, 4) === 'OTTO') return 'otf';
  if (startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || ascii(bytes, 0, 4) === 'true') return 'ttf';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && ascii(bytes, 0, 64).includes('webm')) {
    return 'webm';
  }
  const iso = isoBrand(bytes);
  if (iso) return iso;
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';
  // An MPEG audio frame header: 11 sync bits, layer III.
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe6) === 0xe2) return 'mp3';

  const text = asText(bytes);
  if (text === null || CONTROL.test(text)) return null;
  if (SVG.test(text)) return 'svg';
  if (HTML.test(text)) return null;
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return 'txt';
  }
}

/** Numeric character references, decoded, so `jav&#x61;script:` can't hide. */
function decodeReferences(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16) % 0x110000)
    )
    .replace(/&#(\d{1,7});?/g, (_, dec: string) => String.fromCodePoint(Number(dec) % 0x110000))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '');
}

/**
 * Why an SVG isn't safe to save, or null: a `<script>`, an event handler (`onload=`), a
 * `javascript:` link, embedded HTML (`<foreignObject>`, `<iframe>`) or an XML entity. An SVG
 * opened from the project in a browser runs its scripts, so Bridge refuses all of them.
 */
export function svgProblem(text: string): string | null {
  const plain = decodeReferences(text);
  if (/<script[\s>/]/i.test(plain)) return 'a <script> element';
  if (/[\s"'/]on[a-z]+\s*=/i.test(plain)) return 'an event handler';
  // Browsers ignore tabs and line breaks inside a URL's scheme.
  if (/(?:java|vb)script\s*:|data\s*:\s*text\/html/i.test(plain.replace(/[\t\n\r]/g, ''))) {
    return 'a script link';
  }
  if (/<(?:foreignObject|iframe|embed|object|handler)[\s>/]/i.test(plain)) return 'embedded HTML';
  if (/<!ENTITY/i.test(plain)) return 'an XML entity';
  return null;
}

/**
 * Whether `bytes` may be written to `path`: the path names a type Bridge saves, the bytes
 * really are that type, and an SVG has nothing that runs. A `.png` that's really HTML fails.
 */
export function binaryProblem(
  path: string,
  bytes: Uint8Array
): { code: FileErrorCode; detail?: string } | null {
  const wanted = typeOfPath(path);
  if (wanted === null) return { code: 'unsupported-type', detail: 'name' };
  const found = sniffType(bytes);
  if (found !== wanted) return { code: 'unsupported-type', detail: found ?? 'unknown' };
  if (found === 'svg') {
    const problem = svgProblem(asText(bytes) ?? '');
    if (problem) return { code: 'unsafe-svg', detail: problem };
  }
  return null;
}
