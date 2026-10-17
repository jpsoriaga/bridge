import type { ConnectionStatus } from '@bridge/shared';

export interface PairingCode {
  /** Six digits, shown to the user and typed into the extension. */
  code: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** Everything the renderer shows about the server and pairing. */
export interface DesktopState {
  /** `connecting` here means paired and waiting for the extension. */
  status: ConnectionStatus;
  paired: boolean;
  /** The port the server is bound to, or null if it isn't running. */
  port: number | null;
  pairing: PairingCode | null;
  /** Epoch ms until which `/pair` refuses codes after too many wrong ones, or null. */
  lockedUntil: number | null;
}

/** Everything the renderer can reach in the main world, as `window.bridge`. Keep it minimal. */
export interface BridgeApi {
  readonly version: string;
  getStatus(): Promise<DesktopState>;
  /** Returns an unsubscribe function. */
  onStatus(listener: (state: DesktopState) => void): () => void;
  startPairing(): Promise<PairingCode>;
  unpair(): Promise<void>;
}

/** One channel per method. Main checks the sender on each. */
export const IPC = {
  getStatus: 'bridge:get-status',
  status: 'bridge:status',
  startPairing: 'bridge:start-pairing',
  unpair: 'bridge:unpair'
} as const;
