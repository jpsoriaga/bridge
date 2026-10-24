import { describe, expect, it } from 'vitest';
import { binaryProblem, isAttachablePath, sniffType, svgProblem, typeOfPath } from './assets';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const padded = (head: number[] | Uint8Array, size = 64) => {
  const out = new Uint8Array(size);
  out.set(head);
  return out;
};
const ascii = (value: string) => [...value].map((c) => c.charCodeAt(0));

describe('sniffType', () => {
  it('knows each type Bridge saves by its first bytes', () => {
    expect(sniffType(padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(sniffType(padded([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffType(padded(ascii('GIF89a')))).toBe('gif');
    expect(sniffType(padded([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]))).toBe('webp');
    expect(sniffType(padded([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toBe('wav');
    expect(sniffType(padded([0, 0, 1, 0, 1, 0]))).toBe('ico');
    expect(sniffType(padded(ascii('wOFF')))).toBe('woff');
    expect(sniffType(padded(ascii('wOF2')))).toBe('woff2');
    expect(sniffType(padded(ascii('OTTO')))).toBe('otf');
    expect(sniffType(padded([0, 1, 0, 0]))).toBe('ttf');
    expect(sniffType(padded(ascii('ID3')))).toBe('mp3');
    expect(sniffType(padded([0xff, 0xfb, 0x90]))).toBe('mp3');
    expect(sniffType(padded([0x1a, 0x45, 0xdf, 0xa3, ...ascii('webm')]))).toBe('webm');
    expect(
      sniffType(padded([0, 0, 0, 0x18, ...ascii('ftypisom'), 0, 0, 0, 0, ...ascii('mp41')]))
    ).toBe('mp4');
    expect(
      sniffType(padded([0, 0, 0, 0x1c, ...ascii('ftypavif'), 0, 0, 0, 0, ...ascii('mif1')]))
    ).toBe('avif');
  });

  it('reads text types by what they hold', () => {
    expect(sniffType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(sniffType(text('<?xml version="1.0"?>\n<!-- logo -->\n<svg width="1">'))).toBe('svg');
    expect(sniffType(text('{"a": 1}'))).toBe('json');
    expect(sniffType(text('hello\nworld'))).toBe('txt');
  });

  it('refuses a web page, whatever it is called, and unknown bytes', () => {
    expect(sniffType(text('<!DOCTYPE html><html>'))).toBeNull();
    expect(sniffType(text('  <html><body>x</body></html>'))).toBeNull();
    expect(sniffType(text('<script>alert(1)</script>'))).toBeNull();
    expect(sniffType(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // a Windows program
    expect(sniffType(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02))).toBeNull(); // a Linux program
    expect(sniffType(bytes(0xc3, 0x28))).toBeNull(); // not UTF-8
  });
});

describe('svgProblem', () => {
  it('finds scripts, event handlers, script links, embedded HTML and entities', () => {
    expect(svgProblem('<svg><script>alert(1)</script></svg>')).toBe('a <script> element');
    expect(svgProblem('<svg><SCRIPT src="x"/></svg>')).toBe('a <script> element');
    expect(svgProblem('<svg onload="alert(1)"></svg>')).toBe('an event handler');
    expect(svgProblem('<svg><rect\nonclick = "x"/></svg>')).toBe('an event handler');
    expect(svgProblem('<svg><a href="javascript:alert(1)"><rect/></a></svg>')).toBe(
      'a script link'
    );
    expect(svgProblem('<svg><a href="jav&#x61;script:alert(1)"/></svg>')).toBe('a script link');
    expect(svgProblem('<svg><a href="java\tscript:x"/></svg>')).toBe('a script link');
    expect(svgProblem('<svg><use href="data:text/html,<b>"/></svg>')).toBe('a script link');
    expect(svgProblem('<svg><foreignObject><div/></foreignObject></svg>')).toBe('embedded HTML');
    expect(svgProblem('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBe('an XML entity');
  });

  it('lets a plain drawing through', () => {
    expect(
      svgProblem(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" fill="none"/><title>online icon</title></svg>'
      )
    ).toBeNull();
  });
});

describe('binaryProblem', () => {
  const png = padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('wants the bytes to be the type the name says', () => {
    expect(binaryProblem('public/hero.png', png)).toBeNull();
    expect(binaryProblem('public/hero.PNG', png)).toBeNull();
    expect(binaryProblem('public/hero.jpg', png)).toEqual({
      code: 'unsupported-type',
      detail: 'png'
    });
    expect(binaryProblem('hero.png', text('<!doctype html><p>hi'))).toEqual({
      code: 'unsupported-type',
      detail: 'unknown'
    });
    expect(binaryProblem('setup.exe', png)).toEqual({ code: 'unsupported-type', detail: 'name' });
    expect(binaryProblem('no-extension', png)).toEqual({
      code: 'unsupported-type',
      detail: 'name'
    });
  });

  it('refuses an SVG with a script', () => {
    expect(binaryProblem('a.svg', text('<svg onload="x()"/>'))).toEqual({
      code: 'unsafe-svg',
      detail: 'an event handler'
    });
  });
});

describe('paths', () => {
  it('names types by extension, jpeg too', () => {
    expect(typeOfPath('a/b.jpeg')).toBe('jpg');
    expect(typeOfPath('font.woff2')).toBe('woff2');
    expect(typeOfPath('a.ts')).toBeNull();
  });

  it('attaches raster images only', () => {
    expect(isAttachablePath('shot.png')).toBe(true);
    expect(isAttachablePath('photo.JPG')).toBe(true);
    expect(isAttachablePath('logo.svg')).toBe(false);
    expect(isAttachablePath('src/app.ts')).toBe(false);
  });
});
