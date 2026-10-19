import { createHmac, randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BRIDGE_EXTENSION_ID,
  MAX_FILE_BYTES,
  PROTOCOL_VERSION,
  proofInput,
  type FileRequest
} from '@bridge/shared';
import { MAX_WS_PAYLOAD_BYTES } from './config';
import { generateServerKey, memoryTokenStore, Pairing } from './pairing';
import { createBridgeServer, type BridgeServer } from './server';
import { pairingClient } from './test-pairing';

// Phase 7: the server against a plain web page, slow clients, too many sockets, request
// floods, the largest allowed message, and random input before and after auth.

const ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}`;
const serverKey = generateServerKey();

let pairing: Pairing;
let server: BridgeServer;
let port: number;
let host: string;
/** Every file request that reached the handler. */
let handled: FileRequest[];

async function start(options: Partial<Parameters<typeof createBridgeServer>[0]> = {}) {
  handled = [];
  pairing = new Pairing({ store: memoryTokenStore(), serverKey });
  server = createBridgeServer({
    pairing,
    version: '9.9.9',
    files: async (request) => {
      handled.push(request);
      return { ok: true, result: { content: 'x', hash: 'a'.repeat(64), eol: 'lf', bom: false } };
    },
    authTimeoutMs: 300,
    ...options
  });
  port = await server.listen([0]);
  host = `127.0.0.1:${port}`;
}

beforeEach(() => start());
afterEach(() => server.close());

const sign = (key: string, ...args: Parameters<typeof proofInput>) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(proofInput(...args))
    .digest('hex');
const nonce = () => randomBytes(32).toString('hex');

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  server.app.inject({
    method: 'POST',
    url,
    headers: { host, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body)
  });

async function pair(): Promise<string> {
  const { code } = pairing.startPairing();
  const client = pairingClient();
  const res = await post('/pair', { code, publicKey: client.publicKey });
  const { key, nonce: n } = client.derive(
    port,
    code,
    (res.json() as { publicKey: string }).publicKey
  );
  pairing.confirmFingerprint();
  expect(
    (await post('/pair/confirm', { proof: sign(key, 'client', 'pair', port, n) })).statusCode
  ).toBe(204);
  return key;
}

interface Socket {
  ws: WebSocket;
  received: { type: string; id: string; payload: unknown }[];
  closed: Promise<number>;
  next(): Promise<{ type: string; id: string; payload: unknown }>;
}

function open(origin: string | null = ORIGIN): Promise<Socket> {
  const ws = new WebSocket(`ws://${host}/ws`, origin === null ? {} : { origin });
  const received: Socket['received'] = [];
  /** Messages not yet taken by `next`. */
  const queue: Socket['received'] = [];
  const waiters: ((m: Socket['received'][number]) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Socket['received'][number];
    received.push(message);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.once('open', () =>
      resolve({
        ws,
        received,
        closed,
        next: () => {
          const queued = queue.shift();
          return queued ? Promise.resolve(queued) : new Promise((r) => waiters.push(r));
        }
      })
    );
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

async function authed(key: string): Promise<Socket> {
  const socket = await open();
  const n = nonce();
  socket.ws.send(
    JSON.stringify({ v: PROTOCOL_VERSION, id: 'h', type: 'hello', payload: { nonce: n } })
  );
  const challenge = (await socket.next()) as { payload: { serverNonce: string } };
  socket.ws.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 'a',
      type: 'auth',
      payload: { proof: sign(key, 'client', 'ws', port, challenge.payload.serverNonce) }
    })
  );
  expect((await socket.next()).type).toBe('auth_ok');
  await socket.next(); // status
  return socket;
}

const request = (type: string, payload: unknown, id = randomBytes(4).toString('hex')) =>
  JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload });

describe('a plain web page', () => {
  it.each([
    ['a web page Origin', 'https://evil.example'],
    ['chatgpt.com', 'https://chatgpt.com'],
    ['no Origin', null],
    ['Origin null', 'null'],
    ['another extension', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']
  ])('can’t pair, confirm, unpair or open the socket with %s', async (_label, origin) => {
    const headers: Record<string, string> = {};
    if (origin !== null) headers.origin = origin;
    const { code } = pairing.startPairing();
    for (const [url, body] of [
      ['/pair', { code, publicKey: pairingClient().publicKey }],
      ['/pair/confirm', { proof: 'a'.repeat(64) }],
      ['/unpair/challenge', { nonce: nonce() }],
      ['/unpair', { serverNonce: nonce(), proof: 'a'.repeat(64) }]
    ] as const) {
      const res = await server.app.inject({
        method: 'POST',
        url,
        headers: { host, 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(body)
      });
      expect(res.statusCode, `${url} with ${origin}`).toBe(403);
    }
    // The code survives: nothing was redeemed.
    expect(pairing.pendingCode?.code).toBe(code);
    await expect(open(origin)).rejects.toThrow('HTTP 403');
  });

  it('can’t send a "simple" cross-origin POST (text/plain, form) at all', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await post('/pair', 'code=123456', { 'content-type': type });
      expect(res.statusCode).toBe(415);
    }
  });

  it('gets no CORS headers, ever', async () => {
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: '/pair',
      headers: { host, origin: 'https://evil.example', 'access-control-request-method': 'POST' }
    });
    expect(Object.keys(res.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
  });
});

describe('limits', () => {
  it('sizes the socket frame for a 1 MB write escaped as badly as JSON can', () => {
    // Every byte a control character: each becomes \u00XX.
    const worst = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 'x'.repeat(64),
      type: 'write',
      payload: {
        path: 'a/'.repeat(500) + 'b',
        content: '\u0001'.repeat(MAX_FILE_BYTES),
        baseHash: 'a'.repeat(64),
        source: 'chat',
        trigger: 'click',
        loopId: 'x'.repeat(64)
      }
    });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(MAX_WS_PAYLOAD_BYTES);
    expect(MAX_WS_PAYLOAD_BYTES).toBeLessThan(8 * 1024 * 1024);
  });

  it('closes a socket that sends a frame over the limit, before parsing it', async () => {
    const socket = await open();
    socket.ws.send('x'.repeat(MAX_WS_PAYLOAD_BYTES + 1));
    // 1009 (message too big), or 1006 if the server drops it before the close frame lands.
    expect([1006, 1009]).toContain(await socket.closed);
  });

  it('allows two sockets at once and refuses a third before the upgrade', async () => {
    const first = await open();
    const second = await open();
    await expect(open()).rejects.toThrow('HTTP 503');
    first.ws.close();
    await first.closed;
    // Room again.
    const third = await open();
    second.ws.close();
    third.ws.close();
  });

  it('closes a socket that never finishes auth', async () => {
    const socket = await open();
    expect(await socket.closed).toBe(4000);
  });

  it('closes a slow or partial HTTP request', async () => {
    await server.close();
    await start({ httpTimeoutMs: 400 });
    const socket = netConnect(port, '127.0.0.1');
    let answer = '';
    // Flowing, so the client sees the server hang up.
    socket.on('data', (data) => (answer += data.toString()));
    await new Promise((resolve) => socket.once('connect', resolve));
    // Headers that never finish.
    socket.write(`POST /pair HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${ORIGIN}\r\nX-Slow: `);
    const started = Date.now();
    await new Promise((resolve) => socket.once('close', resolve));
    const waited = Date.now() - started;
    expect(answer).toMatch(/^HTTP\/1\.1 408/);
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(waited).toBeLessThan(3_000);
  });

  it('answers rate-limited past each operation’s budget, and runs none of those', async () => {
    const key = await pair();
    const socket = await authed(key);
    const ids = Array.from({ length: 60 }, (_, i) => `r${i}`);
    for (const id of ids) socket.ws.send(request('read', { path: 'a.txt' }, id));
    const replies = await new Promise<Socket['received']>((resolve) => {
      const check = () => {
        const responses = socket.received.filter((m) => m.type === 'response');
        if (responses.length >= ids.length) resolve(responses);
        else setTimeout(check, 10);
      };
      check();
    });
    const limited = replies.filter(
      (m) => (m.payload as { error?: { code: string } }).error?.code === 'rate-limited'
    );
    expect(limited).toHaveLength(10);
    expect(handled).toHaveLength(50);
    // The socket stays open, and the next second has a fresh budget.
    await new Promise((r) => setTimeout(r, 1_050));
    socket.ws.send(request('read', { path: 'a.txt' }, 'later'));
    let later;
    while (!(later = socket.received.find((m) => m.id === 'later'))) await socket.next();
    expect(later).toMatchObject({ payload: { ok: true } });
    socket.ws.close();
  });

  it('limits writes to 10 a second', async () => {
    const key = await pair();
    const socket = await authed(key);
    for (let i = 0; i < 12; i++) {
      socket.ws.send(
        request('write', { path: `f${i}.txt`, content: 'x', trigger: 'click' }, `w${i}`)
      );
    }
    const replies: Socket['received'] = [];
    while (replies.length < 12) {
      const message = await socket.next();
      if (message.type === 'response') replies.push(message);
    }
    expect(replies.filter((m) => (m.payload as { ok: boolean }).ok === false).length).toBe(2);
    socket.ws.close();
  });
});

describe('fuzzing', () => {
  /** Arbitrary frames: random text, random JSON, and near-valid envelopes. */
  const frame = fc.oneof(
    fc.string(),
    fc.json(),
    fc
      .record({
        v: fc.oneof(fc.constant(PROTOCOL_VERSION), fc.integer()),
        id: fc.oneof(fc.string(), fc.integer()),
        type: fc.constantFrom(
          'hello',
          'auth',
          'ping',
          'read',
          'write',
          'run',
          'tree',
          'loop_report',
          'x'
        ),
        payload: fc.oneof(fc.object(), fc.constant(null), fc.string())
      })
      .map((value) => JSON.stringify(value))
  );

  it('never answers anything but an auth error before auth, and never crashes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(frame, { minLength: 1, maxLength: 5 }), async (frames) => {
        const socket = await open();
        for (const text of frames) {
          if (socket.ws.readyState === WebSocket.OPEN) socket.ws.send(text);
        }
        await Promise.race([socket.closed, new Promise((r) => setTimeout(r, 400))]);
        socket.ws.close();
        await socket.closed;
        for (const message of socket.received) {
          // A random frame is never a valid hello with a fresh nonce, so: errors only.
          expect(message.type).toBe('auth_error');
        }
        expect(handled).toEqual([]);
      }),
      { numRuns: 40 }
    );
    // Still serving.
    const health = await server.app.inject({ method: 'GET', url: '/health', headers: { host } });
    expect(health.statusCode).toBe(200);
  });

  it('answers random messages after auth with an error or a response, never crashing', async () => {
    const key = await pair();
    await fc.assert(
      fc.asyncProperty(fc.array(frame, { minLength: 1, maxLength: 10 }), async (frames) => {
        const socket = await authed(key);
        try {
          for (const text of frames) socket.ws.send(text);
          socket.ws.send(request('ping', {}, 'end'));
          // The ping's pong comes after everything before it was handled.
          while (!socket.received.some((m) => m.type === 'pong' && m.id !== undefined)) {
            await socket.next();
          }
          for (const message of socket.received) {
            expect(['error', 'response', 'pong', 'status', 'auth_ok', 'challenge']).toContain(
              message.type
            );
          }
        } finally {
          socket.ws.close();
          await socket.closed;
        }
      }),
      { numRuns: 25 }
    );
  });

  it('answers random HTTP bodies with a 4xx, never a 5xx', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('/pair', '/pair/confirm', '/unpair/challenge', '/unpair'),
        fc.oneof(fc.json(), fc.string()),
        async (url, body) => {
          const res = await post(url, body);
          expect(res.statusCode).toBeGreaterThanOrEqual(400);
          expect(res.statusCode).toBeLessThan(500);
        }
      ),
      { numRuns: 200 }
    );
    expect(pairing.isPaired).toBe(false);
  });
});
