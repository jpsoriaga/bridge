import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BRIDGE_EXTENSION_ID, CloseCode, parseMessage, ServerMessage } from '@bridge/shared';
import { AUTH_TIMEOUT_MS, MAX_WS_PAYLOAD_BYTES } from './config';
import { memoryTokenStore, Pairing } from './pairing';
import { createBridgeServer, type BridgeServer } from './server';

const ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}`;

let clock: number;
let pairing: Pairing;
let server: BridgeServer;
let host: string;

beforeEach(async () => {
  clock = 1_000_000;
  pairing = new Pairing({ store: memoryTokenStore(), now: () => clock });
  server = createBridgeServer({
    pairing,
    version: '9.9.9',
    authTimeoutMs: 150,
    rateLimit: { messages: 20, windowMs: 10_000 }
  });
  const port = await server.listen([0]);
  host = `127.0.0.1:${port}`;
});

afterEach(async () => {
  await server.close();
});

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return server.app.inject({
    method: 'POST',
    url,
    headers: { host, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body)
  });
}

async function pair(): Promise<string> {
  const { code } = pairing.startPairing();
  const res = await post('/pair', { code });
  expect(res.statusCode).toBe(200);
  return (res.json() as { token: string }).token;
}

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  next(): Promise<ServerMessage>;
  closed: Promise<{ code: number; reason: string }>;
  sendJson(value: unknown): void;
}

function connect(options: { origin?: string; host?: string } = {}): Promise<Client> {
  const headers: Record<string, string> = {};
  if (options.host) headers.host = options.host;
  const ws = new WebSocket(`ws://${host}/ws`, {
    origin: options.origin ?? ORIGIN,
    headers
  });
  const messages: ServerMessage[] = [];
  const waiters: ((m: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = parseMessage(ServerMessage, data.toString());
    if (!message) throw new Error(`invalid server message: ${data.toString()}`);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  return new Promise((resolve, reject) => {
    ws.once('open', () =>
      resolve({
        ws,
        messages,
        closed,
        next: () => {
          const queued = messages.shift();
          return queued ? Promise.resolve(queued) : new Promise((r) => waiters.push(r));
        },
        sendJson: (value) => ws.send(JSON.stringify(value))
      })
    );
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

const auth = (token: string) => ({ v: 1, id: 'a1', type: 'auth', payload: { token } });

async function authedClient(token: string): Promise<Client> {
  const client = await connect();
  client.sendJson(auth(token));
  expect((await client.next()).type).toBe('auth_ok');
  return client;
}

describe('host check', () => {
  it.each(['localhost', 'evil.example', '127.0.0.1', '127.0.0.1:1', '0.0.0.0'])(
    'rejects Host %s',
    async (badHost) => {
      for (const url of ['/health', '/pair', '/unpair']) {
        const res = await server.app.inject({
          method: url === '/health' ? 'GET' : 'POST',
          url,
          headers: { host: badHost, origin: ORIGIN }
        });
        expect(res.statusCode).toBe(421);
      }
    }
  );

  it('rejects a WebSocket with a wrong Host', async () => {
    await expect(connect({ host: 'localhost' })).rejects.toThrow('HTTP 421');
  });
});

describe('GET /health', () => {
  it('returns only the name and version, with no CORS headers', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/health', headers: { host } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: 'bridge', version: '9.9.9' });
    expect(Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });

  it('binds 127.0.0.1 only', () => {
    expect(server.app.server.address()).toMatchObject({ address: '127.0.0.1' });
  });
});

describe('origin check', () => {
  it.each([
    ['missing', undefined],
    ['a web page', 'https://chatgpt.com'],
    ['another extension', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    ['null', 'null']
  ])('rejects /pair with %s Origin', async (_label, origin) => {
    const { code } = pairing.startPairing();
    const headers: Record<string, string> = { host, 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const res = await server.app.inject({
      method: 'POST',
      url: '/pair',
      headers,
      payload: JSON.stringify({ code })
    });
    expect(res.statusCode).toBe(403);
    // The code was not consumed.
    expect(pairing.pendingCode?.code).toBe(code);
  });

  it('rejects a WebSocket from another origin', async () => {
    await expect(connect({ origin: 'https://chatgpt.com' })).rejects.toThrow('HTTP 403');
  });
});

describe('POST /pair', () => {
  it('exchanges a valid code for a token', async () => {
    const token = await pair();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(pairing.verifyToken(token)).toBe(true);
    expect(pairing.pendingCode).toBeNull();
  });

  it('rejects a reused code', async () => {
    const { code } = pairing.startPairing();
    expect((await post('/pair', { code })).statusCode).toBe(200);
    const res = await post('/pair', { code });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid_code' });
  });

  it('rejects an expired code', async () => {
    const { code } = pairing.startPairing();
    clock += 2 * 60_000;
    expect((await post('/pair', { code })).statusCode).toBe(401);
  });

  it('rejects malformed bodies', async () => {
    pairing.startPairing();
    expect((await post('/pair', { code: '12' })).statusCode).toBe(400);
    expect((await post('/pair', { code: 123456 })).statusCode).toBe(400);
    expect((await post('/pair', 'x', { 'content-type': 'text/plain' })).statusCode).toBe(415);
  });

  it('rejects oversized bodies', async () => {
    const res = await post('/pair', { code: '123456', pad: 'x'.repeat(2048) });
    expect(res.statusCode).toBe(413);
  });

  it('locks for 60s after 5 wrong codes and burns the code', async () => {
    const { code } = pairing.startPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect((await post('/pair', { code: wrong })).statusCode).toBe(401);

    const fifth = await post('/pair', { code: wrong });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toEqual({ error: 'locked', retryAfterMs: 60_000 });
    expect(fifth.headers['retry-after']).toBe('60');

    // Even the right code is refused while locked, and that code is gone for good.
    expect((await post('/pair', { code })).statusCode).toBe(429);
    clock += 30_000;
    const later = await post('/pair', { code });
    expect(later.statusCode).toBe(429);
    expect(later.json()).toMatchObject({ retryAfterMs: 30_000 });

    clock += 30_000;
    expect((await post('/pair', { code })).statusCode).toBe(401);
    const fresh = pairing.startPairing();
    expect((await post('/pair', { code: fresh.code })).statusCode).toBe(200);
  });

  it('replaces the previous token when pairing again', async () => {
    const first = await pair();
    const client = await authedClient(first);
    const second = await pair();
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(pairing.verifyToken(first)).toBe(false);
    expect(pairing.verifyToken(second)).toBe(true);
  });
});

describe('POST /unpair', () => {
  it('requires the token', async () => {
    await pair();
    expect((await post('/unpair', {})).statusCode).toBe(401);
    const bogus = { authorization: `Bearer ${'0'.repeat(64)}` };
    expect((await post('/unpair', {}, bogus)).statusCode).toBe(401);
    expect(pairing.isPaired).toBe(true);
  });

  it('revokes the token and closes the socket', async () => {
    const token = await pair();
    const client = await authedClient(token);
    const res = await post('/unpair', {}, { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(204);
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(pairing.isPaired).toBe(false);
    expect(pairing.verifyToken(token)).toBe(false);
  });
});

describe('WebSocket auth', () => {
  it('accepts a valid token and answers pings', async () => {
    const token = await pair();
    const client = await authedClient(token);
    expect(await client.next()).toMatchObject({ type: 'status', payload: { version: '9.9.9' } });
    expect(server.connected).toBe(true);

    client.sendJson({ v: 1, id: 'p1', type: 'ping', payload: {} });
    expect((await client.next()).type).toBe('pong');
    client.ws.close();
    await client.closed;
  });

  it('rejects a missing token', async () => {
    await pair();
    const client = await connect();
    client.sendJson({ v: 1, id: 'p1', type: 'ping', payload: {} });
    expect(await client.next()).toMatchObject({ payload: { reason: 'expected_auth' } });
    expect((await client.closed).code).toBe(CloseCode.protocolError);
  });

  it('rejects an invalid token', async () => {
    await pair();
    const client = await connect();
    client.sendJson(auth('f'.repeat(64)));
    expect(await client.next()).toMatchObject({ payload: { reason: 'invalid_token' } });
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(server.connected).toBe(false);
  });

  it('rejects any token when not paired', async () => {
    const client = await connect();
    client.sendJson(auth('f'.repeat(64)));
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
  });

  it('closes if auth arrives after the timeout', async () => {
    expect(AUTH_TIMEOUT_MS).toBe(5_000);
    const token = await pair();
    const client = await connect();
    const { code } = await client.closed;
    expect(code).toBe(CloseCode.authTimeout);
    expect(client.messages).toMatchObject([{ payload: { reason: 'timeout' } }]);
    // Too late: the socket is gone.
    expect(() => client.sendJson(auth(token))).not.toThrow();
    expect(server.connected).toBe(false);
  });

  it('rejects a revoked token after unpairing from the app', async () => {
    const token = await pair();
    const client = await authedClient(token);
    server.unpair();
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    const again = await connect();
    again.sendJson(auth(token));
    expect((await again.closed).code).toBe(CloseCode.unauthorized);
  });

  it('drops invalid messages after auth without closing', async () => {
    const client = await authedClient(await pair());
    await client.next(); // status
    client.ws.send('not json');
    expect(await client.next()).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message' }
    });
    client.sendJson({ v: 1, id: 'p1', type: 'ping', payload: {} });
    expect((await client.next()).type).toBe('pong');
    client.ws.close();
    await client.closed;
  });

  it('closes on oversized messages', async () => {
    const client = await authedClient(await pair());
    client.ws.send('x'.repeat(MAX_WS_PAYLOAD_BYTES + 1));
    expect((await client.closed).code).toBe(1009);
  });

  it('closes when a client floods messages', async () => {
    const client = await authedClient(await pair());
    for (let i = 0; i < 25; i++) client.sendJson({ v: 1, id: `p${i}`, type: 'ping', payload: {} });
    expect((await client.closed).code).toBe(CloseCode.rateLimited);
  });
});
