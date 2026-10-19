import {
  candidatePorts,
  clientMessage,
  CloseCode,
  FILE_RESULTS,
  HealthResponse,
  PairFailure,
  parseMismatchReason,
  protocolAdvice,
  PairSuccess,
  pairTranscript,
  parseMessage,
  PROTOCOL_VERSION,
  ServerMessage,
  UnpairChallengeResponse,
  type BridgeConfig,
  type ClientMessage,
  type ConnectionStatus,
  type FileRequestType,
  type FileResult,
  type ProjectInfo,
  type ProtocolAdvice,
  type RunResult
} from '@bridge/shared';
import type { PairConfirmResult, PairResult, RequestOutcome } from '../messages';
import { Reconnector } from './backoff';
import { derivePairing, pairingKeyPair, randomNonce, signProof, verifyProof } from './proof';

export const PING_INTERVAL_MS = 20_000;
/** After `rate-limited`, wait out the app's one-second window, then try again. */
export const RATE_LIMIT_RETRY_MS = 1_100;
export const RATE_LIMIT_RETRIES = 5;
/** No message from the desktop for this long and the socket is treated as dead. */
export const STALE_AFTER_MS = 50_000;
/** hello → challenge → auth → auth_ok must finish within this. */
export const HANDSHAKE_TIMEOUT_MS = 5_000;
/** A file request with no response by then fails with `timeout`. */
export const REQUEST_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 800;
const PAIR_TIMEOUT_MS = 5_000;

export interface ConnectionStorage {
  /** SHA-256 of the pairing token, hex. The token itself is never stored. */
  getTokenHash(): Promise<string | null>;
  setTokenHash(hash: string | null): Promise<void>;
  /** The port of the last server that proved it holds the key. Tried first. */
  getPort(): Promise<number | null>;
  setPort(port: number): Promise<void>;
}

/** A periodic wake-up (chrome.alarms) so a stopped worker still reconnects. */
export interface ReconnectAlarm {
  set(): void;
  clear(): void;
}

export interface ConnectionDeps {
  storage: ConnectionStorage;
  fetch: typeof fetch;
  createSocket: (url: string) => WebSocket;
  randomId: () => string;
  alarm: ReconnectAlarm;
  now?: () => number;
  /** Ports the app may listen on, in order. `candidatePorts()` unless built for the e2e scripts. */
  ports?: readonly number[];
}

/** Events the desktop pushes about the running command, and its Stop for the loop. */
export type DesktopEvent =
  | { type: 'run-output'; runId: string; chunk: string }
  | { type: 'run-exit'; result: RunResult }
  | { type: 'loop-stop' }
  | { type: 'files-changed'; paths: string[]; overflow: boolean };

/** A ping tick this late means the computer slept (timers don't run while asleep). */
export const WAKE_GAP_MS = 3 * PING_INTERVAL_MS;

type Handshake =
  /** `backlog`: messages that arrived after auth_ok, before the socket was adopted. */
  | { kind: 'ok'; socket: WebSocket; backlog: MessageEvent[] }
  /** The server's proof was wrong: not our app. Never try this port again this session. */
  | { kind: 'impostor' }
  /** The server proved itself, then refused our proof: our key is no longer valid. */
  | { kind: 'revoked' }
  /** The app speaks another protocol version (close 4009): one side needs updating. */
  | { kind: 'mismatch'; advice: ProtocolAdvice }
  /** Closed, timed out or unpaired before proving anything. */
  | { kind: 'refused' };

/** Which side to update, from an app's /health, or null if it speaks our protocol (or doesn't say). */
function healthAdvice(health: HealthResponse): ProtocolAdvice | null {
  return health.protocol === undefined ? null : protocolAdvice(health.protocol, PROTOCOL_VERSION);
}

const base = (port: number) => `127.0.0.1:${port}`;

/**
 * The service worker's single link to the desktop app. It finds the app on loopback,
 * pairs, runs the mutual challenge (see PLAN.md, "Socket auth"), pings, and reconnects
 * with backoff plus a 1-minute alarm.
 */
export class Connection {
  private status: ConnectionStatus = 'connecting';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();
  private readonly reconnector = new Reconnector(() => void this.connect());
  private readonly now: () => number;
  private readonly ports: readonly number[];
  /** Ports whose server failed the challenge. Cleared by an explicit retry or pairing. */
  private readonly impostors = new Set<number>();
  private socket: WebSocket | null = null;
  private inFlight: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;
  /** Bumped by pair/unpair so an attempt that was already running gives up its result. */
  private generation = 0;
  /** A code redeemed: the key and fingerprint, waiting for the user to confirm. Memory only. */
  private pendingPair: { port: number; key: string; nonce: string; fingerprint: string } | null =
    null;
  private paired = false;
  private alarmSet = false;
  private projectInfo: ProjectInfo | null = null;
  private readonly projectListeners = new Set<(project: ProjectInfo | null) => void>();
  private configInfo: BridgeConfig | null = null;
  private readonly configListeners = new Set<(config: BridgeConfig | null) => void>();
  private readonly eventListeners = new Set<(event: DesktopEvent) => void>();
  private readonly pending = new Map<
    string,
    {
      type: FileRequestType;
      resolve: (outcome: RequestOutcome<unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
    this.ports = deps.ports ?? candidatePorts();
  }

  get current(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The desktop's open project, as its last `status` said. Null while disconnected. */
  get project(): ProjectInfo | null {
    return this.projectInfo;
  }

  onProject(listener: (project: ProjectInfo | null) => void): () => void {
    this.projectListeners.add(listener);
    return () => this.projectListeners.delete(listener);
  }

  /** The app's mode, allowlist and loop settings, from its last `status`. Null while disconnected. */
  get config(): BridgeConfig | null {
    return this.configInfo;
  }

  onConfig(listener: (config: BridgeConfig | null) => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  /** Run output, run exits and the app's loop Stop. */
  onEvent(listener: (event: DesktopEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** A one-way message to the desktop (loop reports, session end). Dropped if not connected. */
  notify<T extends 'loop_report' | 'session_end' | 'session_start'>(
    type: T,
    payload: Extract<ClientMessage, { type: T }>['payload']
  ): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    this.send(socket, {
      v: PROTOCOL_VERSION,
      id: this.deps.randomId(),
      type,
      payload
    } as ClientMessage);
    return true;
  }

  /**
   * Sends a file request and resolves with the desktop's answer, checked against the
   * result schema for `type`. Never rejects.
   */
  /**
   * Sends a request and waits for its reply. The app caps how many of each kind it takes a
   * second; a `rate-limited` reply is retried after the window passes (a few times), so a
   * burst (Apply all, re-checking files in context) slows down instead of failing.
   */
  async request<T extends FileRequestType>(
    type: T,
    payload: Extract<ClientMessage, { type: T }>['payload']
  ): Promise<RequestOutcome<FileResult<T>>> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.requestOnce(type, payload);
      if (outcome.ok || outcome.error.code !== 'rate-limited' || attempt >= RATE_LIMIT_RETRIES) {
        return outcome;
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_MS));
    }
  }

  /** One try. `payload` is already typed by `request`, which is the only caller. */
  private requestOnce<T extends FileRequestType>(
    type: T,
    payload: unknown
  ): Promise<RequestOutcome<FileResult<T>>> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({
        ok: false,
        error: { code: 'not-connected', message: 'Not connected to the Bridge app.' }
      });
    }
    const id = this.deps.randomId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          error: { code: 'timeout', message: 'The Bridge app did not answer.' }
        });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        type,
        resolve: resolve as (outcome: RequestOutcome<unknown>) => void,
        timer
      });
      this.send(socket, { v: PROTOCOL_VERSION, id, type, payload } as ClientMessage);
    });
  }

  /** Connect now unless already connected or trying. Safe to call on every wake-up. */
  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.inFlight ??= this.attempt().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * The computer woke up (a tab noticed its timers stalled). Disconnected: try now, not
   * after the backoff. Connected: check the socket with a ping, giving it a fresh window,
   * rather than closing it because nothing arrived while asleep.
   */
  wake(): void {
    const socket = this.socket;
    if (!socket) {
      void this.retry();
      return;
    }
    this.lastMessageAt = this.now();
    this.send(socket, clientMessage(this.deps.randomId(), 'ping', {}));
  }

  /** Skip the backoff wait, e.g. when the side panel opens. */
  retry(): Promise<void> {
    this.reconnector.cancel();
    this.reconnector.reset();
    this.impostors.clear();
    return this.connect();
  }

  /**
   * Step 1 of pairing: sends the code and a one-time public key to the first Bridge that
   * answers, checks its proof, and returns the fingerprint to compare with the app's.
   * Nothing is stored until `confirmPair`.
   */
  async pair(code: string): Promise<PairResult> {
    this.pendingPair = null;
    // Nothing can prove itself before pairing, so this takes the first Bridge that answers.
    // The fingerprint is what catches anything else listening there.
    const found = await this.findApp();
    if (found === null) {
      this.setStatus('app-not-running');
      return { ok: false, error: 'app-not-running' };
    }
    const { port } = found;
    const advice = healthAdvice(found.health);
    if (advice) {
      this.announce(port);
      this.setStatus(advice);
      return { ok: false, error: advice };
    }

    const own = await pairingKeyPair();
    let response: Response;
    let body: unknown;
    try {
      response = await this.deps.fetch(`http://${base(port)}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, publicKey: own.publicKey }),
        signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
      });
      body = await response.json().catch(() => null);
    } catch {
      return { ok: false, error: 'app-not-running' };
    }

    const success = response.ok ? PairSuccess.safeParse(body) : null;
    if (success?.success) {
      const transcript = pairTranscript(port, code, success.data.publicKey, own.publicKey);
      let derived;
      try {
        derived = await derivePairing(own.privateKey, success.data.publicKey, transcript);
      } catch {
        return { ok: false, error: 'failed' };
      }
      // The app must show it derived the same key before the user is asked anything.
      if (
        !(await verifyProof(derived.key, success.data.proof, 'server', 'pair', port, derived.nonce))
      ) {
        return { ok: false, error: 'failed' };
      }
      this.pendingPair = { port, ...derived };
      return { ok: true, fingerprint: derived.fingerprint };
    }

    const failure = PairFailure.safeParse(body);
    if (failure.success && failure.data.error === 'locked') {
      return { ok: false, error: 'locked', retryAfterMs: failure.data.retryAfterMs ?? 60_000 };
    }
    if (failure.success && failure.data.error === 'invalid_code') {
      return { ok: false, error: 'invalid_code' };
    }
    return { ok: false, error: 'failed' };
  }

  /**
   * Step 2, after the user saw the same fingerprint here and in the app: proves this
   * extension holds the key, and keeps it once the app accepts. The app accepts only after
   * its own user confirmed the fingerprint.
   */
  async confirmPair(): Promise<PairConfirmResult> {
    const pending = this.pendingPair;
    if (!pending) return { ok: false, error: 'expired' };
    let response: Response;
    let body: unknown;
    try {
      response = await this.deps.fetch(`http://${base(pending.port)}/pair/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          proof: await signProof(pending.key, 'client', 'pair', pending.port, pending.nonce)
        }),
        signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
      });
      body = await response.json().catch(() => null);
    } catch {
      return { ok: false, error: 'app-not-running' };
    }
    if (response.status === 204) {
      this.pendingPair = null;
      await this.deps.storage.setTokenHash(pending.key);
      await this.deps.storage.setPort(pending.port);
      this.setPaired(true);
      this.generation += 1;
      this.dropSocket();
      await this.retry();
      return { ok: true };
    }
    const failure = PairFailure.safeParse(body);
    if (failure.success && failure.data.error === 'not_confirmed') {
      return { ok: false, error: 'not-confirmed' };
    }
    this.pendingPair = null;
    return { ok: false, error: 'expired' };
  }

  /** The fingerprints didn't match, or the user gave up: forget the exchange. */
  cancelPair(): void {
    this.pendingPair = null;
  }

  /** Revokes the pairing on the desktop (best effort) and forgets the key here. */
  async unpair(): Promise<void> {
    const [key, port] = await Promise.all([
      this.deps.storage.getTokenHash(),
      this.deps.storage.getPort()
    ]);
    this.generation += 1;
    this.reconnector.cancel();
    this.dropSocket();
    if (key && port !== null) {
      try {
        await this.revokeRemotely(port, key);
      } catch {
        // App not running. The desktop keeps the key until it unpairs or pairs again.
      }
    }
    await this.deps.storage.setTokenHash(null);
    this.setPaired(false);
    this.setStatus('not-paired');
  }

  private async revokeRemotely(port: number, key: string): Promise<void> {
    const post = (path: string, body: unknown) =>
      this.deps.fetch(`http://${base(port)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
      });
    const nonce = randomNonce();
    const challenge = UnpairChallengeResponse.safeParse(
      await (await post('/unpair/challenge', { nonce })).json()
    );
    if (!challenge.success) return;
    const { proof, serverNonce } = challenge.data;
    // Don't hand our proof to something that can't prove it's the app.
    if (!(await verifyProof(key, proof, 'server', 'unpair', port, nonce))) return;
    await post('/unpair', {
      serverNonce,
      proof: await signProof(key, 'client', 'unpair', port, serverNonce)
    });
  }

  private async attempt(): Promise<void> {
    const generation = this.generation;
    const key = await this.deps.storage.getTokenHash();
    this.setPaired(key !== null);

    if (!key) {
      // Still look for the app, so the panel can say whether to open it before pairing.
      const found = await this.findApp();
      const advice = found && healthAdvice(found.health);
      if (found === null) {
        this.setStatus('app-not-running');
        this.reconnector.schedule();
      } else if (advice) {
        // Tell the app too, so it can say which side to update. Then wait for an update.
        this.announce(found.port);
        this.setStatus(advice);
        this.reconnector.schedule();
      } else {
        // Nothing to connect with. Pairing calls retry() once it has a key.
        this.setStatus('not-paired');
      }
      return;
    }

    let sawApp = false;
    let mismatch: ProtocolAdvice | null = null;
    const tryPort = async (port: number): Promise<boolean> => {
      if (this.impostors.has(port)) return false;
      if (!(await this.probe(port))) return false;
      sawApp = true;
      this.setStatus('connecting');
      const result = await this.handshake(port, key);
      if (generation !== this.generation) {
        if (result.kind === 'ok') result.socket.close(1000, 'superseded');
        return true;
      }
      switch (result.kind) {
        case 'ok':
          this.adopt(result.socket, port, result.backlog);
          return true;
        case 'revoked':
          await this.forgetKey();
          return true;
        case 'impostor':
          this.impostors.add(port);
          return false;
        case 'mismatch':
          mismatch = result.advice;
          return false;
        case 'refused':
          return false;
      }
    };

    // The pinned port first. Only if it fails, the rest of the range, in order.
    const pinned = await this.deps.storage.getPort();
    if (pinned !== null && (await tryPort(pinned))) return;
    for (const port of this.ports) {
      if (port !== pinned && (await tryPort(port))) return;
    }

    if (generation !== this.generation) return;
    // A Bridge answered /health but none passed the challenge (or it isn't paired). Keeps
    // trying, so it connects once the out-of-date side is updated.
    this.setStatus(mismatch ?? (sawApp ? 'error' : 'app-not-running'));
    this.reconnector.schedule();
  }

  /** First port in the range whose /health answers as Bridge, pinned port first. */
  private async findApp(): Promise<{ port: number; health: HealthResponse } | null> {
    const saved = await this.deps.storage.getPort();
    const ports = [...new Set([...(saved === null ? [] : [saved]), ...this.ports])];
    const results = await Promise.all(ports.map((port) => this.probe(port)));
    const index = results.findIndex((health) => health !== null);
    return index === -1 ? null : { port: ports[index]!, health: results[index]! };
  }

  private async probe(port: number): Promise<HealthResponse | null> {
    try {
      const response = await this.deps.fetch(`http://${base(port)}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      if (!response.ok) return null;
      const health = HealthResponse.safeParse(await response.json());
      return health.success ? health.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Says hello to an app that speaks another protocol, only so that it closes with
   * `protocolMismatch` and shows which side to update. Nothing else is sent.
   */
  private announce(port: number): void {
    const socket = this.deps.createSocket(`ws://${base(port)}/ws`);
    const timer = setTimeout(() => socket.close(1000, 'done'), HANDSHAKE_TIMEOUT_MS);
    socket.onopen = () =>
      this.send(socket, clientMessage(this.deps.randomId(), 'hello', { nonce: randomNonce() }));
    socket.onclose = () => clearTimeout(timer);
  }

  /**
   * hello(nonce) → challenge(proof, serverNonce) → auth(proof) → auth_ok.
   * The server proves it holds the key before we prove anything, so an impostor learns
   * nothing it could replay.
   */
  private handshake(port: number, key: string): Promise<Handshake> {
    return new Promise((resolve) => {
      const socket = this.deps.createSocket(`ws://${base(port)}/ws`);
      const nonce = randomNonce();
      let serverVerified = false;
      let done = false;

      const finish = (result: Handshake) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.onopen = socket.onmessage = socket.onclose = null;
        if (result.kind === 'ok') {
          socket.onmessage = (event: MessageEvent) => result.backlog.push(event);
        } else {
          socket.close(1000, 'handshake failed');
        }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ kind: 'refused' }), HANDSHAKE_TIMEOUT_MS);

      socket.onopen = () =>
        this.send(socket, clientMessage(this.deps.randomId(), 'hello', { nonce }));

      socket.onmessage = async (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        const message = parseMessage(ServerMessage, event.data);
        if (!message) return;
        if (message.type === 'challenge' && !serverVerified) {
          const { proof, serverNonce } = message.payload;
          if (!(await verifyProof(key, proof, 'server', 'ws', port, nonce))) {
            finish({ kind: 'impostor' });
            return;
          }
          serverVerified = true;
          const ours = await signProof(key, 'client', 'ws', port, serverNonce);
          this.send(socket, clientMessage(this.deps.randomId(), 'auth', { proof: ours }));
        } else if (message.type === 'auth_ok' && serverVerified) {
          finish({ kind: 'ok', socket, backlog: [] });
        }
        // auth_error is followed by a close, handled below.
      };

      socket.onclose = (event: CloseEvent) => {
        if (event.code === CloseCode.protocolMismatch) {
          const app = parseMismatchReason(event.reason);
          const advice = app === null ? null : protocolAdvice(app, PROTOCOL_VERSION);
          if (advice) {
            finish({ kind: 'mismatch', advice });
            return;
          }
        }
        // Only a server that proved it holds our key can tell us the key is dead.
        const revoked = serverVerified && event.code === CloseCode.unauthorized;
        finish({ kind: revoked ? 'revoked' : 'refused' });
      };
    });
  }

  /** Takes over an authenticated socket. */
  private adopt(socket: WebSocket, port: number, backlog: MessageEvent[]): void {
    this.socket = socket;
    this.lastMessageAt = this.now();
    this.reconnector.reset();
    void this.deps.storage.setPort(port);
    this.setStatus('connected');
    this.startPing(socket);

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const message = parseMessage(ServerMessage, event.data);
      if (!message) return;
      this.lastMessageAt = this.now();
      switch (message.type) {
        case 'ping':
          this.send(socket, clientMessage(this.deps.randomId(), 'pong', {}));
          break;
        case 'status':
          this.setProject(message.payload.project);
          this.setConfig(message.payload.config);
          break;
        case 'response':
          this.settle(message.id, message.payload);
          break;
        case 'run_output':
          this.emit({ type: 'run-output', ...message.payload });
          break;
        case 'run_exit':
          this.emit({ type: 'run-exit', result: message.payload });
          break;
        case 'loop_stop':
          this.emit({ type: 'loop-stop' });
          break;
        case 'file_changed':
          this.emit({ type: 'files-changed', ...message.payload });
          break;
        default:
          // pong and error need no action.
          break;
      }
    };
    for (const event of backlog) socket.onmessage(event);

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      this.failPending();
      this.setProject(null);
      this.setConfig(null);
      if (event.code === CloseCode.unauthorized) {
        // Revoked or replaced by another pairing. This server already proved itself.
        void this.forgetKey();
        return;
      }
      this.setStatus('connecting');
      this.reconnector.schedule();
    };
  }

  private async forgetKey(): Promise<void> {
    await this.deps.storage.setTokenHash(null);
    this.setPaired(false);
    this.setStatus('not-paired');
  }

  private send(socket: WebSocket, message: ClientMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    // Also keeps the MV3 service worker alive: socket traffic resets its idle timer.
    let lastTick = this.now();
    this.pingTimer = setInterval(() => {
      const now = this.now();
      const slept = now - lastTick > WAKE_GAP_MS;
      lastTick = now;
      if (slept) {
        // Nothing could arrive while asleep. Ask now instead of calling the socket dead.
        this.wake();
        return;
      }
      if (now - this.lastMessageAt > STALE_AFTER_MS) {
        socket.close();
        return;
      }
      this.send(socket, clientMessage(this.deps.randomId(), 'ping', {}));
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  /** Closes the socket without triggering a reconnect. */
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.stopPing();
    this.failPending();
    this.setProject(null);
    this.setConfig(null);
    socket?.close(1000, 'client closing');
  }

  /** Resolves a pending request with the desktop's response, if it matches the schema. */
  private settle(
    id: string,
    payload: Extract<ServerMessage, { type: 'response' }>['payload']
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (!payload.ok) {
      entry.resolve(payload);
      return;
    }
    const result = FILE_RESULTS[entry.type].safeParse(payload.result);
    entry.resolve(
      result.success
        ? { ok: true, result: result.data }
        : { ok: false, error: { code: 'bad-response', message: 'Unexpected reply from Bridge.' } }
    );
  }

  private failPending(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        ok: false,
        error: { code: 'not-connected', message: 'The connection to Bridge closed.' }
      });
      this.pending.delete(id);
    }
  }

  private setProject(project: ProjectInfo | null): void {
    if (JSON.stringify(project) === JSON.stringify(this.projectInfo)) return;
    this.projectInfo = project;
    for (const listener of this.projectListeners) listener(project);
  }

  private setConfig(config: BridgeConfig | null): void {
    if (JSON.stringify(config) === JSON.stringify(this.configInfo)) return;
    this.configInfo = config;
    for (const listener of this.configListeners) listener(config);
  }

  private emit(event: DesktopEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private setPaired(paired: boolean): void {
    this.paired = paired;
    this.syncAlarm();
  }

  /** The alarm runs only while paired and not connected. */
  private syncAlarm(): void {
    const want = this.paired && this.status !== 'connected';
    if (want === this.alarmSet) return;
    this.alarmSet = want;
    if (want) this.deps.alarm.set();
    else this.deps.alarm.clear();
  }

  private setStatus(status: ConnectionStatus): void {
    const changed = status !== this.status;
    this.status = status;
    this.syncAlarm();
    if (!changed) return;
    for (const listener of this.listeners) listener(status);
  }
}
