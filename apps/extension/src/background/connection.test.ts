import { createECDH, createHash, createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloseCode,
  DEFAULT_PORT,
  FINGERPRINT_LABEL,
  formatFingerprint,
  PAIR_KEY_LABEL,
  pairTranscript,
  proofInput,
  PROTOCOL_VERSION,
  serverMessage,
  type BridgeConfig,
  type ConnectionStatus
} from '@bridge/shared';
import {
  Connection,
  PING_INTERVAL_MS,
  RATE_LIMIT_RETRIES,
  RATE_LIMIT_RETRY_MS,
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
  catchUpAfterSleep: true,
  uiGuidance: 'auto',
  running: null,
  background: [],
  processes: [],
  autoApprove: { changes: false, gated: false, partial: false },
  instance: 'launch-1'
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
  /** The protocol its /health reports and its hello expects. Unset: ours, not in /health. */
  protocol?: number;
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
  sent: { v: number; id: string; type: string; payload: Record<string, string> }[] = [];
  raw: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
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
      const { key, protocol = PROTOCOL_VERSION } = this.server;
      if (message.v !== protocol) {
        return this.later(() => this.close(CloseCode.protocolMismatch, `protocol ${protocol}`));
      }
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

  close(code = 1005, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
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

/** The fake app's pairing: its ECDH key, the exchange in progress, the user's confirmation. */
const appEcdh = createECDH('prime256v1');
appEcdh.generateKeys();
const APP_KEY = appEcdh.getPublicKey().toString('base64url');
const sha = (...parts: (string | Buffer)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};
let exchange: {
  port: number;
  key: string;
  nonce: string;
  fingerprint: string;
  confirmed: boolean;
} | null;
/** A squatter that answers /pair without deriving the key: its proof can't be right. */
let lyingApp: boolean;

function fakePair(port: number, body: Record<string, string>): Response {
  if (body.code !== '123456') return Response.json({ error: 'invalid_code' }, { status: 401 });
  const shared = appEcdh.computeSecret(Buffer.from(body.publicKey!, 'base64url'));
  const transcript = pairTranscript(port, body.code, APP_KEY, body.publicKey!);
  const key = sha(PAIR_KEY_LABEL, shared, transcript);
  const nonce = sha(transcript);
  exchange = {
    port,
    key,
    nonce,
    fingerprint: formatFingerprint(sha(FINGERPRINT_LABEL, transcript)),
    confirmed: false
  };
  const proof = lyingApp ? 'e'.repeat(64) : sign(key, 'server', 'pair', port, nonce);
  return Response.json({ publicKey: APP_KEY, proof });
}

function fakeConfirm(port: number, body: Record<string, string>): Response {
  if (!exchange || body.proof !== sign(exchange.key, 'client', 'pair', port, exchange.nonce)) {
    return Response.json({ error: 'no_pairing' }, { status: 401 });
  }
  if (!exchange.confirmed) return Response.json({ error: 'not_confirmed' }, { status: 409 });
  servers.get(port)!.key = exchange.key;
  exchange = null;
  return new Response(null, { status: 204 });
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const server = servers.get(Number(url.port));
  if (url.hostname !== '127.0.0.1' || !server) throw new TypeError('Failed to fetch');
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
  switch (url.pathname) {
    case '/health':
      return Response.json({
        name: 'bridge',
        version: '0.1.0',
        ...(server.protocol === undefined ? {} : { protocol: server.protocol })
      });
    case '/pair':
      return fakePair(Number(url.port), body);
    case '/pair/confirm':
      return fakeConfirm(Number(url.port), body);
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
/**
 * Web Crypto calls still running. They finish on another thread, so a busy machine can take
 * any number of event-loop turns; `settle` waits for them instead of counting turns.
 */
let cryptoPending = 0;
const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
for (const name of [
  'digest',
  'importKey',
  'sign',
  'verify',
  'generateKey',
  'exportKey',
  'deriveBits'
]) {
  const original = subtle[name]!.bind(crypto.subtle);
  subtle[name] = (...args) => {
    cryptoPending += 1;
    return original(...args).finally(() => (cryptoPending -= 1));
  };
}

/** Lets the event loop turn until no Web Crypto call is left and things have been quiet. */
async function settle(): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 10_000 && quiet < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    quiet = cryptoPending === 0 ? quiet + 1 : 0;
  }
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
  exchange = null;
  lyingApp = false;
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

describe('protocol version handshake', () => {
  it.each([
    [PROTOCOL_VERSION + 1, 'update-extension'],
    [PROTOCOL_VERSION - 1, 'update-app']
  ] as const)('an app on protocol %i: %s, and it keeps trying', async (protocol, advice) => {
    servers.set(DEFAULT_PORT, { key: KEY, protocol });
    const { connection, storage } = makeConnection();
    await connection.connect();
    await settle();
    expect(connection.current).toBe(advice);
    // The key is kept: nothing proved it wrong.
    expect(storage.key).toBe(KEY);
    // The app was told too: one hello, closed with protocolMismatch.
    expect(sockets[0]!.sent.map((m) => m.type)).toEqual(['hello']);

    // The app is updated: the next attempt connects.
    servers.get(DEFAULT_PORT)!.protocol = PROTOCOL_VERSION;
    await advance(1_000);
    await settle();
    expect(connection.current).toBe('connected');
  });

  it('says which side to update when the app closes with protocolMismatch', async () => {
    // An app that doesn't put its protocol in /health still closes with it.
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    const real = FakeSocket.prototype.send;
    vi.spyOn(FakeSocket.prototype, 'send').mockImplementation(function (this: FakeSocket, data) {
      const message = JSON.parse(data) as { type: string };
      if (message.type !== 'hello') return real.call(this, data);
      queueMicrotask(() =>
        this.close(CloseCode.protocolMismatch, `protocol ${PROTOCOL_VERSION + 2}`)
      );
    });
    await connection.connect();
    await settle();
    expect(connection.current).toBe('update-extension');
    vi.restoreAllMocks();
  });

  it('refuses to pair with an app on another protocol, and tells it', async () => {
    servers.set(DEFAULT_PORT, { key: null, protocol: PROTOCOL_VERSION + 1 });
    const { connection } = makeConnection(memoryStorage(null));
    await connection.connect();
    await settle();
    expect(connection.current).toBe('update-extension');
    expect(sockets.at(-1)!.sent.map((m) => m.type)).toEqual(['hello']);

    expect(await connection.pair('123456')).toEqual({ ok: false, error: 'update-extension' });
    expect(fakeFetch.mock.calls.some(([u]) => String(u).endsWith('/pair'))).toBe(false);
    expect(exchange).toBeNull();
  });

  it('ignores an app that reports no protocol (before 1.0)', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    await connection.connect();
    expect(connection.current).toBe('connected');
  });
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
    servers = new Map([[DEFAULT_PORT + 3, { key: null }]]);
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('123456')).toMatchObject({ ok: true });
    exchange!.confirmed = true;
    expect(await connection.confirmPair()).toEqual({ ok: true });
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

  it('pairs with a code, shows the app’s fingerprint, and keeps the key only once both confirm', async () => {
    servers.set(DEFAULT_PORT, { key: null });
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('000000')).toEqual({ ok: false, error: 'invalid_code' });
    const started = await connection.pair('123456');
    expect(started).toEqual({ ok: true, fingerprint: exchange!.fingerprint });
    expect(started).toMatchObject({
      fingerprint: expect.stringMatching(/^[0-9a-f]{4} [0-9a-f]{4}$/)
    });
    const derived = exchange!.key;
    // Nothing kept, and the app hasn't confirmed yet.
    expect(storage.key).toBeNull();
    expect(await connection.confirmPair()).toEqual({ ok: false, error: 'not-confirmed' });
    expect(storage.key).toBeNull();
    exchange!.confirmed = true;
    expect(await connection.confirmPair()).toEqual({ ok: true });
    expect(storage.key).toBe(derived);
    await settle();
    expect(connection.current).toBe('connected');
    // The key never crossed the wire.
    expect(fakeFetch.mock.calls.some(([, init]) => String(init?.body).includes(derived))).toBe(
      false
    );
  });

  it('refuses an app that can’t prove it derived the key, before asking the user anything', async () => {
    servers.set(DEFAULT_PORT, { key: null });
    lyingApp = true;
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('123456')).toEqual({ ok: false, error: 'failed' });
    expect(await connection.confirmPair()).toEqual({ ok: false, error: 'expired' });
    expect(storage.key).toBeNull();
  });

  it('forgets the exchange on cancel', async () => {
    servers.set(DEFAULT_PORT, { key: null });
    const { connection, storage } = makeConnection(memoryStorage(null));
    await connection.connect();
    expect(await connection.pair('123456')).toMatchObject({ ok: true });
    exchange!.confirmed = true;
    connection.cancelPair();
    expect(await connection.confirmPair()).toEqual({ ok: false, error: 'expired' });
    expect(storage.key).toBeNull();
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
  const READ = { content: 'hi\n', hash: 'e'.repeat(64), eol: 'lf', bom: false };

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

  it('waits out a rate-limited reply and retries, then gives up after a few', async () => {
    let refusals = 2;
    servers.set(DEFAULT_PORT, {
      key: KEY,
      respond: (m) =>
        refusals-- > 0
          ? serverMessage(m.id, 'response', {
              ok: false,
              error: { code: 'rate-limited', message: 'Slow down.' }
            })
          : serverMessage(m.id, 'response', { ok: true, result: READ })
    });
    const { connection } = makeConnection();
    await connection.connect();
    const pending = connection.request('read', { path: 'a.txt' });
    await advance(RATE_LIMIT_RETRY_MS);
    await advance(RATE_LIMIT_RETRY_MS);
    expect(await pending).toEqual({ ok: true, result: READ });
    expect(sockets[0]!.sent.filter((m) => m.type === 'read')).toHaveLength(3);

    refusals = 100;
    const stuck = connection.request('read', { path: 'a.txt' });
    for (let i = 0; i < RATE_LIMIT_RETRIES; i++) await advance(RATE_LIMIT_RETRY_MS);
    expect(await stuck).toMatchObject({ ok: false, error: { code: 'rate-limited' } });
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
    expect(connection.appVersion).toBeNull();
    await connection.connect();
    expect(connection.project).toEqual({ name: 'app', path: '~/app' });
    expect(connection.appVersion).toBe('1');

    sockets[0]!.receive(
      serverMessage('s2', 'status', { version: '1.2.0-beta.1', project: null, config: CONFIG })
    );
    // The app's version is kept for diagnostics.
    expect(connection.appVersion).toBe('1.2.0-beta.1');
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
    sockets[0]!.receive(
      serverMessage('f', 'file_changed', { paths: ['src/a.ts'], overflow: false })
    );
    expect(events).toEqual(['run-output', 'run-exit', 'loop-stop', 'files-changed']);
  });

  it('keeps a healthy socket after sleep instead of calling it stale', async () => {
    servers.set(DEFAULT_PORT, { key: KEY });
    const { connection } = makeConnection();
    await connection.connect();
    const pings = () => sockets[0]!.sent.filter((m) => m.type === 'ping').length;
    // Asleep for ten minutes: the clock jumps, but no timer ran meanwhile.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await advance(PING_INTERVAL_MS);
    expect(connection.current).toBe('connected');
    expect(pings()).toBe(1);
  });

  it('reconnects at once on wake instead of waiting out the backoff', async () => {
    servers.clear();
    const { connection } = makeConnection();
    await connection.connect();
    await advance(1_000);
    await advance(2_000);
    expect(connection.current).toBe('app-not-running');
    servers.set(DEFAULT_PORT, { key: KEY });
    connection.wake();
    await settle();
    expect(connection.current).toBe('connected');
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
