import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  BRIDGE_EXTENSION_ID,
  CloseCode,
  parseMessage,
  PROTOCOL_VERSION,
  proofInput,
  ServerMessage,
  type Mode,
  type RunResult
} from '@bridge/shared';
import { CommandRunner } from '../commands/runner';
import { CommandService } from '../commands/service';
import { GatedFiles, guardedFiles, ModeState } from '../policy';
import { ProjectService } from '../project/service';
import { tempProject } from '../project/test-utils';
import { settingsFile } from '../settings';
import { AUTH_TIMEOUT_MS, MAX_WS_PAYLOAD_BYTES } from './config';
import { memoryTokenStore, Pairing } from './pairing';
import { createBridgeServer, type BridgeServer } from './server';

const ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}`;

let clock: number;
let pairing: Pairing;
let server: BridgeServer;
let host: string;
let port: number;
let project: { name: string; path: string } | null;

beforeEach(async () => {
  clock = 1_000_000;
  pairing = new Pairing({ store: memoryTokenStore(), now: () => clock });
  project = null;
  server = createBridgeServer({
    pairing,
    version: '9.9.9',
    project: () => project,
    files: async (request) =>
      request.type === 'read' && request.payload.path === 'a.txt'
        ? { ok: true, result: { content: 'hi', hash: 'a'.repeat(64), eol: 'lf' } }
        : { ok: false, error: { code: 'denied', message: 'no' } },
    authTimeoutMs: 150,
    rateLimit: { messages: 20, windowMs: 10_000 }
  });
  port = await server.listen([0]);
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

/** Pairs and returns the key the extension keeps: the token's SHA-256, hex. */
async function pair(): Promise<string> {
  const { code } = pairing.startPairing();
  const res = await post('/pair', { code });
  expect(res.statusCode).toBe(200);
  const { token } = res.json() as { token: string };
  return createHash('sha256').update(token).digest('hex');
}

const nonce = () => randomBytes(32).toString('hex');
const sign = (key: string, ...args: Parameters<typeof proofInput>) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(proofInput(...args))
    .digest('hex');

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

const hello = (n: string) => ({
  v: PROTOCOL_VERSION,
  id: 'h1',
  type: 'hello',
  payload: { nonce: n }
});
const auth = (proof: string) => ({
  v: PROTOCOL_VERSION,
  id: 'a1',
  type: 'auth',
  payload: { proof }
});
const ping = (id = 'p1') => ({ v: PROTOCOL_VERSION, id, type: 'ping', payload: {} });

/** Sends hello and returns the server's challenge after checking its proof. */
async function challenge(client: Client, key: string, n = nonce()) {
  client.sendJson(hello(n));
  const message = await client.next();
  if (message.type !== 'challenge') throw new Error(`expected challenge, got ${message.type}`);
  expect(message.payload.proof).toBe(sign(key, 'server', 'ws', port, n));
  return message.payload;
}

async function authedClient(key: string): Promise<Client> {
  const client = await connect();
  const { serverNonce } = await challenge(client, key);
  client.sendJson(auth(sign(key, 'client', 'ws', port, serverNonce)));
  expect((await client.next()).type).toBe('auth_ok');
  return client;
}

/** The extension's two-step unpair. Returns the final status code. */
async function unpairWith(key: string): Promise<number> {
  const n = nonce();
  const first = await post('/unpair/challenge', { nonce: n });
  if (first.statusCode !== 200) return first.statusCode;
  const { proof, serverNonce } = first.json() as { proof: string; serverNonce: string };
  expect(proof).toBe(sign(key, 'server', 'unpair', port, n));
  const res = await post('/unpair', {
    serverNonce,
    proof: sign(key, 'client', 'unpair', port, serverNonce)
  });
  return res.statusCode;
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
    expect(pairing.isPaired).toBe(true);
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
    await expect(authedClient(first)).rejects.toThrow();
    (await authedClient(second)).ws.close();
  });
});

describe('POST /unpair', () => {
  it('requires a valid proof, never a bearer token', async () => {
    const key = await pair();
    const bearer = { authorization: `Bearer ${'0'.repeat(64)}` };
    expect((await post('/unpair', {}, bearer)).statusCode).toBe(400);
    expect(await unpairWith('f'.repeat(64)).catch(() => 'bad server proof')).toBe(
      'bad server proof'
    );
    // A made-up server nonce is refused even with a correct proof over it.
    const forged = nonce();
    const res = await post('/unpair', {
      serverNonce: forged,
      proof: sign(key, 'client', 'unpair', port, forged)
    });
    expect(res.statusCode).toBe(401);
    expect(pairing.isPaired).toBe(true);
  });

  it('refuses a socket proof for unpairing', async () => {
    const key = await pair();
    const { serverNonce } = (await post('/unpair/challenge', { nonce: nonce() })).json() as {
      serverNonce: string;
    };
    const res = await post('/unpair', {
      serverNonce,
      proof: sign(key, 'client', 'ws', port, serverNonce)
    });
    expect(res.statusCode).toBe(401);
    expect(pairing.isPaired).toBe(true);
  });

  it('uses each server nonce once', async () => {
    const key = await pair();
    const { serverNonce } = (await post('/unpair/challenge', { nonce: nonce() })).json() as {
      serverNonce: string;
    };
    const wrong = await post('/unpair', { serverNonce, proof: 'a'.repeat(64) });
    expect(wrong.statusCode).toBe(401);
    const retry = await post('/unpair', {
      serverNonce,
      proof: sign(key, 'client', 'unpair', port, serverNonce)
    });
    expect(retry.statusCode).toBe(401);
    expect(pairing.isPaired).toBe(true);
  });

  it('rejects a replayed client nonce', async () => {
    await pair();
    const n = nonce();
    expect((await post('/unpair/challenge', { nonce: n })).statusCode).toBe(200);
    expect((await post('/unpair/challenge', { nonce: n })).statusCode).toBe(409);
  });

  it('says not_paired when there is nothing to revoke', async () => {
    const res = await post('/unpair/challenge', { nonce: nonce() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'not_paired' });
  });

  it('revokes the key and closes the socket', async () => {
    const key = await pair();
    const client = await authedClient(key);
    expect(await unpairWith(key)).toBe(204);
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(pairing.isPaired).toBe(false);
  });
});

describe('WebSocket auth', () => {
  it('proves itself, accepts a valid proof and answers pings', async () => {
    const key = await pair();
    const client = await authedClient(key);
    expect(await client.next()).toMatchObject({
      type: 'status',
      payload: { version: '9.9.9', project: null }
    });
    expect(server.connected).toBe(true);

    client.sendJson(ping());
    expect((await client.next()).type).toBe('pong');
    client.ws.close();
    await client.closed;
  });

  it('never needs the token on the socket', async () => {
    const key = await pair();
    const client = await connect();
    client.sendJson({ v: PROTOCOL_VERSION, id: 'a1', type: 'auth', payload: { token: key } });
    expect(await client.next()).toMatchObject({ payload: { reason: 'expected_hello' } });
    expect((await client.closed).code).toBe(CloseCode.protocolError);
  });

  it('requires hello first', async () => {
    await pair();
    const client = await connect();
    client.sendJson(ping());
    expect(await client.next()).toMatchObject({ payload: { reason: 'expected_hello' } });
    expect((await client.closed).code).toBe(CloseCode.protocolError);
  });

  it('requires auth after the challenge', async () => {
    const key = await pair();
    const client = await connect();
    await challenge(client, key);
    client.sendJson(ping());
    expect(await client.next()).toMatchObject({ payload: { reason: 'expected_auth' } });
    expect((await client.closed).code).toBe(CloseCode.protocolError);
  });

  it('rejects a wrong client proof', async () => {
    const key = await pair();
    const client = await connect();
    const { serverNonce } = await challenge(client, key);
    client.sendJson(auth(sign('f'.repeat(64), 'client', 'ws', port, serverNonce)));
    expect(await client.next()).toMatchObject({ payload: { reason: 'invalid_proof' } });
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    expect(server.connected).toBe(false);
  });

  it('rejects a reflected server proof as the client proof', async () => {
    const key = await pair();
    const client = await connect();
    const { serverNonce } = await challenge(client, key);
    client.sendJson(auth(sign(key, 'server', 'ws', port, serverNonce)));
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
  });

  it('rejects a proof bound to another port', async () => {
    const key = await pair();
    const client = await connect();
    const { serverNonce } = await challenge(client, key);
    client.sendJson(auth(sign(key, 'client', 'ws', port + 1, serverNonce)));
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
  });

  it('rejects a replayed hello nonce', async () => {
    const key = await pair();
    const n = nonce();
    const first = await connect();
    await challenge(first, key, n);
    first.ws.close();

    const second = await connect();
    second.sendJson(hello(n));
    expect(await second.next()).toMatchObject({ payload: { reason: 'replayed_nonce' } });
    expect((await second.closed).code).toBe(CloseCode.protocolError);
  });

  it('rejects a proof replayed from an earlier socket', async () => {
    const key = await pair();
    const first = await connect();
    const { serverNonce } = await challenge(first, key);
    const proof = sign(key, 'client', 'ws', port, serverNonce);
    first.sendJson(auth(proof));
    expect((await first.next()).type).toBe('auth_ok');

    const second = await connect();
    await challenge(second, key);
    second.sendJson(auth(proof));
    expect((await second.closed).code).toBe(CloseCode.unauthorized);
    first.ws.close();
  });

  it('says not_paired when there is no key', async () => {
    const client = await connect();
    client.sendJson(hello(nonce()));
    expect(await client.next()).toMatchObject({ payload: { reason: 'not_paired' } });
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
  });

  it('closes if the handshake does not finish in time', async () => {
    expect(AUTH_TIMEOUT_MS).toBe(5_000);
    const key = await pair();
    const client = await connect();
    await challenge(client, key);
    const { code } = await client.closed;
    expect(code).toBe(CloseCode.authTimeout);
    expect(client.messages).toMatchObject([{ payload: { reason: 'timeout' } }]);
    expect(server.connected).toBe(false);
  });

  it('rejects a revoked key after unpairing from the app', async () => {
    const key = await pair();
    const client = await authedClient(key);
    server.unpair();
    expect((await client.closed).code).toBe(CloseCode.unauthorized);
    const again = await connect();
    again.sendJson(hello(nonce()));
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
    client.sendJson(ping());
    expect((await client.next()).type).toBe('pong');
    client.ws.close();
    await client.closed;
  });

  it('closes on oversized messages', async () => {
    const client = await authedClient(await pair());
    client.ws.send('x'.repeat(MAX_WS_PAYLOAD_BYTES + 1));
    // 1009 (too big), or 1006 if the server drops the socket before the frame finishes.
    expect([1006, 1009]).toContain((await client.closed).code);
    await vi.waitFor(() => expect(server.connected).toBe(false));
  });

  it('closes when a client floods messages', async () => {
    const client = await authedClient(await pair());
    for (let i = 0; i < 25; i++) client.sendJson(ping(`p${i}`));
    expect((await client.closed).code).toBe(CloseCode.rateLimited);
  });
});

describe('file requests', () => {
  it('answers with a response carrying the request id', async () => {
    const client = await authedClient(await pair());
    await client.next(); // status
    client.sendJson({
      v: PROTOCOL_VERSION,
      id: 'read-7',
      type: 'read',
      payload: { path: 'a.txt' }
    });
    expect(await client.next()).toEqual({
      v: PROTOCOL_VERSION,
      id: 'read-7',
      type: 'response',
      payload: { ok: true, result: { content: 'hi', hash: 'a'.repeat(64), eol: 'lf' } }
    });
    client.sendJson({ v: PROTOCOL_VERSION, id: 'read-8', type: 'read', payload: { path: '.env' } });
    expect(await client.next()).toMatchObject({
      id: 'read-8',
      payload: { ok: false, error: { code: 'denied' } }
    });
    client.ws.close();
    await client.closed;
  });

  it('refuses file requests before auth', async () => {
    await pair();
    const client = await connect();
    client.sendJson({ v: PROTOCOL_VERSION, id: 'r', type: 'read', payload: { path: 'a.txt' } });
    expect(await client.next()).toMatchObject({ payload: { reason: 'expected_hello' } });
    expect((await client.closed).code).toBe(CloseCode.protocolError);
  });

  it('drops malformed file requests', async () => {
    const client = await authedClient(await pair());
    await client.next(); // status
    client.sendJson({
      v: PROTOCOL_VERSION,
      id: 'w',
      type: 'write',
      payload: { path: 'a', content: 1 }
    });
    expect(await client.next()).toMatchObject({
      type: 'error',
      payload: { code: 'invalid_message' }
    });
    client.ws.close();
    await client.closed;
  });

  it('carries a 1MB write', async () => {
    const client = await authedClient(await pair());
    await client.next(); // status
    const content = '\n'.repeat(1024 * 1024);
    client.sendJson({
      v: PROTOCOL_VERSION,
      id: 'big',
      type: 'write',
      payload: { path: 'b.txt', content, trigger: 'click' }
    });
    expect(await client.next()).toMatchObject({ id: 'big', type: 'response' });
    client.ws.close();
    await client.closed;
  });

  it('pushes status when the project changes', async () => {
    const client = await authedClient(await pair());
    await client.next(); // status
    project = { name: 'app', path: '~/code/app' };
    server.pushStatus();
    expect(await client.next()).toMatchObject({
      type: 'status',
      payload: { project: { name: 'app', path: '~/code/app' } }
    });
    client.ws.close();
    await client.closed;
  });
});

describe('modes, commands and the loop (real project, real runner)', () => {
  let t: ReturnType<typeof tempProject>;
  let modes: ModeState;
  let runner: CommandRunner;
  let exits: RunResult[];
  let loopReports: unknown[];
  let sessionEnds: number;
  let unpaired: number;

  beforeEach(async () => {
    await server.close();
    t = tempProject('bridge-server-modes-');
    t.write('src/a.ts', 'old\n');
    t.write('package.json', '{}\n');
    const userData = join(t.base, 'userData');
    mkdirSync(userData);
    const settings = settingsFile(join(userData, 'settings.json'));
    const projects = new ProjectService({
      settings,
      backupsDir: join(userData, 'backups'),
      homeDir: join(t.base, 'home'),
      protectedDirs: [userData]
    });
    await projects.open(t.root);
    modes = new ModeState(settings);
    exits = [];
    loopReports = [];
    sessionEnds = 0;
    unpaired = 0;
    runner = new CommandRunner({
      onOutput: (runId, chunk) =>
        server.broadcast({
          v: PROTOCOL_VERSION,
          id: 'o',
          type: 'run_output',
          payload: { runId, chunk }
        }),
      onExit: (result) => {
        exits.push(result);
        server.broadcast({ v: PROTOCOL_VERSION, id: 'x', type: 'run_exit', payload: result });
      }
    });
    const commands = new CommandService({
      runner,
      root: () => projects.root,
      mode: () => modes.mode,
      allowlist: () => ['node -e'],
      envPatterns: () => [],
      timeoutMs: () => 10_000,
      env: () => ({ PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot ?? '' })
    });
    pairing = new Pairing({ store: memoryTokenStore(), now: () => clock });
    server = createBridgeServer({
      pairing,
      version: '9.9.9',
      project: () => projects.project,
      files: guardedFiles(
        projects,
        () => modes.mode,
        () => new GatedFiles()
      ),
      commands: (request) =>
        request.type === 'run'
          ? commands.run(request.payload)
          : Promise.resolve(commands.cancel(request.payload.runId)),
      config: () => ({
        mode: modes.mode,
        allowlist: ['node -e'],
        stepLimit: 10,
        pauseOnFailure: false,
        running: runner.current,
        instance: 'test'
      }),
      onLoopReport: (report) => loopReports.push(report),
      onSessionEnd: () => {
        sessionEnds += 1;
        modes.dropFullAuto();
      },
      onUnpaired: () => {
        unpaired += 1;
        modes.dropFullAuto();
      }
    });
    port = await server.listen([0]);
    host = `127.0.0.1:${port}`;
  });

  afterEach(() => {
    runner.cancelAll();
    t.cleanup();
  });

  let seq = 0;
  /** Sends a request and returns its response, skipping anything else that arrives first. */
  async function ask(client: Client, type: string, payload: unknown) {
    const id = `req-${++seq}`;
    client.sendJson({ v: PROTOCOL_VERSION, id, type, payload });
    for (;;) {
      const message = await client.next();
      if (message.type === 'response' && message.id === id) return message.payload;
    }
  }
  const write = (path: string, trigger: 'click' | 'auto', content = 'new\n') => ({
    path,
    content,
    trigger
  });

  async function setUp(mode: Mode) {
    modes.set(mode);
    const client = await authedClient(await pair());
    const status = await client.next();
    expect(status).toMatchObject({ type: 'status', payload: { config: { mode } } });
    return client;
  }

  async function readHash(client: Client, path: string) {
    const read = await ask(client, 'read', { path });
    if (!read.ok) throw new Error(read.error.code);
    return (read.result as { hash: string }).hash;
  }

  it('rejects automatic writes in Manual mode, and accepts the same write on a click', async () => {
    const client = await setUp('manual');
    const baseHash = await readHash(client, 'src/a.ts');
    expect(await ask(client, 'write', { ...write('src/a.ts', 'auto'), baseHash })).toMatchObject({
      ok: false,
      error: { code: 'mode' }
    });
    expect(await ask(client, 'write', { ...write('src/a.ts', 'click'), baseHash })).toMatchObject({
      ok: true
    });
    client.ws.close();
    await client.closed;
  });

  it('accepts automatic writes in Auto-apply, except to a gated file', async () => {
    const client = await setUp('auto-apply');
    const baseHash = await readHash(client, 'src/a.ts');
    expect(await ask(client, 'write', { ...write('src/a.ts', 'auto'), baseHash })).toMatchObject({
      ok: true
    });
    const pkgHash = await readHash(client, 'package.json');
    expect(
      await ask(client, 'write', {
        ...write('package.json', 'auto', '{"x":1}\n'),
        baseHash: pkgHash
      })
    ).toMatchObject({ ok: false, error: { code: 'gated' } });
    expect(
      await ask(client, 'write', { ...write('.github/workflows/ci.yml', 'auto') })
    ).toMatchObject({ ok: false, error: { code: 'gated' } });
    // A click on the gated file goes through.
    expect(
      await ask(client, 'write', {
        ...write('package.json', 'click', '{"x":1}\n'),
        baseHash: pkgHash
      })
    ).toMatchObject({ ok: true });
    client.ws.close();
    await client.closed;
  });

  it('rejects automatic runs outside Full auto, and runs them in Full auto', async () => {
    const client = await setUp('auto-apply');
    const run = { argv: ['node', '-e', 'console.log("ran")'], trigger: 'auto' };
    expect(await ask(client, 'run', run)).toMatchObject({ ok: false, error: { code: 'mode' } });
    modes.set('full-auto');
    const started = await ask(client, 'run', run);
    expect(started).toMatchObject({ ok: true, result: { runId: expect.any(String) } });
    // Output then the exit arrive as events.
    let exit: ServerMessage | undefined;
    while (!exit) {
      const message = await client.next();
      if (message.type === 'run_exit') exit = message;
    }
    expect(exit.payload).toMatchObject({ status: 'exited', exitCode: 0, output: 'ran\n' });
    client.ws.close();
    await client.closed;
  });

  it('rejects a command that isn’t allowlisted even on a click', async () => {
    const client = await setUp('full-auto');
    for (const argv of [
      ['node', '--version'],
      ['git', 'status'],
      ['sh', '-c', 'id']
    ]) {
      expect(await ask(client, 'run', { argv, trigger: 'click' })).toMatchObject({
        ok: false,
        error: { code: 'not-allowlisted' }
      });
    }
    expect(exits).toEqual([]);
    client.ws.close();
    await client.closed;
  });

  it('cancels a run on request', async () => {
    const client = await setUp('manual');
    const started = await ask(client, 'run', {
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      trigger: 'click'
    });
    if (!started.ok) throw new Error(started.error.code);
    const { runId } = started.result as { runId: string };
    expect(await ask(client, 'run_cancel', { runId })).toEqual({
      ok: true,
      result: { cancelled: true }
    });
    let exit: ServerMessage | undefined;
    while (!exit) {
      const message = await client.next();
      if (message.type === 'run_exit') exit = message;
    }
    expect(exit.payload).toMatchObject({ runId, status: 'cancelled' });
    client.ws.close();
    await client.closed;
  });

  it('passes loop reports on, and drops Full auto on session_end', async () => {
    const client = await setUp('full-auto');
    client.sendJson({
      v: PROTOCOL_VERSION,
      id: 'l1',
      type: 'loop_report',
      payload: { loopId: 'loop-1', state: 'acting', step: 1, limit: 10 }
    });
    client.sendJson({ v: PROTOCOL_VERSION, id: 's1', type: 'session_end', payload: {} });
    await vi.waitFor(() => expect(sessionEnds).toBe(1));
    expect(loopReports).toEqual([{ loopId: 'loop-1', state: 'acting', step: 1, limit: 10 }]);
    expect(modes.mode).toBe('manual');
    client.ws.close();
    await client.closed;
  });

  it('drops Full auto when unpaired from the app, from the extension, or by pairing again', async () => {
    await pair();
    modes.set('full-auto');
    server.unpair();
    expect(unpaired).toBe(1);
    expect(modes.mode).toBe('manual');

    const key = await pair();
    modes.set('full-auto');
    expect(await unpairWith(key)).toBe(204);
    expect(unpaired).toBe(2);
    expect(modes.mode).toBe('manual');

    await pair();
    modes.set('full-auto');
    await pair();
    expect(unpaired).toBe(3);
    expect(modes.mode).toBe('manual');
  });
});
