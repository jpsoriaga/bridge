import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CardStore } from './background/cards';
import { Sessions } from './background/sessions';
import { memoryArea } from './background/store';
import { CardRecord, type ChangeCardRecord, type DiffCardRecord } from './messages';

// What Bridge keeps in chrome.storage.local (which content scripts, and so a compromised
// page script running there, could read): paths, hashes, counts and states. Never file
// contents, diffs, command output or the pairing key. And every runtime message listener
// checks its sender and the message's shape.

const SRC = fileURLToPath(new URL('.', import.meta.url));
/** A source path relative to src/, with forward slashes on every OS. */
const rel = (path: string) => relative(SRC, path).replace(/\\/g, '/');

function sources(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

describe('chrome.storage.local', () => {
  const diff: DiffCardRecord = { state: 'applied', path: 'src/a.ts', opId: 'op-1', updatedAt: 1 };
  const change: ChangeCardRecord = { card: 'change', state: 'applied', updatedAt: 1 };

  it.each(['content', 'diff', 'output', 'text', 'tokenHash', 'before'])(
    'card records refuse a %s field',
    (field) => {
      expect(CardRecord.safeParse({ ...diff, [field]: 'x' }).success).toBe(false);
      expect(CardRecord.safeParse({ ...change, [field]: 'x' }).success).toBe(false);
      expect(
        CardRecord.safeParse({ card: 'read', state: 'sent', updatedAt: 1, [field]: 'x' }).success
      ).toBe(false);
    }
  );

  it('stores only paths, hashes, counts and states, whatever a caller passes', async () => {
    const area = memoryArea();
    const cards = new CardStore(area, () => 1);
    await cards.set('conv-1234:m:0:0000000000000000', diff);
    await cards.set('conv-1234:m:1:0000000000000000', {
      ...diff,
      content: 'export const SECRET = 1;'
    } as DiffCardRecord);
    const sessions = new Sessions(area, memoryArea(), cards, () => 1);
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    await sessions.addSent(1, [{ path: 'a.ts', chars: 10, hash: 'a'.repeat(64) }]);

    const stored = JSON.stringify(await Promise.all([area.get('cards'), area.get('sessions')]));
    expect(stored).not.toContain('SECRET');
    expect(stored).toContain('a.ts');
    expect(Object.keys((await area.get('cards')) as object)).toEqual([
      'conv-1234:m:0:0000000000000000'
    ]);
  });

  it('is written only by the card store, sessions, the port, the chip corner and the tip', () => {
    const writers = sources()
      .filter((path) => /storage\.local\.set|local\.set\(/.test(readFileSync(path, 'utf8')))
      .map(rel)
      .sort();
    expect(writers).toEqual(['background/index.ts', 'background/sessions.ts']);
    const index = readFileSync(join(SRC, 'background/index.ts'), 'utf8');
    expect(index.match(/chrome\.storage\.local\.set\(\{ (\w+)/g)).toEqual([
      'chrome.storage.local.set({ port',
      'chrome.storage.local.set({ chipCorner',
      'chrome.storage.local.set({ backgroundTipSeen'
    ]);
  });
});

describe('runtime message listeners', () => {
  const all = sources().map((path) => ({
    path: rel(path),
    text: readFileSync(join(path), 'utf8')
  }));

  it('never listen to other extensions or web pages', () => {
    for (const { path, text } of all) {
      expect(text, path).not.toMatch(/onMessageExternal|onConnectExternal/);
    }
  });

  it('each check the sender and parse the message with zod before acting', () => {
    const listeners = all.flatMap(({ path, text }) =>
      [...text.matchAll(/\b(?:runtime|port)\.on(?:Message|Connect)\.addListener\(/g)].map((m) => ({
        path,
        body: text.slice(m.index, m.index + 700)
      }))
    );
    expect(listeners.map((l) => l.path).sort()).toEqual([
      'background/clock.ts',
      'background/index.ts',
      'background/index.ts',
      'background/index.ts',
      'content/chat/clock.ts',
      'content/index.ts',
      'sidepanel/App.tsx'
    ]);
    for (const { path, body } of listeners) {
      // A port's messages come from whoever connected: `onConnect` checked that already.
      if (!/port\.onMessage/.test(body)) {
        expect(body, path).toMatch(/sender|classifySender|port\.name/);
      }
      if (/onConnect\.addListener/.test(body)) continue; // Its messages: the next listener.
      expect(body, path).toMatch(/\.safeParse\(/);
    }
  });
});
