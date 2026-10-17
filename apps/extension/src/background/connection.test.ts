import { createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloseCode,
  DEFAULT_PORT,
  proofInput,
  serverMessage,
  type BridgeConfig,
  type ConnectionStatus
} from '@bridge/shared';
import {
  Connection,
  PING_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  type ConnectionStorage
} from './connection';

const TOKEN = 'b'.repeat(64);
const KEY = createHash('sha256').update(TOKEN).digest('hex');
const OTHER_KEY = 'c'.repeat(64);
const CONFIG: BridgeConfig = {
  mode: 'manual',
  allowlist: ['pnpm test'],
  stepLimit: 10,
  pauseOnFailure: false,
  running: null
};

const sign = (key: string, ...args: Parameters<typeof proofInput>) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(proofInput(...args))
    .digest('hex');

/** How the thing listening on a port behaves. */
interface FakeServer {
  /** The key it holds. Null: a Bridge that isn't paired. */
  key: string | null;
  /** Answer every hello with this challenge instead of a fresh one (replay attack). */
  replay?: { proof: string; serverNonce: string };
  lastChallenge?: { proof: string; serverNonce: string };
  /** Sent in the same tick as auth_ok, before the client can adopt the socket. */
  afterAuth?: unknown[];
  /** Answers file requests. Return undefined to never answer. */
  respond?: (message: { id: string; type: string; payload: Record<string, string> }) => unknown;
}

let servers: Map<number, FakeServer>;
let sockets: FakeSocket[];
let statuses: ConnectionStatus[];
let alarm: { set: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn>; on: boolean };

const portOf = (url: string) => Number(new URL(url).port);

/** A browser WebSocket whose far end plays `servers.get(port)`. */
class FakeSocket {
  readyState = 0;
  sent: { id: string; type: string; payload: Record<string, string> }[] = [];
  raw: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly port: number;
  private serverNonce = '';

  constructor(readonly url: string) {
    this.port = portOf(url);
    queueMicrotask(() => (servers.has(this.port) ? this.open() : this.close(1006)));
  }

  get server(): FakeServer {
    return servers.get(this.port)!;
  }

  send(data: string) {
    this.raw.push(data);
    const message = JSON.parse(data) as FakeSocket['sent'][number];
    this.sent.push(message);
    if (message.type === 'hello') {
      const { key } = this.server;
      if (key === null) return this.later(() => this.close(CloseCode.unauthorized));
      this.serverNonce = randomBytes(32).toString('hex');
      const challenge = this.server.replay ?? {
        proof: sign(key, 'server', 'ws', this.port, message.payload.nonce!),
        serverNonce: this.serverNonce
      };
      this.server.lastChallenge = challenge;
      this.later(() => this.receive(serverMessage('c', 'challenge', challenge)));
    } else if (message.type === 'auth') {
      const ok =
        this.server.key !== null &&
        message.payload.proof ===
          sign(this.server.key, 'client', 'ws', this.port, this.serverNonce);
      this.later(() => {
        if (!ok) return this.close(4001);
        this.receive(serverMessage('o', 'auth_ok', {}));
        for (const extra of this.server.afterAuth ?? []) this.receive(extra);
      });
    } else if (['tree', 'read', 'write', 'undo'].includes(message.type)) {
      const reply = this.server.respond?.(message);
      if (reply !== undefined) this.later(() => this.receive(reply));
    }
  }

  close(code = 1005) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  private open() {
    this.readyState = 1;
    this.onopen?.();
  }

  private later(fn: () => void) {
    queueMicrotask(fn);
  }
}

function memoryStorage(
  key: string | null = KEY,
  port: number | null = null
): ConnectionStorage & { key: string | null; port: number | null } {
  return {
    key,
    port,
    async getTokenHash() {
      return this.key;
    },
    async setTokenHash(next) {
      this.key = next;
    },
    async getPort() {
      return this.port;
    },
    async setPort(next) {
      this.port = next;
    }
  };
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const server = servers.get(Number(url.port));
  if (url.hostname !== '127.0.0.1' || !server) throw new TypeError('Failed to fetch');
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
  switch (url.pathname) {
    case '/health':
      return Response.json({ name: 'bridge', version: '0.1.0' });
    case '/pair':
      return body.code === '123456'
        ? Response.json({ token: TOKEN })
        : Response.json({ error: 'invalid_code' }, { status: 401 });
    case '/unpair/challenge':
      return Response.json({
        proof: sign(server.key!, 'server', 'unpair', Number(url.port), body.nonce!),
        serverNonce: 'd'.repeat(64)
      });
    default:
      return new Response(null, { status: 204 });
  }
});

/** Lets microtasks and Web Crypto (which resolves off-thread) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Advances fake time, then lets any attempt that started finish its handshake. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function makeConnection(storage = memoryStorage()) {
  const connection = new Connection({
    storage,
    fetch: fakeFetch as typeof fetch,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    randomId: () => 'id',
    alarm
  });
  connection.onStatus((s) => statuses.push(s));
  return { connection, storage };
}

const fetchedPorts = () => fakeFetch.mock.calls.map(([u]) => portOf(String(u)));

beforeEach(() => {
  // setImmediate stays real so `settle` can wait for Web Crypto.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  });
  vi.stubGlobal('WebSocket', { OPEN: 1 });
  servers = new Map([[DEFAULT_PORT, { key: KEY }]]);
  sockets = [];
  statuses = [];
  alarm = {
    on: false,
    set: vi.fn(() => (alarm.on = true)),
    clear: vi.fn(() => (alarm.on = false))
  };
  fakeFetch.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('handshake', () => {
  it('sends a nonce first and proves itself only after the server has', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const socket = sockets[0]!;
    expect(socket.url).toBe(`ws://127.0.0.1:${DEFAULT_PORT}/ws`);
    expect(socket.sent.map((m) => m.type)).toEqual(['hello', 'auth']);
    expect(socket.sent[0]!.payload.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.current).toBe('connected');
  });

  it('never sends the token or the key', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    await connection.unpair();
    const wire = [
      ...sockets.flatMap((s) => [s.url, ...s.raw]),
      ...fakeFetch.mock.calls.map(([u, init]) => `${String(u)} ${String(init?.body)}`),
      ...fakeFetch.mock.calls.map(([, init]) => JSON.stringify(init?.headers ?? {}))
    ].join('\n');
    expect(wire).not.toContain(TOKEN);
    expect(wire).not.toContain(KEY);
  });

  it('uses a fresh nonce on every attempt', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    sockets[0]!.close(1001);
    await advance(1_000);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.sent[0]!.payload.nonce).not.toBe(sockets[0]!.sent[0]!.payload.nonce);
  });

  it('rejects a server with the wrong proof and does not retry that port', async () => {
    servers.set(DEFAULT_PORT, { key: OTHER_KEY });
    const { connection, storage } = makeConnection();
    await connection.connect();
    expect(sockets[0]!.sent.map((m) => m.type)).toEqual(['hello']);
    expect(sockets[0]!.readyState).toBe(3);
    expect(connection.current).toBe('error');
    expect(storage.key).toBe(KEY);

    await advance(60_000);
    expect(sockets).toHaveLength(1);
    expect(fetchedPorts().filter((p) => p === DEFAULT_PORT)).toHaveLength(1);
  });

  it('rejects a server replaying an old challenge', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const old = servers.get(DEFAULT_PORT)!.lastChallenge!;
    servers.get(DEFAULT_PORT)!.replay = old;
    sockets[0]!.close(1001);
    await advance(1_000);
    expect(sockets[1]!.sent.map((m) => m.type)).toEqual(['hello']);
    expect(connection.current).toBe('error');
  });

  it('keeps the key when an unproven server closes with 4001', async () => {
    servers.set(DEFAULT_PORT, { key: null });
    const { connection, storage } = makeConnection();
    await connection.connect();
    expect(storage.key).toBe(KEY);
    expect(connection.current).toBe('error');
  });

  it('forgets the key when a proven server revokes it', async () => {
    const { connection, storage } = makeConnection();
    await connection.connect();
    sockets[0]!.close(CloseCode.unauthorized);
    await settle();
    expect(connection.current).toBe('not-paired');
    expect(storage.key).toBeNull();
    await advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('ignores malformed server messages', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    const pending = connection.connect();
    await settle();
    sockets[0]!.receive({ v: 2, id: '1', type: 'auth_ok', payload: {}, extra: true });
    sockets[0]!.onmessage?.({ data: 'nope' });
    await pending;
    expect(connection.current).toBe('connected');
  });
});

describe('port pinning', () => {
  const PINNED = DEFAULT_PORT + 4;

  it('tries the pinned port first and scans nothing else when it passes', async () => {
    servers = new Map([
      [DEFAULT_PORT, { key: KEY }],
      [PINNED, { key: KEY }]
    ]);
    const { connection } = makeConnection(memoryStorage(KEY, PINNED));
    await connection.connect();
    expect(new Set(fetchedPorts())).toEqual(new Set([PINNED]));
    expect(sockets.map((s) => s.port)).toEqual([PINNED]);
  });

  it('scans the range in order when the pinned port fails, and re-pins', async () => {
    servers = new Map([[DEFAULT_PORT + 2, { key: KEY }]]);
    const { connection, storage } = makeConnection(memoryStorage(KEY, PINNED));
    await connection.connect();
    expect(fetchedPorts()[0]).toBe(PINNED);
    expect(connection.current).toBe('connected');
    expect(storage.port).toBe(DEFAULT_PORT + 2);
  });

  it('skips an impostor on the pinned port and accepts the real app elsewhere', async () => {
    servers = new Map([
      [PINNED, { key: OTHER_KEY }],
      [DEFAULT_PORT + 1, { key: KEY }]
    ]);
    const { connection, storage } = makeConnection(memoryStorage(KEY, PINNED));
    await connection.connect();
    expect(sockets.map((s) => s.port)).toEqual([PINNED, DEFAULT_PORT + 1]);
    expect(connection.current).toBe('connected');
    expect(storage.port).toBe(DEFAULT_PORT + 1);
  });

  it('skips an impostor on the default port while scanning', async () => {
    servers = new Map([
      [DEFAULT_PORT, { key: OTHER_KEY }],
      [DEFAULT_PORT + 1, { key: KEY }]
    ]);
    const { connection, storage } = makeConnection();
    await connection.connect();
    expect(connection.current).toBe('connected');
    expect(storage.port).toBe(DEFAULT_PORT + 1);
  });

  it('pins the port it paired on', async () => {
    servers = new Map([[DEFAULT_PORT + 3, { key: KEY }]]);
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('123456')).toEqual({ ok: true });
    expect(storage.port).toBe(DEFAULT_PORT + 3);
  });
});

describe('reconnect alarm', () => {
  it('is set while paired and disconnected, and cleared once connected', async () => {
    servers.clear();
    const { connection } = makeConnection();
    await connection.connect();
    expect(connection.current).toBe('app-not-running');
    expect(alarm.on).toBe(true);

    servers.set(DEFAULT_PORT, { key: KEY });
    await advance(1_000);
    expect(connection.current).toBe('connected');
    expect(alarm.on).toBe(false);

    sockets[0]!.close(1001);
    expect(alarm.on).toBe(true);
    expect(alarm.set).toHaveBeenCalledTimes(2);
  });

  it('is never set when not paired', async () => {
    servers.clear();
    const { connection } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(connection.current).toBe('app-not-running');
    expect(alarm.set).not.toHaveBeenCalled();
  });

  it('is cleared on unpair and on revoke', async () => {
    servers.clear();
    const { connection } = makeConnection();
    await connection.connect();
    expect(alarm.on).toBe(true);
    await connection.unpair();
    expect(alarm.on).toBe(false);

    servers.set(DEFAULT_PORT, { key: KEY });
    const second = makeConnection();
    await second.connection.connect();
    sockets.at(-1)!.close(CloseCode.unauthorized);
    await settle();
    expect(alarm.on).toBe(false);
  });
});

describe('Connection', () => {
  it('pings every 20s once connected', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(sockets[0]!.sent.map((m) => m.type)).toEqual(['hello', 'auth', 'ping']);
  });

  it('reports app-not-running and retries with backoff', async () => {
    servers.clear();
    const { connection } = makeConnection();
    await connection.connect();
    expect(connection.current).toBe('app-not-running');
    const healthCalls = () =>
      fakeFetch.mock.calls.filter(([u]) => String(u).endsWith(`${DEFAULT_PORT}/health`)).length;
    expect(healthCalls()).toBe(1);

    await advance(1_000);
    expect(healthCalls()).toBe(2);
    await advance(1_999);
    expect(healthCalls()).toBe(2);
    await advance(1);
    expect(healthCalls()).toBe(3);

    servers.set(DEFAULT_PORT, { key: KEY });
    await advance(4_000);
    expect(connection.current).toBe('connected');
    expect(sockets).toHaveLength(1);
  });

  it('reconnects after the app quits, starting again at 1s', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    servers.clear();
    sockets[0]!.close(1001);
    expect(connection.current).toBe('connecting');
    await advance(1_000);
    expect(connection.current).toBe('app-not-running');

    servers.set(DEFAULT_PORT, { key: KEY });
    await advance(2_000);
    expect(sockets).toHaveLength(2);
    expect(connection.current).toBe('connected');
  });

  it('reports not-paired without a key and does not open a socket', async () => {
    const { connection } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(connection.current).toBe('not-paired');
    expect(sockets).toHaveLength(0);
  });

  it('pairs with a code, stores only the hash and connects', async () => {
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('000000')).toEqual({ ok: false, error: 'invalid_code' });
    expect(await connection.pair('123456')).toEqual({ ok: true });
    expect(storage.key).toBe(KEY);
    expect(sockets).toHaveLength(1);
    expect(connection.current).toBe('connected');
  });

  it('unpair proves itself to the desktop and clears the key', async () => {
    const { connection, storage } = makeConnection();
    await connection.connect();
    await connection.unpair();
    const calls = fakeFetch.mock.calls.filter(([u]) => String(u).includes('/unpair'));
    expect(calls.map(([u]) => new URL(String(u)).pathname)).toEqual([
      '/unpair/challenge',
      '/unpair'
    ]);
    const final = JSON.parse(String(calls[1]![1]!.body)) as { proof: string };
    expect(final.proof).toBe(sign(KEY, 'client', 'unpair', DEFAULT_PORT, 'd'.repeat(64)));
    expect(storage.key).toBeNull();
    expect(connection.current).toBe('not-paired');
    await advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('unpair sends no proof to a server that cannot prove itself', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection, storage } = makeConnection(memoryStorage(KEY, DEFAULT_PORT));
    await connection.connect();
    servers.set(DEFAULT_PORT, { key: OTHER_KEY });
    await connection.unpair();
    const paths = fakeFetch.mock.calls.map(([u]) => new URL(String(u)).pathname);
    expect(paths).toContain('/unpair/challenge');
    expect(paths).not.toContain('/unpair');
    expect(storage.key).toBeNull();
  });
});

describe('file requests', () => {
  const READ = { content: 'hi\n', hash: 'e'.repeat(64), eol: 'lf' };

  it('sends a request and resolves with the checked result', async () => {
    servers.set(DEFAULT_PORT, {
      key: KEY,
      respond: (m) => serverMessage(m.id, 'response', { ok: true, result: READ })
    });
    const { connection } = makeConnection();
    await connection.connect();
    const outcome = await connection.request('read', { path: 'a.txt' });
    expect(outcome).toEqual({ ok: true, result: READ });
    expect(sockets[0]!.sent.at(-1)).toMatchObject({ type: 'read', payload: { path: 'a.txt' } });
  });

  it('passes typed refusals through', async () => {
    servers.set(DEFAULT_PORT, {
      key: KEY,
      respond: (m) =>
        serverMessage(m.id, 'response', {
          ok: false,
          error: { code: 'denied', message: 'Protected.' }
        })
    });
    const { connection } = makeConnection();
    await connection.connect();
    expect(await connection.request('read', { path: '.env' })).toEqual({
      ok: false,
      error: { code: 'denied', message: 'Protected.' }
    });
  });

  it('rejects a result that does not match the schema for its request', async () => {
    servers.set(DEFAULT_PORT, {
      key: KEY,
      respond: (m) => serverMessage(m.id, 'response', { ok: true, result: { entries: 'nope' } })
    });
    const { connection } = makeConnection();
    await connection.connect();
    expect(await connection.request('tree', {})).toMatchObject({
      ok: false,
      error: { code: 'bad-response' }
    });
  });

  it('fails fast when not connected', async () => {
    servers.clear();
    const { connection } = makeConnection();
    await connection.connect();
    expect(await connection.request('tree', {})).toMatchObject({
      ok: false,
      error: { code: 'not-connected' }
    });
  });

  it('times out, and fails pending requests when the socket closes', async () => {
    const { connection } = makeConnection();
    await connection.connect();
    const slow = connection.request('tree', {});
    await advance(REQUEST_TIMEOUT_MS);
    expect(await slow).toMatchObject({ ok: false, error: { code: 'timeout' } });

    const cut = connection.request('tree', {});
    sockets[0]!.close(1001);
    expect(await cut).toMatchObject({ ok: false, error: { code: 'not-connected' } });
  });

  it('tracks the project from status, including one sent right after auth_ok', async () => {
    servers.set(DEFAULT_PORT, {
      key: KEY,
      afterAuth: [
        serverMessage('s', 'status', {
          version: '1',
          project: { name: 'app', path: '~/app' },
          config: CONFIG
        })
      ]
    });
    const { connection } = makeConnection();
    const seen: unknown[] = [];
    connection.onProject((p) => seen.push(p));
    await connection.connect();
    expect(connection.project).toEqual({ name: 'app', path: '~/app' });

    sockets[0]!.receive(
      serverMessage('s2', 'status', { version: '1', project: null, config: CONFIG })
    );
    expect(connection.project).toBeNull();
    sockets[0]!.receive(
      serverMessage('s3', 'status', {
        version: '1',
        project: { name: 'b', path: '/b' },
        config: CONFIG
      })
    );
    sockets[0]!.close(1001);
    expect(connection.project).toBeNull();
    expect(seen).toEqual([{ name: 'app', path: '~/app' }, null, { name: 'b', path: '/b' }, null]);
  });

  it('mirrors the app’s config, and forgets it when the socket closes', async () => {
    servers.set(DEFAULT_PORT, {
      key: KEY,
      afterAuth: [serverMessage('s', 'status', { version: '1', project: null, config: CONFIG })]
    });
    const { connection } = makeConnection();
    const seen: unknown[] = [];
    connection.onConfig((c) => seen.push(c?.mode ?? null));
    await connection.connect();
    expect(connection.config).toEqual(CONFIG);
    sockets[0]!.receive(
      serverMessage('s2', 'status', {
        version: '1',
        project: null,
        config: { ...CONFIG, mode: 'full-auto' }
      })
    );
    expect(connection.config?.mode).toBe('full-auto');
    sockets[0]!.close(1001);
    expect(connection.config).toBeNull();
    expect(seen).toEqual(['manual', 'full-auto', null]);
  });

  it('passes on run output, run exits and the app’s loop Stop', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    const events: unknown[] = [];
    connection.onEvent((e) => events.push(e.type));
    await connection.connect();
    sockets[0]!.receive(serverMessage('o', 'run_output', { runId: 'r-1', chunk: 'hi' }));
    sockets[0]!.receive(
      serverMessage('x', 'run_exit', {
        runId: 'r-1',
        argv: ['pnpm', 'test'],
        status: 'exited',
        exitCode: 0,
        signal: null,
        durationMs: 5,
        output: 'hi',
        truncated: false
      })
    );
    sockets[0]!.receive(serverMessage('l', 'loop_stop', {}));
    expect(events).toEqual(['run-output', 'run-exit', 'loop-stop']);
  });

  it('sends loop reports one way, and drops them while disconnected', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    const report = { loopId: 'loop-1', state: 'acting', step: 1, limit: 10 } as const;
    expect(connection.notify('loop_report', report)).toBe(false);
    await connection.connect();
    expect(connection.notify('loop_report', report)).toBe(true);
    expect(connection.notify('session_end', {})).toBe(true);
    expect(sockets[0]!.sent.map((m) => m.type)).toEqual(
      expect.arrayContaining(['loop_report', 'session_end'])
    );
  });
});
