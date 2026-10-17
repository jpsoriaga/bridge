import { randomUUID } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  ClientMessage,
  CloseCode,
  PairRequest,
  parseMessage,
  serverMessage,
  type HealthResponse,
  type PairFailure,
  type PairSuccess,
  type ServerMessage
} from '@bridge/shared';
import {
  ALLOWED_ORIGINS,
  AUTH_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  HOST,
  IDLE_TIMEOUT_MS,
  MAX_WS_PAYLOAD_BYTES,
  RATE_LIMIT
} from './config';
import type { Pairing } from './pairing';

export interface BridgeServerOptions {
  pairing: Pairing;
  version: string;
  /** Called whenever pairing or connection state changes. */
  onChange?: () => void;
  allowedOrigins?: ReadonlySet<string>;
  authTimeoutMs?: number;
  idleTimeoutMs?: number;
  rateLimit?: { messages: number; windowMs: number };
}

export type BridgeServer = ReturnType<typeof createBridgeServer>;

function toText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, HOST);
  });
}

/**
 * The loopback server: `/health`, `/pair`, `/unpair` and the `/ws` socket.
 * No CORS headers are ever sent, and nothing here logs.
 */
export function createBridgeServer(options: BridgeServerOptions) {
  const {
    pairing,
    version,
    onChange = () => {},
    allowedOrigins = ALLOWED_ORIGINS,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    rateLimit = RATE_LIMIT
  } = options;

  let port: number | null = null;
  const sessions = new Set<WebSocket>();

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, forceCloseConnections: true });
  // JSON only. A text/plain POST is a "simple" cross-origin request; refusing it means
  // a web page can't even reach the handler without a preflight.
  app.removeContentTypeParser('text/plain');

  void app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

  // DNS rebinding guard: a rebinding page sends its own hostname in Host.
  app.addHook('onRequest', async (request, reply) => {
    if (port === null || request.headers.host !== `${HOST}:${port}`) {
      return reply.code(421).send({ error: 'bad_host' });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });

  async function requireExtensionOrigin(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'bad_origin' });
    }
  }

  function closeSessions(code: number, reason: string): void {
    for (const socket of sessions) socket.close(code, reason);
    sessions.clear();
  }

  function revoke(): void {
    pairing.unpair();
    closeSessions(CloseCode.unauthorized, 'revoked');
    onChange();
  }

  app.get('/health', async (): Promise<HealthResponse> => ({ name: 'bridge', version }));

  app.post('/pair', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const body = PairRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' } satisfies PairFailure);
    }
    const result = pairing.redeem(body.data.code);
    if (result.ok) {
      // One paired extension at a time: the previous token is already replaced.
      closeSessions(CloseCode.unauthorized, 'replaced');
      onChange();
      return { token: result.token } satisfies PairSuccess;
    }
    onChange();
    if (result.reason === 'locked') {
      reply.header('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      return reply
        .code(429)
        .send({ error: 'locked', retryAfterMs: result.retryAfterMs } satisfies PairFailure);
    }
    return reply.code(401).send({ error: 'invalid_code' } satisfies PairFailure);
  });

  app.post('/unpair', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!pairing.verifyToken(token)) return reply.code(401).send({ error: 'unauthorized' });
    revoke();
    return reply.code(204).send();
  });

  void app.register(async (scope) => {
    scope.get('/ws', { websocket: true, onRequest: requireExtensionOrigin }, (socket) => {
      let authed = false;
      let windowStart = Date.now();
      let windowCount = 0;

      const send = (message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };

      const authTimer = setTimeout(() => {
        send(serverMessage(randomUUID(), 'auth_error', { reason: 'timeout' }));
        socket.close(CloseCode.authTimeout, 'auth timeout');
      }, authTimeoutMs);

      let idleTimer: NodeJS.Timeout | undefined;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => socket.close(CloseCode.idle, 'idle'), idleTimeoutMs);
      };

      socket.on('message', (data, isBinary) => {
        const now = Date.now();
        if (now - windowStart >= rateLimit.windowMs) {
          windowStart = now;
          windowCount = 0;
        }
        if (++windowCount > rateLimit.messages) {
          send(
            serverMessage(randomUUID(), 'error', {
              code: 'rate_limited',
              message: 'Too many messages.'
            })
          );
          socket.close(CloseCode.rateLimited, 'rate limited');
          return;
        }

        const message = isBinary ? null : parseMessage(ClientMessage, toText(data));

        if (!authed) {
          clearTimeout(authTimer);
          if (message?.type !== 'auth') {
            send(serverMessage(randomUUID(), 'auth_error', { reason: 'expected_auth' }));
            socket.close(CloseCode.protocolError, 'expected auth');
            return;
          }
          if (!pairing.verifyToken(message.payload.token)) {
            send(serverMessage(randomUUID(), 'auth_error', { reason: 'invalid_token' }));
            socket.close(CloseCode.unauthorized, 'invalid token');
            return;
          }
          authed = true;
          sessions.add(socket);
          resetIdle();
          send(serverMessage(randomUUID(), 'auth_ok', {}));
          send(serverMessage(randomUUID(), 'status', { version }));
          onChange();
          return;
        }

        if (!message) {
          send(
            serverMessage(randomUUID(), 'error', {
              code: 'invalid_message',
              message: 'Message dropped.'
            })
          );
          return;
        }
        resetIdle();
        if (message.type === 'ping') send(serverMessage(randomUUID(), 'pong', {}));
      });

      socket.on('close', () => {
        clearTimeout(authTimer);
        clearTimeout(idleTimer);
        if (sessions.delete(socket)) onChange();
      });
    });
  });

  return {
    app,

    get port(): number | null {
      return port;
    },

    get connected(): boolean {
      return sessions.size > 0;
    },

    /** Binds 127.0.0.1 on the first free candidate port and returns it. */
    async listen(candidates: readonly number[]): Promise<number> {
      for (const candidate of candidates) {
        if (candidate !== 0 && !(await isPortFree(candidate))) continue;
        try {
          await app.listen({ host: HOST, port: candidate });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue;
          throw error;
        }
        port = (app.server.address() as AddressInfo).port;
        return port;
      }
      throw new Error(`No free port in ${candidates[0]}–${candidates.at(-1)}`);
    },

    /** Revokes the token and drops any open socket. */
    unpair: revoke,

    async close(): Promise<void> {
      closeSessions(1001, 'shutting down');
      await app.close();
      port = null;
    }
  };
}
