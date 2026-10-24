import { createHash } from 'node:crypto';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_BINARY_BYTES, UPLOAD_CHUNK_BYTES } from '@bridge/shared';
import { checkUrl, download, isPrivateAddress, safeLookup, type DownloadDeps } from './download';
import { History } from './history';
import { FileOpError, readBinary, sha256, undo, writeBinary } from './operations';
import { Sandbox } from './sandbox';
import { canSymlink, tempProject } from './test-utils';
import { UPLOAD_TTL_MS, Uploads } from './uploads';

/** The smallest real PNG: one transparent pixel. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect/></svg>'
);

let project: ReturnType<typeof tempProject>;
let sandbox: Sandbox;
let history: History;

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FileOpError) return error.code;
    throw error;
  }
  throw new Error('expected a FileOpError');
}

beforeEach(async () => {
  project = tempProject('bridge-binary-');
  sandbox = await Sandbox.create(project.root);
  history = await History.open(join(project.base, 'userData/backups/p1'));
});
afterEach(() => project.cleanup());

describe('writeBinary', () => {
  it('creates a file with exactly the bytes, backed up, and undo removes it', async () => {
    const result = await writeBinary(sandbox, history, {
      path: 'public/pixel.png',
      data: PNG,
      source: 'chat',
      trigger: 'click'
    });
    expect(result.kind).toBe('create');
    expect(readFileSync(join(project.root, 'public/pixel.png')).equals(PNG)).toBe(true);
    expect(history.get(result.opId)).toMatchObject({
      kind: 'create',
      binary: true,
      source: 'chat'
    });
    await undo(sandbox, history, result.opId);
    expect(existsSync(join(project.root, 'public/pixel.png'))).toBe(false);
  });

  it('replaces a file only on the hash it saw, and undo puts the old bytes back', async () => {
    const old = project.write('logo.svg', SVG);
    await expect(
      codeOf(writeBinary(sandbox, history, { path: 'logo.svg', data: SVG, trigger: 'click' }))
    ).resolves.toBe('exists');
    await expect(
      codeOf(
        writeBinary(sandbox, history, {
          path: 'logo.svg',
          data: SVG,
          baseHash: 'f'.repeat(64),
          trigger: 'click'
        })
      )
    ).resolves.toBe('conflict');
    const next = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
    const result = await writeBinary(sandbox, history, {
      path: 'logo.svg',
      data: next,
      baseHash: sha256(SVG),
      trigger: 'auto',
      autoApproved: true
    });
    expect(result.kind).toBe('modify');
    expect(history.get(result.opId)).toMatchObject({ trigger: 'auto', autoApproved: true });
    expect(readFileSync(old).equals(next)).toBe(true);
    await undo(sandbox, history, result.opId);
    expect(readFileSync(old).equals(SVG)).toBe(true);
  });

  it('goes through the sandbox and the denylist like a text write', async () => {
    const write = (path: string) =>
      codeOf(writeBinary(sandbox, history, { path, data: PNG, trigger: 'click' }));
    expect(await write('../outside.png')).toBe('traversal');
    expect(await write('/tmp/x.png')).toBe('absolute-path');
    expect(await write('.git/x.png')).toBe('denied');
    expect(await write('node_modules/x.png')).toBe('denied');
    expect(await write('.env.png')).toBe('denied');
  });

  it.skipIf(!canSymlink())('refuses a folder that is a link out of the project', async () => {
    symlinkSync(project.base, join(project.root, 'out'), 'junction');
    await expect(
      codeOf(writeBinary(sandbox, history, { path: 'out/x.png', data: PNG, trigger: 'click' }))
    ).resolves.toBe('outside-root');
  });

  it('writes only the type the path names, checked from the bytes', async () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    expect(
      await codeOf(
        writeBinary(sandbox, history, { path: 'hero.png', data: html, trigger: 'click' })
      )
    ).toBe('unsupported-type');
    expect(
      await codeOf(writeBinary(sandbox, history, { path: 'hero.jpg', data: PNG, trigger: 'click' }))
    ).toBe('unsupported-type');
    expect(
      await codeOf(writeBinary(sandbox, history, { path: 'tool.exe', data: PNG, trigger: 'click' }))
    ).toBe('unsupported-type');
    const script = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(
      await codeOf(writeBinary(sandbox, history, { path: 'a.svg', data: script, trigger: 'click' }))
    ).toBe('unsafe-svg');
  });

  it(`refuses more than ${MAX_BINARY_BYTES / 1024 / 1024} MB`, async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_BINARY_BYTES)]);
    expect(
      await codeOf(writeBinary(sandbox, history, { path: 'big.png', data: big, trigger: 'click' }))
    ).toBe('too-large');
  });
});

describe('readBinary', () => {
  it('reads any file as base64 with its sniffed type, through the sandbox', async () => {
    project.write('shot.png', PNG);
    expect(await readBinary(sandbox, 'shot.png')).toEqual({
      data: PNG.toString('base64'),
      size: PNG.length,
      hash: sha256(PNG),
      mime: 'image/png'
    });
    project.write('.env', 'SECRET=1');
    expect(await codeOf(readBinary(sandbox, '.env'))).toBe('denied');
    expect(await codeOf(readBinary(sandbox, 'missing.png'))).toBe('not-found');
  });
});

describe('Uploads', () => {
  const b64 = (data: Buffer) => data.toString('base64');
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

  it('puts chunks together in order and hands them over once', () => {
    const uploads = new Uploads();
    const data = Buffer.from('0123456789');
    expect(uploads.add({ uploadId: 'u1', offset: 0, data: b64(data.subarray(0, 6)) })).toBe(6);
    expect(uploads.add({ uploadId: 'u1', offset: 6, data: b64(data.subarray(6)) })).toBe(10);
    expect(uploads.take('u1', 10, hash(data))?.equals(data)).toBe(true);
    expect(uploads.take('u1', 10, hash(data))).toBeNull();
  });

  it('refuses a chunk out of order, a wrong size or hash, and too many at once', () => {
    const uploads = new Uploads();
    expect(uploads.add({ uploadId: 'a', offset: 3, data: 'AAAA' })).toBeNull();
    expect(uploads.add({ uploadId: 'a', offset: 0, data: 'AAAA' })).toBe(3);
    expect(uploads.add({ uploadId: 'a', offset: 1, data: 'AAAA' })).toBeNull();
    expect(uploads.take('a', 3, hash(Buffer.alloc(3)))).toBeNull();
    uploads.add({ uploadId: 'b', offset: 0, data: 'AAAA' });
    expect(uploads.take('b', 4, hash(Buffer.alloc(3)))).toBeNull();
    uploads.add({ uploadId: 'c', offset: 0, data: 'AAAA' });
    uploads.add({ uploadId: 'd', offset: 0, data: 'AAAA' });
    expect(uploads.add({ uploadId: 'e', offset: 0, data: 'AAAA' })).toBeNull();
  });

  it(`stops past ${MAX_BINARY_BYTES / 1024 / 1024} MB, and forgets an upload after a minute`, () => {
    let now = 0;
    const uploads = new Uploads(() => now);
    const chunk = Buffer.alloc(UPLOAD_CHUNK_BYTES).toString('base64');
    let offset = 0;
    for (let i = 0; i < MAX_BINARY_BYTES / UPLOAD_CHUNK_BYTES; i += 1) {
      expect(uploads.add({ uploadId: 'big', offset, data: chunk })).not.toBeNull();
      offset += UPLOAD_CHUNK_BYTES;
    }
    expect(uploads.add({ uploadId: 'big', offset, data: 'AAAA' })).toBeNull();
    uploads.add({ uploadId: 'slow', offset: 0, data: 'AAAA' });
    now = UPLOAD_TTL_MS + 1;
    expect(uploads.take('slow', 3, hash(Buffer.alloc(3)))).toBeNull();
  });
});

/** A fake network: each URL answers with a status, headers and body. */
function network(
  routes: Record<string, { status?: number; headers?: Record<string, string>; body?: Buffer }>
) {
  const asked: string[] = [];
  const get: NonNullable<DownloadDeps['get']> = async (url) => {
    asked.push(url.href);
    const route = routes[url.href];
    if (!route) throw new Error('ENOTFOUND');
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body: Readable.from(route.body ? [route.body] : []),
      destroy: () => undefined
    };
  };
  return { get, asked, resolve: async () => [{ address: '93.184.216.34', family: 4 }] };
}

describe('download', () => {
  it('fetches an https URL, following https redirects', async () => {
    const net = network({
      'https://example.com/logo.svg': {
        status: 302,
        headers: { location: '/cdn/logo.svg' }
      },
      'https://example.com/cdn/logo.svg': { body: SVG }
    });
    expect((await download('https://example.com/logo.svg', net)).equals(SVG)).toBe(true);
    expect(net.asked).toEqual(['https://example.com/logo.svg', 'https://example.com/cdn/logo.svg']);
  });

  it('downloads https only, and never follows a redirect to http', async () => {
    const net = network({
      'https://example.com/a.png': {
        status: 301,
        headers: { location: 'http://example.com/a.png' }
      }
    });
    expect(await codeOf(download('http://example.com/a.png', net))).toBe('not-https');
    expect(await codeOf(download('file:///etc/passwd', net))).toBe('not-https');
    expect(await codeOf(download('https://example.com/a.png', net))).toBe('not-https');
  });

  it('never reaches this computer or the local network', async () => {
    const net = network({});
    for (const url of [
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://[::1]/a.png',
      'https://10.0.0.1/a.png',
      'https://192.168.1.1/a.png',
      'https://169.254.169.254/latest/meta-data',
      'https://router.local/a.png',
      'https://intranet/a.png'
    ]) {
      expect(await codeOf(download(url, net)), url).toBe('private-address');
    }
    expect(net.asked).toEqual([]);
  });

  it('refuses a name that resolves to a local address when connecting', async () => {
    const lookup = safeLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      lookup('rebind.example', {}, (e) => resolve(e))
    );
    expect(error?.code).toBe('EPRIVATE');
    const ok = await new Promise<string>((resolve) =>
      safeLookup(async () => [{ address: '93.184.216.34', family: 4 }])(
        'example.com',
        {},
        (_e, address) => resolve(address as string)
      )
    );
    expect(ok).toBe('93.184.216.34');
  });

  it(`stops at ${MAX_BINARY_BYTES / 1024 / 1024} MB, declared or not`, async () => {
    const big = Buffer.alloc(64);
    const net = network({
      'https://example.com/declared.mp4': {
        headers: { 'content-length': String(MAX_BINARY_BYTES + 1) }
      },
      'https://example.com/streamed.mp4': { body: big }
    });
    expect(await codeOf(download('https://example.com/declared.mp4', net))).toBe('too-large');
    expect(
      await codeOf(download('https://example.com/streamed.mp4', { ...net, maxBytes: 63 }))
    ).toBe('too-large');
  });

  it('fails on an error status, a dead host, or too many redirects', async () => {
    const loop: Record<string, { status: number; headers: Record<string, string> }> = {};
    for (let i = 0; i < 10; i += 1) {
      loop[`https://example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    }
    const net = network({ 'https://example.com/404.png': { status: 404 }, ...loop });
    expect(await codeOf(download('https://example.com/404.png', net))).toBe('download-failed');
    expect(await codeOf(download('https://gone.example/a.png', net))).toBe('download-failed');
    expect(await codeOf(download('https://example.com/0', net))).toBe('download-failed');
    expect(await codeOf(download('https://user:pw@example.com/a.png', net))).toBe(
      'download-failed'
    );
  });

  it('knows which addresses are local', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.0.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '224.0.0.1'
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    expect(checkUrl('https://example.com/a.png').hostname).toBe('example.com');
  });
});
