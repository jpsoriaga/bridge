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
    // Another tab opening the same conversation sees the same session.
    expect(await sessions.sync(2, 'conv-1234', 'ok')).toBe('active');
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
    await sessions.addSent(1, ['a.ts', 'b.ts']);
    await sessions.addSent(1, ['a.ts']);
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
        filesSent: ['a.ts', 'b.ts'],
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
});
