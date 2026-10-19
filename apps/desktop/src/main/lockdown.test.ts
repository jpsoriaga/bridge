import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { lockDownContents, lockDownSession, type ContentsLike, type SessionLike } from './lockdown';

function fakeSession() {
  const handlers: {
    request?: Parameters<SessionLike['setPermissionRequestHandler']>[0];
    check?: Parameters<SessionLike['setPermissionCheckHandler']>[0];
  } = {};
  const session: SessionLike = {
    setPermissionRequestHandler: (h) => (handlers.request = h),
    setPermissionCheckHandler: (h) => (handlers.check = h)
  };
  return { session, handlers };
}

function fakeContents() {
  const emitter = new EventEmitter();
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | undefined;
  const contents: ContentsLike = {
    on: (event: string, listener: (event: { preventDefault(): void }) => void) =>
      emitter.on(event, listener),
    setWindowOpenHandler: (h) => (openHandler = h)
  };
  const fire = (event: string) => {
    const preventDefault = vi.fn();
    emitter.emit(event, { preventDefault });
    return preventDefault.mock.calls.length > 0;
  };
  return { contents, fire, open: (url: string) => openHandler!({ url }) };
}

describe('lockDownSession', () => {
  it.each(['media', 'notifications', 'clipboard-read', 'geolocation', 'openExternal', 'hid'])(
    'refuses a %s request and check',
    (permission) => {
      const { session, handlers } = fakeSession();
      lockDownSession(session);
      const callback = vi.fn();
      handlers.request!(null, permission, callback);
      expect(callback).toHaveBeenCalledWith(false);
      expect(handlers.check!(null, permission, 'file://', {})).toBe(false);
    }
  );
});

describe('lockDownContents', () => {
  it('blocks navigation, redirects and webviews', () => {
    const { contents, fire } = fakeContents();
    lockDownContents(contents);
    expect(fire('will-navigate')).toBe(true);
    expect(fire('will-redirect')).toBe(true);
    expect(fire('will-attach-webview')).toBe(true);
  });

  it('denies every new window, sending only https links to the browser', () => {
    const { contents, open } = fakeContents();
    const external = vi.fn();
    lockDownContents(contents, external);
    for (const url of [
      'https://example.com',
      'http://example.com',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank'
    ]) {
      expect(open(url)).toEqual({ action: 'deny' });
    }
    expect(external.mock.calls).toEqual([['https://example.com']]);
  });
});
