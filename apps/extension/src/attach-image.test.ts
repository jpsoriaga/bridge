import { describe, expect, it } from 'vitest';
import {
  ATTACH_MAX_BYTES,
  ATTACH_MAX_SIDE,
  attachRefusalText,
  prepareAttachment,
  type Decode
} from './attach-image';
import { base64ToBytes, bytesToBase64 } from './binary';
import { insertLabel, selectionSummary, sentSummary, splitSelection } from './sidepanel/selection';

interface Encoded {
  width: number;
  height: number;
  mime: string;
  quality?: number;
}

/**
 * A stand-in decoder: a picture of the given size whose encodings take `bytesPerPixel`
 * per pixel (times the JPEG quality), recording every encode.
 */
function fakeDecode(
  width: number,
  height: number,
  { alpha = false, bytesPerPixel = 1 }: { alpha?: boolean; bytesPerPixel?: number } = {}
) {
  const encodes: Encoded[] = [];
  let closed = false;
  const decode: Decode = async () => ({
    width,
    height,
    hasAlpha: async () => alpha,
    encode: async (w, h, mime, quality) => {
      encodes.push({ width: w, height: h, mime, quality });
      return new Uint8Array(Math.round(w * h * bytesPerPixel * (quality ?? 1)));
    },
    close: () => {
      closed = true;
    }
  });
  return { decode, encodes, closed: () => closed };
}

const file = (name: string, mime: string, size: number) => ({
  name,
  mime,
  data: bytesToBase64(new Uint8Array(size).fill(7))
});

describe('prepareAttachment', () => {
  it('sends an image that already fits as it is', async () => {
    const original = file('hero.png', 'image/png', 1_619_308);
    const { decode, encodes, closed } = fakeDecode(1600, 900);
    const prepared = await prepareAttachment(original, decode);
    expect(prepared).toEqual({ ok: true, file: original, resized: false, size: 1_619_308 });
    expect(encodes).toEqual([]);
    expect(closed()).toBe(true);
  });

  it('scales a large opaque image to 2048px on its longest side, as JPEG under the limit', async () => {
    const original = file('photo.png', 'image/png', 9_000_000);
    const { decode, encodes } = fakeDecode(4000, 3000);
    const prepared = await prepareAttachment(original, decode);
    if (!prepared.ok) throw new Error('refused');
    expect(encodes[0]).toMatchObject({ width: ATTACH_MAX_SIDE, height: 1536, mime: 'image/jpeg' });
    expect(prepared.resized).toBe(true);
    expect(prepared.size).toBeLessThanOrEqual(ATTACH_MAX_BYTES);
    expect(prepared.file).toMatchObject({ name: 'photo.jpg', mime: 'image/jpeg' });
    expect(base64ToBytes(prepared.file.data).length).toBe(prepared.size);
  });

  it('keeps PNG for an image with transparency', async () => {
    const { decode, encodes } = fakeDecode(3000, 3000, { alpha: true });
    const prepared = await prepareAttachment(file('logo.png', 'image/png', 6_000_000), decode);
    if (!prepared.ok) throw new Error('refused');
    expect(prepared.file).toMatchObject({ name: 'logo.png', mime: 'image/png' });
    expect(encodes.every((e) => e.mime === 'image/png')).toBe(true);
  });

  it('lowers the quality, then the size, until it fits under the limit', async () => {
    // 2048 × 2048 at 2 bytes a pixel is over 5 MB at every quality; 1536 × 1536 isn’t.
    const { decode, encodes } = fakeDecode(2048, 2048, { bytesPerPixel: 2 });
    const prepared = await prepareAttachment(file('big.jpg', 'image/jpeg', 7_000_000), decode);
    if (!prepared.ok) throw new Error('refused');
    expect(encodes.map((e) => e.quality)).toEqual([0.9, 0.8, 0.7, 0.9]);
    expect(encodes.at(-1)).toMatchObject({ width: 1536, height: 1536 });
    expect(prepared.file.name).toBe('big.jpg');
    expect(prepared.size).toBeLessThanOrEqual(ATTACH_MAX_BYTES);
  });

  it('refuses an image that still can’t be made small enough', async () => {
    const { decode } = fakeDecode(4000, 4000, { alpha: true, bytesPerPixel: 100 });
    const prepared = await prepareAttachment(file('noise.png', 'image/png', 19_000_000), decode);
    expect(prepared).toEqual({ ok: false, reason: 'too-large' });
    expect(attachRefusalText('image-too-large')).toMatch(/too large to attach/);
  });

  it('never changes the file it was given', async () => {
    const original = file('photo.png', 'image/png', 9_000_000);
    const before = { ...original };
    await prepareAttachment(original, fakeDecode(4000, 3000).decode);
    expect(original).toEqual(before);
  });

  it('sends an image it can’t decode as it is if it fits, else refuses it', async () => {
    const none: Decode = async () => null;
    const small = file('a.webp', 'image/webp', 1000);
    expect(await prepareAttachment(small, none)).toMatchObject({ ok: true, file: small });
    expect(await prepareAttachment(file('b.webp', 'image/webp', 6_000_000), none)).toEqual({
      ok: false,
      reason: 'unreadable'
    });
  });
});

describe('Send files selection', () => {
  const sizes = new Map([
    ['src/app.ts', 1200],
    ['README.md', 300],
    ['public/hero.png', 1_619_308]
  ]);

  it('counts text files against the budget and attaches images instead', () => {
    const picked = splitSelection(sizes, ['src/app.ts', 'README.md', 'public/hero.png']);
    expect(picked.files).toEqual(['src/app.ts', 'README.md']);
    expect(picked.images).toEqual(['public/hero.png']);
    expect(picked.chars).toBeLessThan(2000);
    expect(selectionSummary(2, 1)).toBe('2 files · 1 image');
    expect(insertLabel(2, 1)).toBe('Insert 2 files and attach 1 image');
  });

  it('labels each kind of selection', () => {
    expect(insertLabel(0, 0)).toBe('Insert files');
    expect(insertLabel(1, 0)).toBe('Insert 1 file');
    expect(insertLabel(0, 2)).toBe('Attach 2 images');
    expect(selectionSummary(0, 0)).toBe('0 files');
    expect(selectionSummary(0, 1)).toBe('1 image');
    expect(sentSummary(2, 1)).toBe(
      'Added 2 files to the message box and attached 1 image. Review it and press send.'
    );
    expect(sentSummary(0, 1)).toBe('Attached 1 image. Review it and press send.');
  });
});
