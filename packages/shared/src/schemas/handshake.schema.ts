import { z } from 'zod';

export const HandshakeRequestSchema = z.object({
  clientName: z.string().min(1).max(128),
  clientVersion: z.string().min(1).max(32),
  token: z.string().min(16).max(256)
});

export const HandshakeResponseSchema = z.object({
  authenticated: z.boolean(),
  serverVersion: z.string(),
  workspacePath: z.string().nullable(),
  sessionToken: z.string().optional()
});

export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;
