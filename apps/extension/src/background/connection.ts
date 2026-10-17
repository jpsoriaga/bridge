import {
  candidatePorts,
  clientMessage,
  CloseCode,
  HealthResponse,
  PairFailure,
  PairSuccess,
  parseMessage,
  ServerMessage,
  type ClientMessage,
  type ConnectionStatus
} from '@bridge/shared';
import type { PairResult } from '../messages';
import { Reconnector } from './backoff';

export const PING_INTERVAL_MS = 20_000;
/** No message from the desktop for this long and the socket is treated as dead. */
export const STALE_AFTER_MS = 50_000;
const HEALTH_TIMEOUT_MS = 800;
const PAIR_TIMEOUT_MS = 5_000;

export interface ConnectionStorage {
  getToken(): Promise<string | null>;
  setToken(token: string | null): Promise<void>;
  getPort(): Promise<number | null>;
  setPort(port: number): Promise<void>;
}

export interface ConnectionDeps {
  storage: ConnectionStorage;
  fetch: typeof fetch;
  createSocket: (url: string) => WebSocket;
  randomId: () => string;
  now?: () => number;
}

const base = (port: number) => `127.0.0.1:${port}`;

/**
 * The service worker's single link to the desktop app: finds it on loopback, pairs,
 * authenticates in the first message, pings, and reconnects with backoff.
 */
export class Connection {
  private status: ConnectionStatus = 'connecting';
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();
  private readonly reconnector = new Reconnector(() => void this.connect());
  private readonly now: () => number;
  private socket: WebSocket | null = null;
  private inFlight: Promise<void> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageAt = 0;

  constructor(private readonly deps: ConnectionDeps) {
    this.now = deps.now ?? Date.now;
  }

  get current(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Connect now unless already connected or trying. Safe to call on every wake-up. */
  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    this.inFlight ??= this.attempt().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Skip the backoff wait, e.g. when the side panel opens. */
  retry(): Promise<void> {
    this.reconnector.cancel();
    this.reconnector.reset();
    return this.connect();
  }

  async pair(code: string): Promise<PairResult> {
    const port = await this.discover();
    if (port === null) {
      this.setStatus('app-not-running');
      return { ok: false, error: 'app-not-running' };
    }

    let response: Response;
    let body: unknown;
    try {
      response = await this.deps.fetch(`http://${base(port)}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
      });
      body = await response.json().catch(() => null);
    } catch {
      return { ok: false, error: 'app-not-running' };
    }

    const success = response.ok ? PairSuccess.safeParse(body) : null;
    if (success?.success) {
      await this.deps.storage.setToken(success.data.token);
      await this.deps.storage.setPort(port);
      this.dropSocket();
      await this.retry();
      return { ok: true };
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

  /** Revokes the token on the desktop (best effort) and forgets it here. */
  async unpair(): Promise<void> {
    const token = await this.deps.storage.getToken();
    const port = await this.deps.storage.getPort();
    this.reconnector.cancel();
    this.dropSocket();
    if (token && port !== null) {
      try {
        await this.deps.fetch(`http://${base(port)}/unpair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: '{}',
          signal: AbortSignal.timeout(PAIR_TIMEOUT_MS)
        });
      } catch {
        // App not running. The desktop still holds the hash until it unpairs or re-pairs.
      }
    }
    await this.deps.storage.setToken(null);
    this.setStatus('not-paired');
  }

  private async attempt(): Promise<void> {
    const [token, port] = await Promise.all([this.deps.storage.getToken(), this.discover()]);
    if (port === null) {
      this.setStatus('app-not-running');
      this.reconnector.schedule();
      return;
    }
    if (!token) {
      // Nothing to connect with. Pairing calls retry() once it has a token.
      this.setStatus('not-paired');
      return;
    }
    this.setStatus('connecting');
    this.open(port, token);
  }

  /** Finds the desktop on loopback. Tries the last good port first, then the whole range. */
  private async discover(): Promise<number | null> {
    const saved = await this.deps.storage.getPort();
    const ports = [...new Set([...(saved === null ? [] : [saved]), ...candidatePorts()])];
    const results = await Promise.all(ports.map((port) => this.probe(port)));
    return ports.find((_, i) => results[i]) ?? null;
  }

  private async probe(port: number): Promise<boolean> {
    try {
      const response = await this.deps.fetch(`http://${base(port)}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      return response.ok && HealthResponse.safeParse(await response.json()).success;
    } catch {
      return false;
    }
  }

  private open(port: number, token: string): void {
    // The token goes in the first message, never in the URL.
    const socket = this.deps.createSocket(`ws://${base(port)}/ws`);
    this.socket = socket;
    let opened = false;
    let authed = false;

    socket.onopen = () => {
      opened = true;
      this.lastMessageAt = this.now();
      this.send(socket, clientMessage(this.deps.randomId(), 'auth', { token }));
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      const message = parseMessage(ServerMessage, event.data);
      if (!message) return;
      this.lastMessageAt = this.now();
      switch (message.type) {
        case 'auth_ok':
          authed = true;
          this.reconnector.reset();
          void this.deps.storage.setPort(port);
          this.setStatus('connected');
          this.startPing(socket);
          break;
        case 'ping':
          this.send(socket, clientMessage(this.deps.randomId(), 'pong', {}));
          break;
        default:
          // auth_error is followed by a close; status, pong and error need no action yet.
          break;
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPing();
      if (event.code === CloseCode.unauthorized) {
        // Revoked, replaced by another pairing, or never valid.
        void this.deps.storage.setToken(null);
        this.setStatus('not-paired');
        return;
      }
      // Reachable over HTTP but the socket never opened: the desktop refused us.
      this.setStatus(opened || authed ? 'connecting' : 'error');
      this.reconnector.schedule();
    };
  }

  private send(socket: WebSocket, message: ClientMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private startPing(socket: WebSocket): void {
    this.stopPing();
    // Also keeps the MV3 service worker alive: socket traffic resets its idle timer.
    this.pingTimer = setInterval(() => {
      if (this.now() - this.lastMessageAt > STALE_AFTER_MS) {
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
    socket?.close(1000, 'client closing');
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
