import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import {
  browserFromUserAgent,
  ClientMessage,
  CloseCode,
  FILE_ERROR_MESSAGES,
  helloProtocol,
  mismatchReason,
  PairConfirmRequest,
  PairRequest,
  UnpairChallengeRequest,
  UnpairRequest,
  parseMessage,
  protocolAdvice,
  PROTOCOL_VERSION,
  serverMessage,
  type BridgeConfig,
  type CommandRequest,
  type FileOutcome,
  type FileRequest,
  type LoopReport,
  type HealthResponse,
  type PairFailure,
  type PairSuccess,
  type ProjectInfo,
  type ProtocolAdvice,
  type ServerMessage
} from '@bridge/shared';
import {
  ALLOWED_ORIGINS,
  AUTH_TIMEOUT_MS,
  BODY_LIMIT_BYTES,
  HOST,
  HTTP_REQUEST_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_WS_PAYLOAD_BYTES,
  NONCE_LEDGER_MAX,
  NONCE_TTL_MS,
  OP_RATE_LIMITS,
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
  /** Answers file requests (tree, read, write…). Without it every one gets `no-project`. */
  files?: (request: FileRequest) => Promise<FileOutcome<unknown>>;
  /** Answers run/run_cancel. Without it every command gets `no-project`. */
  commands?: (request: CommandRequest) => Promise<FileOutcome<unknown>>;
  /** The open project, sent in every `status`. */
  project?: () => ProjectInfo | null;
  /** Mode, allowlist and loop settings, sent in every `status`. */
  config?: () => BridgeConfig;
  /** The extension reported its Full auto loop. */
  onLoopReport?: (report: LoopReport) => void;
  /** The extension ended a chat session. */
  onSessionEnd?: () => void;
  /** The extension started a chat session. */
  onSessionStart?: () => void;
  /** The pairing was revoked or replaced: the old extension is gone. */
  onUnpaired?: () => void;
  allowedOrigins?: ReadonlySet<string>;
  authTimeoutMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
  rateLimit?: { messages: number; windowMs: number };
  /** Requests of each kind per second, per socket. */
  opRateLimits?: Readonly<Record<string, number>>;
  maxConnections?: number;
  httpTimeoutMs?: number;
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
    commands = async () => ({
      ok: false,
      error: { code: 'no-project', message: FILE_ERROR_MESSAGES['no-project'] }
    }),
    project = () => null,
    config = () => ({
      mode: 'manual',
      allowlist: [],
      stepLimit: 10,
      pauseOnFailure: false,
      catchUpAfterSleep: true,
      running: null,
      instance: 'default'
    }),
    onLoopReport = () => {},
    onSessionEnd = () => {},
    onSessionStart = () => {},
    onUnpaired = () => {},
    allowedOrigins = ALLOWED_ORIGINS,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
    rateLimit = RATE_LIMIT,
    opRateLimits = OP_RATE_LIMITS as Readonly<Record<string, number>>,
    maxConnections = MAX_CONNECTIONS,
    httpTimeoutMs = HTTP_REQUEST_TIMEOUT_MS,
    now = Date.now
  } = options;

  let port: number | null = null;
  const sessions = new Set<WebSocket>();
  /** Every open socket, authenticated or not, for the connection limit. */
  const open = new Set<WebSocket>();
  // Client nonces from hello and /unpair/challenge, so neither can be replayed.
  const clientNonces = new NonceLedger(NONCE_TTL_MS, NONCE_LEDGER_MAX, now);
  const unpairNonces = new IssuedNonces(UNPAIR_CHALLENGE_TTL_MS, 16, now);

  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    forceCloseConnections: true,
    // Fastify sets the server's requestTimeout from its own option, so pass it here too.
    requestTimeout: httpTimeoutMs,
    // A slow or partial request (slowloris) is cut off after `httpTimeoutMs`. Node checks
    // these timeouts on an interval (30s by default), so check every second instead.
    serverFactory: (handler) =>
      createHttpServer(
        {
          requestTimeout: httpTimeoutMs,
          headersTimeout: httpTimeoutMs,
          connectionsCheckingInterval: Math.min(1_000, httpTimeoutMs)
        },
        handler
      )
  });
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

  /** The protocol of the last extension that said hello, if it wasn't ours. */
  let extensionProtocol: number | null = null;
  /** From the User-Agent of the last socket that authenticated. */
  let browser: string | null = null;
  function setExtensionProtocol(protocol: number): void {
    const next = protocol === PROTOCOL_VERSION ? null : protocol;
    if (next === extensionProtocol) return;
    extensionProtocol = next;
    onChange();
  }

  const statusMessage = () =>
    serverMessage(randomUUID(), 'status', { version, project: project(), config: config() });

  function revoke(): void {
    pairing.unpair();
    closeSessions(CloseCode.unauthorized, 'revoked');
    onUnpaired();
    onChange();
  }

  app.get('/health', async (): Promise<HealthResponse> => ({
    name: 'bridge',
    version,
    protocol: PROTOCOL_VERSION
  }));

  // Step 1: the code and the extension's public key. Nothing is kept until both sides
  // have confirmed the fingerprint (step 2).
  app.post('/pair', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const body = PairRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' } satisfies PairFailure);
    }
    const result = pairing.redeem(body.data.code, body.data.publicKey, port!);
    onChange();
    if (result.ok) {
      return { publicKey: result.publicKey, proof: result.proof } satisfies PairSuccess;
    }
    if (result.reason === 'invalid_request') {
      return reply.code(400).send({ error: 'invalid_request' } satisfies PairFailure);
    }
    if (result.reason === 'locked') {
      reply.header('retry-after', String(Math.ceil(result.retryAfterMs / 1000)));
      return reply
        .code(429)
        .send({ error: 'locked', retryAfterMs: result.retryAfterMs } satisfies PairFailure);
    }
    return reply.code(401).send({ error: 'invalid_code' } satisfies PairFailure);
  });

  // Step 2: the extension's user confirmed the fingerprint; it proves it holds the key.
  // Refused until the app's user confirmed it too.
  app.post('/pair/confirm', { onRequest: requireExtensionOrigin }, async (request, reply) => {
    const body = PairConfirmRequest.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_request' } satisfies PairFailure);
    }
    const wasPaired = pairing.isPaired;
    const result = pairing.confirmClient(body.data.proof);
    onChange();
    if (result === 'not_confirmed') {
      return reply.code(409).send({ error: 'not_confirmed' } satisfies PairFailure);
    }
    if (result === 'no_pairing') {
      return reply.code(401).send({ error: 'no_pairing' } satisfies PairFailure);
    }
    // One paired extension at a time: the previous key is already replaced.
    closeSessions(CloseCode.unauthorized, 'replaced');
    if (wasPaired) onUnpaired();
    return reply.code(204).send();
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

  /** At most `maxConnections` sockets: anything more is refused before the upgrade. */
  async function underConnectionLimit(_request: FastifyRequest, reply: FastifyReply) {
    if (open.size >= maxConnections) {
      return reply.code(503).send({ error: 'too_many_connections' });
    }
  }

  void app.register(async (scope) => {
    scope.get(
      '/ws',
      { websocket: true, onRequest: [requireExtensionOrigin, underConnectionLimit] },
      (socket, request) => {
        open.add(socket);
        const userAgent = request.headers['user-agent'];
        /** Each operation's count in the current one-second window. */
        const opWindows = new Map<string, { start: number; count: number }>();
        const overOpLimit = (type: string): boolean => {
          const limit = opRateLimits[type];
          if (limit === undefined) return false;
          const at = Date.now();
          const window = opWindows.get(type);
          if (!window || at - window.start >= 1_000) {
            opWindows.set(type, { start: at, count: 1 });
            return false;
          }
          window.count += 1;
          return window.count > limit;
        };
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
            // Another protocol's hello can't be answered in a shape it reads, so the close
            // code and reason (which never change) say which side to update.
            const peer = isBinary ? null : helloProtocol(toText(data));
            if (peer !== null && peer !== PROTOCOL_VERSION) {
              clearTimeout(authTimer);
              setExtensionProtocol(peer);
              socket.close(CloseCode.protocolMismatch, mismatchReason(PROTOCOL_VERSION));
              return;
            }
            if (message?.type !== 'hello') return fail('expected_hello', CloseCode.protocolError);
            setExtensionProtocol(PROTOCOL_VERSION);
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
            browser = browserFromUserAgent(userAgent);
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
            case 'list':
            case 'read':
            case 'stat':
            case 'write':
            case 'delete':
            case 'rename':
            case 'undo':
            case 'watch':
            case 'run':
            case 'run_cancel':
              if (overOpLimit(message.type)) {
                send(
                  serverMessage(message.id, 'response', {
                    ok: false,
                    error: { code: 'rate-limited', message: FILE_ERROR_MESSAGES['rate-limited'] }
                  })
                );
                break;
              }
              // The reply carries the request's id.
              void (
                message.type === 'run' || message.type === 'run_cancel'
                  ? commands(message)
                  : files(message)
              )
                .catch((): FileOutcome<unknown> => ({
                  ok: false,
                  error: { code: 'io-error', message: FILE_ERROR_MESSAGES['io-error'] }
                }))
                .then((outcome) => send(serverMessage(message.id, 'response', outcome)));
              break;
            case 'loop_report':
              onLoopReport(message.payload);
              break;
            case 'session_end':
              onSessionEnd();
              break;
            case 'session_start':
              onSessionStart();
              break;
            default:
              break;
          }
        });

        socket.on('close', () => {
          open.delete(socket);
          clearTimeout(authTimer);
          clearTimeout(idleTimer);
          if (sessions.delete(socket)) onChange();
        });
      }
    );
  });

  return {
    app,

    get port(): number | null {
      return port;
    },

    get connected(): boolean {
      return sessions.size > 0;
    },

    /** The browser of the last extension that authenticated (`Chrome 141.0…`), for diagnostics. */
    get browser(): string | null {
      return browser;
    },

    /**
     * Which side to update, when the last extension to say hello spoke another protocol.
     * Cleared by the next hello in this app's protocol.
     */
    get protocolAdvice(): ProtocolAdvice | null {
      return extensionProtocol === null
        ? null
        : protocolAdvice(PROTOCOL_VERSION, extensionProtocol);
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

    /** Tells the connected extension about a project or config change. */
    pushStatus(): void {
      this.broadcast(statusMessage());
    },

    /** Sends a message (run output, loop_stop) to every authenticated socket. */
    broadcast(message: ServerMessage): void {
      const text = JSON.stringify(message);
      for (const socket of sessions) {
        if (socket.readyState === socket.OPEN) socket.send(text);
      }
    },

    async close(): Promise<void> {
      closeSessions(1001, 'shutting down');
      await app.close();
      port = null;
    }
  };
}
