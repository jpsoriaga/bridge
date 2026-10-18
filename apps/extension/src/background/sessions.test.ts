import { describe, expect, it } from 'vitest';
import { CardStore } from './cards';
import { Sessions } from './sessions';
import { memoryArea } from './store';

function setup() {
  const local = memoryArea();
  const cards = new CardStore(local, () => 1);
  const sessions = new Sessions(local, memoryArea(), cards, () => 1);
  return { local, cards, sessions };
}

describe('Sessions', () => {
  it('binds a session started in a new chat once the URL gets an id', async () => {
    const { sessions } = setup();
    await sessions.sync(1, null, 'ok');
    await sessions.start(1);
    expect(await sessions.stateFor(1)).toBe('active');
    expect(await sessions.activeConversation(1)).toBeNull();

    expect(await sessions.sync(1, 'conv-1234', 'ok')).toBe('active');
    expect(await sessions.activeConversation(1)).toBe('conv-1234');
    // Another tab opening the same conversation sees it's active elsewhere.
    expect(await sessions.sync(2, 'conv-1234', 'ok')).toBe('elsewhere');
    expect(await sessions.isActive(2)).toBe(false);
  });

  it('belongs to one tab: Move here hands it over, and the owner leaving does too', async () => {
    const { sessions } = setup();
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    expect(await sessions.sync(2, 'conv-1234', 'ok')).toBe('elsewhere');
    expect(await sessions.otherTabs(1, 'conv-1234')).toEqual([2]);

    expect(await sessions.moveHere(2)).toBe(1);
    expect(await sessions.stateFor(2)).toBe('active');
    expect(await sessions.stateFor(1)).toBe('elsewhere');
    expect(await sessions.moveHere(2)).toBeNull();

    // Tab 2 navigates away: tab 1 takes the session back on its next sync.
    await sessions.sync(2, 'conv-other', 'ok');
    expect(await sessions.sync(1, 'conv-1234', 'ok')).toBe('active');
    // A closed owner hands over too.
    await sessions.sync(3, 'conv-1234', 'ok');
    expect(await sessions.stateFor(3)).toBe('elsewhere');
    await sessions.removeTab(1);
    expect(await sessions.sync(3, 'conv-1234', 'ok')).toBe('active');
  });

  it('has no session in a conversation that never started one', async () => {
    const { sessions } = setup();
    expect(await sessions.sync(1, 'conv-other', 'ok')).toBeNull();
    expect(await sessions.isActive(1)).toBe(false);
  });

  it('ends a session but remembers it as ended', async () => {
    const { sessions } = setup();
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    await sessions.end(1);
    expect(await sessions.stateFor(1)).toBe('ended');
    expect(await sessions.isActive(1)).toBe(false);
    await sessions.start(1);
    expect(await sessions.stateFor(1)).toBe('active');
  });

  it('tracks files sent and card counts for the side panel', async () => {
    const { sessions, cards } = setup();
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    await sessions.addSent(1, [
      { path: 'a.ts', chars: 10, hash: 'a'.repeat(64) },
      { path: 'b.ts', chars: 20, hash: 'b'.repeat(64) }
    ]);
    await sessions.addSent(1, [{ path: 'a.ts', chars: 12, hash: 'c'.repeat(64) }]);
    await cards.set('conv-1234:m:0:0000000000000000', {
      state: 'applied',
      path: 'a',
      updatedAt: 1
    });
    await cards.set('conv-1234:m:1:0000000000000000', {
      state: 'pending',
      path: 'b',
      updatedAt: 1
    });
    expect(await sessions.panelState(1)).toEqual({
      tab: { conversationId: 'conv-1234', layout: 'ok' },
      session: {
        state: 'active',
        conversationId: 'conv-1234',
        startedAt: 1,
        context: [
          { path: 'b.ts', chars: 20, hash: 'b'.repeat(64), stale: false, missing: false },
          { path: 'a.ts', chars: 12, hash: 'c'.repeat(64), stale: false, missing: false }
        ],
        applied: 1,
        pending: 1
      }
    });
  });

  it('forgets a closed tab and its waiting session', async () => {
    const { sessions } = setup();
    await sessions.sync(1, null, 'unknown');
    await sessions.start(1);
    await sessions.removeTab(1);
    expect(await sessions.panelState(1)).toEqual({ tab: null, session: null });
  });

  it('marks files in context stale or missing by hash, and fresh again', async () => {
    const { sessions } = setup();
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    await sessions.addSent(1, [{ path: 'a.ts', chars: 5, hash: 'a'.repeat(64) }]);
    expect(await sessions.contextPaths()).toEqual(['a.ts']);

    expect(await sessions.noteDisk('a.ts', 'a'.repeat(64))).toBe(false);
    expect(await sessions.noteDisk('a.ts', 'f'.repeat(64))).toBe(true);
    expect((await sessions.context(1))[0]).toMatchObject({ stale: true, missing: false });
    await sessions.noteDisk('a.ts', null);
    expect((await sessions.context(1))[0]).toMatchObject({ stale: false, missing: true });
    await sessions.noteDisk('a.ts', 'a'.repeat(64));
    expect((await sessions.context(1))[0]).toMatchObject({ stale: false, missing: false });
    // Files nobody sent aren't tracked.
    expect(await sessions.noteDisk('other.ts', null)).toBe(false);
  });

  it('follows the chat’s own changes instead of calling them stale', async () => {
    const { sessions } = setup();
    await sessions.sync(1, 'conv-1234', 'ok');
    await sessions.start(1);
    await sessions.addSent(1, [
      { path: 'a.ts', chars: 5, hash: 'a'.repeat(64) },
      { path: 'b.ts', chars: 5, hash: 'b'.repeat(64) },
      { path: 'c.ts', chars: 5, hash: 'c'.repeat(64) }
    ]);
    await sessions.noteChanged(1, { kind: 'write', path: 'a.ts', hash: 'd'.repeat(64), chars: 9 });
    await sessions.noteChanged(1, { kind: 'delete', path: 'b.ts' });
    await sessions.noteChanged(1, { kind: 'rename', from: 'c.ts', to: 'lib/c.ts' });
    expect(await sessions.context(1)).toEqual([
      { path: 'a.ts', chars: 9, hash: 'd'.repeat(64), stale: false, missing: false },
      { path: 'lib/c.ts', chars: 5, hash: 'c'.repeat(64), stale: false, missing: false }
    ]);
    await sessions.removeContext(1, 'a.ts');
    expect((await sessions.context(1)).map((f) => f.path)).toEqual(['lib/c.ts']);
  });

  it('reads sessions saved before files had sizes and hashes', async () => {
    const { local, sessions } = setup();
    await local.set('sessions', {
      'conv-1234': { startedAt: 1, filesSent: ['old.ts'] }
    });
    await sessions.sync(1, 'conv-1234', 'ok');
    expect(await sessions.stateFor(1)).toBe('active');
    expect(await sessions.context(1)).toEqual([
      { path: 'old.ts', chars: 0, stale: false, missing: false }
    ]);
    // No hash to compare: never stale, only missing.
    await sessions.noteDisk('old.ts', 'e'.repeat(64));
    expect((await sessions.context(1))[0]?.stale).toBe(false);
  });
});
