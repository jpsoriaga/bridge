import type { MessageTypeValue } from '../protocol/events';

export interface ProtocolEnvelope<T = unknown> {
  version: string;
  id: string;
  type: MessageTypeValue;
  timestamp: number;
  payload: T;
}

export interface BridgeErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HandshakeRequestPayload {
  clientName: string;
  clientVersion: string;
  token: string;
}

export interface HandshakeResponsePayload {
  authenticated: boolean;
  serverVersion: string;
  workspacePath: string | null;
  sessionToken?: string;
}
