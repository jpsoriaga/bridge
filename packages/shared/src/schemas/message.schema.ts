import { z } from 'zod';
import { BRIDGE_PROTOCOL_VERSION } from '../protocol/version';

export const ProtocolEnvelopeSchema = z.object({
  version: z.string().default(BRIDGE_PROTOCOL_VERSION),
  id: z.string().uuid(),
  type: z.string().min(1),
  timestamp: z.number().int().positive(),
  payload: z.unknown()
});

export const BridgeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional()
});

export type ProtocolEnvelopeRaw = z.infer<typeof ProtocolEnvelopeSchema>;
export type BridgeError = z.infer<typeof BridgeErrorSchema>;
