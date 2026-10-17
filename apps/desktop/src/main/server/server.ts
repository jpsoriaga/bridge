import { randomUUID } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  ClientMessage,
  CloseCode,
  FILE_ERROR_MESSAGES,
  PairRequest,
  UnpairChallengeRequest,
  UnpairRequest,
  parseMessage,
  serverMessage,
  type FileOutcome,
  type FileRequest,
  type HealthResponse,
  type PairFailure,
  type PairSuccess,
  type ProjectInfo,
  type ServerMessage
} from '@bridge/shared';
import {
  ALLOWED_ORIGINS,
  AUTH_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  HOST,
  IDLE_TIMEOUT_MS,
  MAX_WS_PAYLOAD_BYTES,
  NONCE_LEDGER_MAX,
  NONCE_TTL_MS,
  RATE_LIMIT,
  UNPAIR_CHALLENGE_TTL_MS
} from './config';
import { IssuedNonces, newNonce, NonceLedger } from './nonces';
import type { Pairing } from './pairing';

export interface BridgeServerOptions {
  pairing: Pairing;
  version: string;
  /** Called whenever pairing or connection state changes. */
  onChange?: () => void;
  /** Answers tree/read/write/undo. Without it every file request gets `no-project`. */
  files?: (request: FileRequest) => Promise<FileOutcome<unknown>>;
  /** The open project, sent in every `status`. */
  project?: () => ProjectInfo | null;
  allowedOrigins?: ReadonlySet<string>;
  authTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  rateLimit?: { messages: number; windowMs: number };
}

export type BridgeServer = ReturnType<typeof createBridgeServer>;

type AuthFailure = Extract<ServerMessage, { type: 'auth_error' }>['payload']['reason'];

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
    files = async () => ({
      ok: false,
      error: { code: 'no-project', message: FILE_ERROR_MESSAGES['no-project'] }
    }),
    project = () => null,
    allowedOrigins = ALLOWED_ORIGINS,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    rateLimit = RATE_LIMIT,
    now = Date.now
  } = options;

  let port: number | null = null;
  const sessions = new Set<WebSocket>();
  // Client nonces from hello and /unpair/challenge, so neither can be replayed.
  const clientNonces = new NonceLedger(NONCE_TTL_MS, NONCE_LEDGER_MAX, now);
  const unpairNonces = new IssuedNonces(UNPAIR_CHALLENGE_TTL_MS, 16, now);

  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT_BYTES, forceCloseConnections: true });
  // JSON only. A text/plain POST is a "simple" cross-origin request; refusing it means
  // a web page can't even reach the handler without a preflight.
  app.removeContentTypeParser('text/plain');

  void app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

  // DNS rebinding guard: a rebinding page sends its own hostname in Host. Every handler
  // runs after this check, so `port` is set inside them (hence the `port!` below).
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

  const statusMessage = () =>
    serverMessage(randomUUID(), 'status', { version, project: project() });

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

  // Unpairing is two calls so the token never travels: the app proves itself over the
  // client's nonce, then the client proves itself over the app's.
  app.post('/unpair/challenge', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const body = UnpairChallengeRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!clientNonces.claim(body.data.nonce)) {
      return reply.code(409).send({ error: 'replayed_nonce' });
    }
    const proof = pairing.serverProof('unpair', port!, body.data.nonce);
    if (proof === null) return reply.code(401).send({ error: 'not_paired' });
    return { proof, serverNonce: unpairNonces.issue() };
  });

  app.post('/unpair', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const body = UnpairRequest.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
    const { serverNonce, proof } = body.data;
    if (
      !unpairNonces.redeem(serverNonce) ||
      !pairing.verifyClientProof('unpair', port!, serverNonce, proof)
    ) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    revoke();
    return reply.code(204).send();
  });

  void app.register(async (scope) => {
    scope.get('/ws', { websocket: true, onRequest: requireExtensionOrigin }, (socket) => {
      // hello → challenge → auth. `serverNonce` lives only on this socket, so it is used once.
      let stage: 'hello' | 'auth' | 'authed' = 'hello';
      let serverNonce = '';
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

        const fail = (reason: AuthFailure, code: number) => {
          clearTimeout(authTimer);
          send(serverMessage(randomUUID(), 'auth_error', { reason }));
          socket.close(code, reason);
        };

        if (stage === 'hello') {
          if (message?.type !== 'hello') return fail('expected_hello', CloseCode.protocolError);
          if (!clientNonces.claim(message.payload.nonce)) {
            return fail('replayed_nonce', CloseCode.protocolError);
          }
          const proof = pairing.serverProof('ws', port!, message.payload.nonce);
          if (proof === null) return fail('not_paired', CloseCode.unauthorized);
          serverNonce = newNonce();
          stage = 'auth';
          send(serverMessage(randomUUID(), 'challenge', { proof, serverNonce }));
          return;
        }

        if (stage === 'auth') {
          if (message?.type !== 'auth') return fail('expected_auth', CloseCode.protocolError);
          if (!pairing.verifyClientProof('ws', port!, serverNonce, message.payload.proof)) {
            return fail('invalid_proof', CloseCode.unauthorized);
          }
          clearTimeout(authTimer);
          stage = 'authed';
          sessions.add(socket);
          resetIdle();
          send(serverMessage(randomUUID(), 'auth_ok', {}));
          send(statusMessage());
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
        switch (message.type) {
          case 'ping':
            send(serverMessage(randomUUID(), 'pong', {}));
            break;
          case 'tree':
          case 'read':
          case 'write':
          case 'undo':
            // The reply carries the request's id.
            void files(message)
              .catch((): FileOutcome<unknown> => ({
                ok: false,
                error: { code: 'io-error', message: FILE_ERROR_MESSAGES['io-error'] }
              }))
              .then((outcome) => send(serverMessage(message.id, 'response', outcome)));
            break;
          default:
            break;
        }
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

    /** Tells the connected extension about a project change. */
    pushStatus(): void {
      const message = JSON.stringify(statusMessage());
      for (const socket of sessions) {
        if (socket.readyState === socket.OPEN) socket.send(message);
      }
    },

    async close(): Promise<void> {
      closeSessions(1001, 'shutting down');
      await app.close();
      port = null;
    }
  };
}
