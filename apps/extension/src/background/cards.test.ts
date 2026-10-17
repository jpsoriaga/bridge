import { describe, expect, it } from 'vitest';
import { BlockKey, type CardRecord } from '../messages';
import { blockKey, contentHash } from '../content/chat/keys';
import { CARD_MAX_AGE_MS, CardStore } from './cards';
import { memoryArea } from './store';

const DAY = 24 * 60 * 60_000;
const record = (state: CardRecord['state'], updatedAt: number): CardRecord => ({
  state,
  path: 'src/a.ts',
  updatedAt
});

describe('block keys', () => {
  it('are stable for the same block and match the schema', async () => {
    const a = blockKey('conv-1234', 'msg-1', 0, await contentHash('a.ts', 'x\n'));
    const b = blockKey('conv-1234', 'msg-1', 0, await contentHash('a.ts', 'x\n'));
    expect(a).toBe(b);
    expect(BlockKey.safeParse(a).success).toBe(true);
    expect(a).toMatch(/^conv-1234:msg-1:0:[0-9a-f]{16}$/);
  });

  it('differ when the content, path, index, message or conversation differ', async () => {
    const hash = await contentHash('a.ts', 'x\n');
    const keys = new Set([
      blockKey('conv-1234', 'msg-1', 0, hash),
      blockKey('conv-1234', 'msg-1', 0, await contentHash('a.ts', 'y\n')),
      blockKey('conv-1234', 'msg-1', 0, await contentHash('b.ts', 'x\n')),
      blockKey('conv-1234', 'msg-1', 1, hash),
      blockKey('conv-1234', 'msg-2', 0, hash),
      blockKey('conv-5678', 'msg-1', 0, hash)
    ]);
    expect(keys.size).toBe(6);
  });

  it('keep path and content apart in the hash', async () => {
    expect(await contentHash('ab', 'c')).not.toBe(await contentHash('a', 'bc'));
  });
});

describe('CardStore', () => {
  it('persists records across store instances (a page reload)', async () => {
    const area = memoryArea();
    const now = 1_000 * DAY;
    await new CardStore(area, () => now).set('k1', { ...record('applied', now), opId: 'op-1' });
    const reloaded = new CardStore(area, () => now);
    expect(await reloaded.get(['k1', 'missing'])).toEqual({
      k1: { ...record('applied', now), opId: 'op-1' }
    });
  });

  it('keeps every update when writes race', async () => {
    const area = memoryArea();
    const store = new CardStore(area, () => 0);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.set(`k${i}`, record('pending', 0)))
    );
    expect(
      Object.keys(await store.get(Array.from({ length: 20 }, (_, i) => `k${i}`)))
    ).toHaveLength(20);
  });

  it('prunes records older than 30 days on write and on prune()', async () => {
    let now = 100 * DAY;
    const area = memoryArea();
    const store = new CardStore(area, () => now);
    await store.set('old', record('applied', now - CARD_MAX_AGE_MS - 1));
    await store.set('edge', record('applied', now - CARD_MAX_AGE_MS));
    await store.set('fresh', record('pending', now));
    expect(Object.keys(await store.get(['old', 'edge', 'fresh']))).toEqual(['edge', 'fresh']);

    now += DAY;
    expect(await store.prune()).toBe(1);
    expect(Object.keys(area.data.cards as object)).toEqual(['fresh']);
  });

  it('drops malformed records instead of trusting storage', async () => {
    const area = memoryArea({
      cards: { good: record('rejected', 5), bad: { state: 'exploded', path: 1 } }
    });
    expect(await new CardStore(area, () => 5).get(['good', 'bad'])).toEqual({
      good: record('rejected', 5)
    });
  });

  it('counts applied and pending cards per conversation', async () => {
    const store = new CardStore(memoryArea(), () => 0);
    await store.set('conv-a:m:0:0000000000000000', record('applied', 0));
    await store.set('conv-a:m:1:0000000000000000', record('pending', 0));
    await store.set('conv-a:m:2:0000000000000000', record('pending', 0));
    await store.set('conv-a:m:3:0000000000000000', record('rejected', 0));
    await store.set('conv-b:m:0:0000000000000000', record('applied', 0));
    expect(await store.counts('conv-a')).toEqual({ applied: 1, pending: 2 });
  });
});
