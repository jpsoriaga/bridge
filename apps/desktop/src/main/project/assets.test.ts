import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, UPLOAD_CHUNK_BYTES, type FileRequest, type Mode } from '@bridge/shared';
import { GatedFiles, guardedFiles, NO_AUTO_APPROVE, type AutoApprove } from '../policy';
import { settingsFile } from '../settings';
import type { DownloadDeps } from './download';
import { ProjectService } from './service';
import { tempProject } from './test-utils';

// Binary writes, downloads and "Also approve automatically" as the server answers them:
// guardedFiles (the mode, gated files, the setting) in front of ProjectService (the sandbox).

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const HTML = Buffer.from('<!DOCTYPE html><html><body><script>steal()</script></body></html>');
const SCRIPTED_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>'
);

let project: ReturnType<typeof tempProject>;
let service: ProjectService;
let mode: Mode;
let approve: AutoApprove;
let handle: (request: FileRequest) => Promise<unknown>;
const routes = new Map<string, Buffer>();

const req = <T extends FileRequest['type']>(
  type: T,
  payload: Extract<FileRequest, { type: T }>['payload']
) => ({ v: PROTOCOL_VERSION, id: 'r1', type, payload }) as FileRequest;

const net: DownloadDeps = {
  resolve: async () => [{ address: '93.184.216.34', family: 4 }],
  get: async (url) => {
    const body = routes.get(url.href);
    if (!body) throw new Error('ENOTFOUND');
    return { status: 200, headers: {}, body: Readable.from([body]), destroy: () => undefined };
  }
};

beforeEach(async () => {
  project = tempProject('bridge-assets-');
  const userData = join(project.base, 'userData');
  mkdirSync(userData);
  service = new ProjectService({
    settings: settingsFile(join(userData, 'settings.json')),
    backupsDir: join(userData, 'backups'),
    homeDir: join(project.base, 'home'),
    protectedDirs: [userData],
    download: net
  });
  await service.open(project.root);
  mode = 'manual';
  approve = NO_AUTO_APPROVE;
  handle = guardedFiles(
    service,
    () => mode,
    () => new GatedFiles(),
    () => approve
  );
  routes.clear();
});
afterEach(() => project.cleanup());

/** Sends `data` the way the extension does, in chunks, then commits it. */
let uploads = 0;
async function upload(path: string, data: Buffer, trigger: 'click' | 'auto' = 'click', extra = {}) {
  uploads += 1;
  const uploadId = `up-${uploads}`;
  for (let offset = 0; offset < data.length || offset === 0; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64');
    const sent = await handle(req('upload', { uploadId, offset, data: chunk }));
    expect(sent).toMatchObject({ ok: true });
    if (data.length === 0) break;
  }
  return handle(
    req('write_binary', {
      path,
      uploadId,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      trigger,
      ...extra
    })
  );
}

describe('binary writes through the server', () => {
  it('writes an image sent in chunks, and refuses one that doesn’t add up', async () => {
    expect(await upload('public/hero.png', PNG)).toMatchObject({
      ok: true,
      result: { kind: 'create' }
    });
    expect(readFileSync(join(project.root, 'public/hero.png')).equals(PNG)).toBe(true);
    const wrong = await handle(
      req('write_binary', {
        path: 'public/other.png',
        uploadId: 'never-sent',
        size: 3,
        sha256: '0'.repeat(64),
        trigger: 'click'
      })
    );
    expect(wrong).toMatchObject({ ok: false, error: { code: 'upload' } });
  });

  it('follows the mode: no automatic write in Manual, and gated paths wait for a click', async () => {
    expect(await upload('hero.png', PNG, 'auto')).toMatchObject({
      ok: false,
      error: { code: 'mode' }
    });
    mode = 'auto-apply';
    expect(await upload('hero.png', PNG, 'auto')).toMatchObject({ ok: true });
  });

  it('labels only what the setting allowed as auto-approved, never the extension’s word alone', async () => {
    mode = 'full-auto';
    await upload('a.png', PNG, 'auto', { autoApproved: true });
    const [entry] = service.activity();
    expect(entry).toMatchObject({ path: 'a.png', trigger: 'auto', binary: true });
    expect(entry?.autoApproved).toBeUndefined();
  });
});

describe('downloads through the server', () => {
  it('downloads on a click, checks the type from the bytes, and undo removes it', async () => {
    routes.set('https://example.com/logo.png', PNG);
    const outcome = await handle(
      req('download', {
        url: 'https://example.com/logo.png',
        path: 'public/logo.png',
        trigger: 'click'
      })
    );
    expect(outcome).toMatchObject({
      ok: true,
      result: { kind: 'create', size: PNG.length, mime: 'image/png' }
    });
    const [entry] = service.activity();
    expect(entry).toMatchObject({ origin: 'download', binary: true, source: 'chat' });
    await service.undo(entry!.opId!);
    expect(existsSync(join(project.root, 'public/logo.png'))).toBe(false);
  });

  it('always needs a click, in every mode, with every setting on', async () => {
    routes.set('https://example.com/logo.png', PNG);
    approve = { changes: true, gated: true, partial: true };
    for (const m of ['manual', 'auto-apply', 'full-auto'] as const) {
      mode = m;
      expect(
        await handle(
          req('download', {
            url: 'https://example.com/logo.png',
            path: 'logo.png',
            trigger: 'auto'
          })
        )
      ).toMatchObject({ ok: false, error: { code: 'mode' } });
    }
    expect(existsSync(join(project.root, 'logo.png'))).toBe(false);
  });

  it('refuses a .png that is really a web page, and an SVG with a script', async () => {
    routes.set('https://example.com/fake.png', HTML);
    routes.set('https://example.com/bad.svg', SCRIPTED_SVG);
    expect(
      await handle(
        req('download', { url: 'https://example.com/fake.png', path: 'fake.png', trigger: 'click' })
      )
    ).toMatchObject({ ok: false, error: { code: 'unsupported-type' } });
    expect(
      await handle(
        req('download', { url: 'https://example.com/bad.svg', path: 'bad.svg', trigger: 'click' })
      )
    ).toMatchObject({ ok: false, error: { code: 'unsafe-svg' } });
    expect(existsSync(join(project.root, 'fake.png'))).toBe(false);
    expect(existsSync(join(project.root, 'bad.svg'))).toBe(false);
  });

  it('checks the path before reaching the network', async () => {
    let asked = 0;
    const counted = new ProjectService({
      settings: settingsFile(join(project.base, 'userData', 'other.json')),
      backupsDir: join(project.base, 'userData', 'backups'),
      homeDir: join(project.base, 'home'),
      protectedDirs: [join(project.base, 'userData')],
      download: { ...net, get: async (...args) => (asked++, net.get!(...args)) }
    });
    await counted.open(project.root);
    expect(
      await counted.handle(
        req('download', { url: 'https://example.com/x.png', path: '.env', trigger: 'click' })
      )
    ).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(
      await counted.handle(
        req('download', { url: 'http://example.com/x.png', path: 'x.png', trigger: 'click' })
      )
    ).toMatchObject({ ok: false, error: { code: 'not-https' } });
    expect(asked).toBe(0);
  });
});

describe('Also approve automatically', () => {
  const hashOf = (rel: string) =>
    createHash('sha256')
      .update(readFileSync(join(project.root, rel)))
      .digest('hex');

  it('lets Full auto write a gated file only with “gated files” on, and labels it', async () => {
    project.write('package.json', '{}\n');
    const write = () =>
      handle(
        req('write', {
          path: 'package.json',
          content: '{ "name": "x" }\n',
          baseHash: hashOf('package.json'),
          trigger: 'auto'
        })
      );
    mode = 'full-auto';
    expect(await write()).toMatchObject({ ok: false, error: { code: 'gated' } });
    approve = { ...NO_AUTO_APPROVE, gated: true };
    expect(await write()).toMatchObject({ ok: true });
    expect(service.activity()[0]).toMatchObject({ path: 'package.json', autoApproved: true });
    // Auto-apply never approves a gated file, whatever the setting.
    mode = 'auto-apply';
    expect(
      await handle(
        req('write', {
          path: 'package.json',
          content: '{}\n',
          baseHash: hashOf('package.json'),
          trigger: 'auto'
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'gated' } });
  });

  it('lets Full auto delete and rename only with “deletes and renames” on, and labels them', async () => {
    project.write('old.ts', 'a');
    project.write('move.ts', 'b');
    mode = 'full-auto';
    const del = () =>
      handle(req('delete', { path: 'old.ts', baseHash: hashOf('old.ts'), trigger: 'auto' }));
    expect(await del()).toMatchObject({ ok: false, error: { code: 'mode' } });
    approve = { ...NO_AUTO_APPROVE, changes: true };
    expect(await del()).toMatchObject({ ok: true });
    expect(
      await handle(
        req('rename', {
          from: 'move.ts',
          to: 'moved.ts',
          baseHash: hashOf('move.ts'),
          trigger: 'auto'
        })
      )
    ).toMatchObject({ ok: true });
    const [rename, remove] = service.activity();
    expect(rename).toMatchObject({ kind: 'rename', trigger: 'auto', autoApproved: true });
    expect(remove).toMatchObject({ kind: 'delete', trigger: 'auto', autoApproved: true });
    // Undo still works for both.
    await service.undo(rename!.opId!);
    await service.undo(remove!.opId!);
    expect(readFileSync(join(project.root, 'old.ts'), 'utf8')).toBe('a');
    expect(readFileSync(join(project.root, 'move.ts'), 'utf8')).toBe('b');
  });

  it('keeps a delete of a gated file for a click unless gated files are on too', async () => {
    project.write('package-lock.json', '{}');
    mode = 'full-auto';
    approve = { ...NO_AUTO_APPROVE, changes: true };
    const del = () =>
      handle(
        req('delete', {
          path: 'package-lock.json',
          baseHash: hashOf('package-lock.json'),
          trigger: 'auto'
        })
      );
    expect(await del()).toMatchObject({ ok: false, error: { code: 'gated' } });
    approve = { changes: true, gated: true, partial: false };
    expect(await del()).toMatchObject({ ok: true });
  });

  it('labels a partial-looking write as auto-approved only while that setting is on', async () => {
    mode = 'full-auto';
    const write = (path: string) =>
      handle(req('write', { path, content: 'x\n', trigger: 'auto', autoApproved: true }));
    await write('a.ts');
    expect(service.activity()[0]?.autoApproved).toBeUndefined();
    approve = { ...NO_AUTO_APPROVE, partial: true };
    await write('b.ts');
    expect(service.activity()[0]).toMatchObject({ path: 'b.ts', autoApproved: true });
  });

  it('never lets anything reach a protected file', async () => {
    mode = 'full-auto';
    approve = { changes: true, gated: true, partial: true };
    expect(
      await handle(req('write', { path: '.env', content: 'X=1\n', trigger: 'auto' }))
    ).toMatchObject({
      ok: false,
      error: { code: 'denied' }
    });
    expect(await upload('.git/x.png', PNG, 'auto')).toMatchObject({
      ok: false,
      error: { code: 'denied' }
    });
  });

  it('never overwrites a file that changed on disk', async () => {
    project.write('package.json', '{}\n');
    mode = 'full-auto';
    approve = { changes: true, gated: true, partial: true };
    expect(
      await handle(
        req('write', {
          path: 'package.json',
          content: '{"a":1}\n',
          baseHash: 'f'.repeat(64),
          trigger: 'auto'
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});
