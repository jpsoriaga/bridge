import {
  BRIDGE_PROTOCOL_VERSION,
  MessageType,
  type ApplyBatchResult,
  type FileChange,
  type HandshakeResponsePayload,
  type ProtocolEnvelope
} from '@bridge/shared';
import { getSettings } from './storage';

export class BridgeClient {
  private baseUrl = '';
  private token = '';

  async refreshConfig(): Promise<void> {
    const settings = await getSettings();
    this.baseUrl = `http://127.0.0.1:${settings.port}`;
    this.token = settings.token;
  }

  async checkHealth(): Promise<{ ok: boolean; message: string }> {
    await this.refreshConfig();
    if (!this.token) {
      return { ok: false, message: 'Pairing token not configured. Open options to pair.' };
    }
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: {
          Authorization: `Bearer ${this.token}`
        }
      });
      if (res.ok) {
        return { ok: true, message: 'Connected to Bridge Desktop' };
      }
      return { ok: false, message: `Server error: HTTP ${res.status}` };
    } catch {
      return { ok: false, message: 'Cannot reach Bridge Desktop at 127.0.0.1' };
    }
  }

  async handshake(): Promise<HandshakeResponsePayload> {
    await this.refreshConfig();
    const envelope: ProtocolEnvelope = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: MessageType.HANDSHAKE_REQUEST,
      timestamp: Date.now(),
      payload: {
        clientName: 'BridgeChromeExtension',
        clientVersion: '0.1.0',
        token: this.token
      }
    };

    const res = await fetch(`${this.baseUrl}/api/v1/handshake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(envelope)
    });

    if (!res.ok) {
      throw new Error(`Handshake failed with status: ${res.status}`);
    }

    const json = (await res.json()) as ProtocolEnvelope<HandshakeResponsePayload>;
    return json.payload;
  }

  async applyChanges(changes: FileChange[]): Promise<ApplyBatchResult> {
    await this.refreshConfig();
    const envelope: ProtocolEnvelope = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: MessageType.APPLY_CHANGES_REQUEST,
      timestamp: Date.now(),
      payload: {
        batchId: crypto.randomUUID(),
        changes
      }
    };

    const res = await fetch(`${this.baseUrl}/api/v1/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify(envelope)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `Failed to apply changes: HTTP ${res.status}`);
    }

    const json = (await res.json()) as ProtocolEnvelope<ApplyBatchResult>;
    return json.payload;
  }
}

export const bridgeClient = new BridgeClient();
