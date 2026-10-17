import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloseCode, DEFAULT_PORT, serverMessage, type ConnectionStatus } from '@bridge/shared';
import { Connection, PING_INTERVAL_MS, type ConnectionStorage } from './connection';

const TOKEN = 'b'.repeat(64);

/** Just enough of a browser WebSocket for the connection manager. */
class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1005) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function memoryStorage(token: string | null = TOKEN): ConnectionStorage & { token: string | null } {
  let port: number | null = null;
  return {
    token,
    async getToken() {
      return this.token;
    },
    async setToken(next) {
      this.token = next;
    },
    async getPort() {
      return port;
    },
    async setPort(next) {
      port = next;
    }
  };
}

let appRunning: boolean;
let sockets: FakeSocket[];
let statuses: ConnectionStatus[];

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!appRunning || !url.startsWith(`http://127.0.0.1:${DEFAULT_PORT}/`)) {
    throw new TypeError('Failed to fetch');
  }
  if (url.endsWith('/health')) return Response.json({ name: 'bridge', version: '0.1.0' });
  if (url.endsWith('/pair')) {
    const { code } = JSON.parse(String(init?.body)) as { code: string };
    return code === '123456'
      ? Response.json({ token: TOKEN })
      : Response.json({ error: 'invalid_code' }, { status: 401 });
  }
  return new Response(null, { status: 204 });
});

function makeConnection(storage = memoryStorage()) {
  const connection = new Connection({
    storage,
    fetch: fakeFetch as typeof fetch,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    randomId: () => 'id'
  });
  connection.onStatus((s) => statuses.push(s));
  return { connection, storage };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  appRunning = true;
  sockets = [];
  statuses = [];
  fakeFetch.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Connection', () => {
  it('sends the token in the first message, never in the URL', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const socket = sockets[0]!;
    expect(socket.url).toBe(`ws://127.0.0.1:${DEFAULT_PORT}/ws`);
    expect(socket.url).not.toContain(TOKEN);
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'auth', payload: { token: TOKEN } });
    socket.receive(serverMessage('1', 'auth_ok', {}));
    expect(connection.current).toBe('connected');
  });

  it('pings every 20s once connected', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(serverMessage('1', 'auth_ok', {}));
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(socket.sent.map((s) => (JSON.parse(s) as { type: string }).type)).toEqual([
      'auth',
      'ping'
    ]);
  });

  it('ignores malformed server messages', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ v: 1, id: '1', type: 'auth_ok', payload: {}, extra: true });
    socket.onmessage?.({ data: 'nope' });
    expect(connection.current).toBe('connecting');
  });

  it('reports app-not-running and retries with backoff', async () => {
    appRunning = false;
    const { connection } = makeConnection();
    await connection.connect();
    expect(connection.current).toBe('app-not-running');
    const healthCalls = () =>
      fakeFetch.mock.calls.filter(([u]) => String(u).endsWith(`${DEFAULT_PORT}/health`)).length;
    expect(healthCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(healthCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(healthCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(healthCalls()).toBe(3);

    appRunning = true;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(connection.current).toBe('connecting');
    expect(sockets).toHaveLength(1);
  });

  it('reconnects after the app quits, starting again at 1s', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    sockets[0]!.open();
    sockets[0]!.receive(serverMessage('1', 'auth_ok', {}));

    appRunning = false;
    sockets[0]!.close(1001);
    expect(connection.current).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.current).toBe('app-not-running');

    appRunning = true;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sockets).toHaveLength(2);
  });

  it('forgets the token when the desktop says it is invalid or revoked', async () => {
    const { connection, storage } = makeConnection();
    await connection.connect();
    sockets[0]!.open();
    sockets[0]!.close(CloseCode.unauthorized);
    expect(connection.current).toBe('not-paired');
    expect(storage.token).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('reports not-paired without a token and does not open a socket', async () => {
    const { connection } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(connection.current).toBe('not-paired');
    expect(sockets).toHaveLength(0);
  });

  it('pairs with a code, stores the token and connects', async () => {
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('000000')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await connection.pair('123456')).toEqual({ ok: true });
    expect(storage.token).toBe(TOKEN);
    expect(sockets).toHaveLength(1);
  });

  it('unpair revokes on the desktop and clears the token', async () => {
    const { connection, storage } = makeConnection();
    await connection.connect();
    sockets[0]!.open();
    sockets[0]!.receive(serverMessage('1', 'auth_ok', {}));
    await connection.unpair();
    const call = fakeFetch.mock.calls.find(([u]) => String(u).endsWith('/unpair'));
    expect(new Headers(call?.[1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(storage.token).toBeNull();
    expect(connection.current).toBe('not-paired');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
