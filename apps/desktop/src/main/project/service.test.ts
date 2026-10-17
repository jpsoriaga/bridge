import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type FileRequest } from '@bridge/shared';
import { settingsFile } from '../settings';
import { displayPath, ProjectService } from './service';
import { tempProject } from './test-utils';

let project: ReturnType<typeof tempProject>;
let userData: string;
let service: ProjectService;
let changes: number;

const req = <T extends FileRequest['type']>(
  type: T,
  payload: Extract<FileRequest, { type: T }>['payload']
) => ({ v: PROTOCOL_VERSION, id: 'r1', type, payload }) as FileRequest;

beforeEach(() => {
  project = tempProject();
  userData = join(project.base, 'userData');
  mkdirSync(userData);
  changes = 0;
  service = new ProjectService({
    settings: settingsFile(join(userData, 'settings.json')),
    backupsDir: join(userData, 'backups'),
    homeDir: join(project.base, 'home'),
    protectedDirs: [userData],
    onChange: () => changes++
  });
});
afterEach(() => project.cleanup());

describe('ProjectService', () => {
  it('answers every operation with no-project before a folder is open', async () => {
    for (const request of [
      req('tree', {}),
      req('read', { path: 'a.txt' }),
      req('write', { path: 'a.txt', content: 'x' }),
      req('undo', { opId: 'x' })
    ]) {
      expect(await service.handle(request)).toMatchObject({
        ok: false,
        error: { code: 'no-project' }
      });
    }
  });

  it('opens a folder, remembers it and reopens it on launch', async () => {
    const result = await service.open(project.root);
    expect(result).toEqual({ ok: true, project: { name: 'project', path: project.root } });
    expect(changes).toBe(1);

    const again = new ProjectService({
      settings: settingsFile(join(userData, 'settings.json')),
      backupsDir: join(userData, 'backups'),
      homeDir: join(project.base, 'home'),
      protectedDirs: [userData]
    });
    await again.restore();
    expect(again.project?.path).toBe(project.root);
  });

  it('forgets a last project that no longer exists', async () => {
    const gone = join(project.base, 'gone');
    mkdirSync(gone);
    await service.open(gone);
    project.cleanup();
    mkdirSync(userData, { recursive: true });
    const again = new ProjectService({
      settings: settingsFile(join(userData, 'settings.json')),
      backupsDir: join(userData, 'backups'),
      homeDir: project.base,
      protectedDirs: []
    });
    await again.restore();
    expect(again.project).toBeNull();
  });

  it('keeps 5 recent projects, newest first, without duplicates', async () => {
    const dirs = Array.from({ length: 7 }, (_, i) => {
      const dir = join(project.base, `p${i}`);
      mkdirSync(dir);
      return dir;
    });
    for (const dir of dirs) await service.open(dir);
    await service.open(dirs[3]!);
    expect(service.recentProjects.map((p) => p.name)).toEqual(['p3', 'p6', 'p5', 'p4', 'p2']);
    expect((await service.openRecent(4))?.ok).toBe(true);
    expect(service.project?.name).toBe('p2');
    expect(service.openRecent(9)).toBeNull();
  });

  it('shortens the home folder to ~ for display', async () => {
    const home = join(project.base, 'home');
    mkdirSync(join(home, 'code/app'), { recursive: true });
    await service.open(join(home, 'code/app'));
    expect(service.project).toEqual({ name: 'app', path: '~/code/app' });
  });

  it('refuses a file, the filesystem root, home, and anything overlapping userData', async () => {
    const file = project.write('file.txt', '');
    mkdirSync(join(project.base, 'home'));
    mkdirSync(join(userData, 'inner'));
    expect(await service.open(file)).toEqual({ ok: false, reason: 'not-a-directory' });
    expect(await service.open(join(project.base, 'nope'))).toEqual({
      ok: false,
      reason: 'not-a-directory'
    });
    expect(await service.open('/')).toEqual({ ok: false, reason: 'too-broad' });
    expect(await service.open(join(project.base, 'home'))).toEqual({
      ok: false,
      reason: 'too-broad'
    });
    for (const dir of [userData, join(userData, 'inner'), project.base]) {
      expect(await service.open(dir)).toEqual({ ok: false, reason: 'protected' });
    }
    expect(service.project).toBeNull();
  });

  it('keeps backups in userData, never in the project', async () => {
    await service.open(project.root);
    await service.handle(req('write', { path: 'a.txt', content: 'x' }));
    expect(readFileSync(join(project.root, 'a.txt'), 'utf8')).toBe('x');
    expect(readdirSync(project.root)).toEqual(['a.txt']);
    expect(readdirSync(join(userData, 'backups'))).toHaveLength(1);
  });

  it('logs refusals to the activity feed and never echoes an absolute path', async () => {
    await service.open(project.root);
    const outcome = await service.handle(req('read', { path: '../../etc/passwd' }));
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'traversal', message: expect.any(String) }
    });
    expect(JSON.stringify(outcome)).not.toContain(project.root);
    expect(service.activity()[0]).toMatchObject({
      kind: 'rejected',
      code: 'traversal',
      path: '../../etc/passwd',
      op: 'read'
    });
  });

  it('never leaks paths in other refusals either', async () => {
    await service.open(project.root);
    mkdirSync(join(project.root, 'locked'));
    writeFileSync(join(project.root, 'locked/a.txt'), 'x');
    const outcome = await service.handle(req('read', { path: 'locked/a.txt/deeper' }));
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(project.base);
  });

  it('lists writes in the activity feed and marks them undone', async () => {
    await service.open(project.root);
    const write = await service.handle(req('write', { path: 'a.txt', content: 'x' }));
    if (!write.ok) throw new Error('write failed');
    const { opId } = write.result as { opId: string };
    expect(service.activity()[0]).toMatchObject({
      kind: 'create',
      path: 'a.txt',
      opId,
      undone: false
    });
    expect(service.lastUndoable()).toBe(opId);
    expect(await service.undo(opId)).toMatchObject({ ok: true });
    expect(service.activity()[0]).toMatchObject({ opId, undone: true });
    expect(service.lastUndoable()).toBeNull();
  });

  it('runs writes one at a time', async () => {
    await service.open(project.root);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.handle(req('write', { path: 'same.txt', content: 'x' }))
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error.code === 'exists')).toHaveLength(4);
  });

  it('applies new deny patterns immediately', async () => {
    await service.open(project.root);
    project.write('secrets/a.txt', 'x');
    expect((await service.handle(req('read', { path: 'secrets/a.txt' }))).ok).toBe(true);
    await service.setDenyPatterns(['secrets/']);
    expect(await service.handle(req('read', { path: 'secrets/a.txt' }))).toMatchObject({
      ok: false,
      error: { code: 'denied' }
    });
    expect(service.denyPatterns).toEqual(['secrets/']);
  });
});

describe('displayPath', () => {
  it('strips control characters and caps length', () => {
    expect(displayPath('a\0b\nc')).toBe('a�b�c');
    expect(displayPath('x'.repeat(300))).toHaveLength(200);
    expect(displayPath(42)).toBe('(not a path)');
  });
});
