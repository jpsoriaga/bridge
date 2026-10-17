import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  ApplyChangesRequestSchema,
  BRIDGE_PROTOCOL_VERSION,
  HandshakeRequestSchema,
  MessageType,
  type ApplyBatchResult,
  type ApplyFileResult,
  type HandshakeResponsePayload,
  type ProtocolEnvelope
} from '@bridge/shared';
import { configService } from '../services/config.service';
import { fileManager } from '../filesystem/file-manager';
import { historyManager } from '../history/history-manager';
import { securityService } from '../services/security.service';

export async function registerRoutes(server: FastifyInstance): Promise<void> {
  // Health check endpoint
  server.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      status: 'ok',
      version: BRIDGE_PROTOCOL_VERSION,
      workspace: configService.getSelectedWorkspace() !== null
    });
  });

  // Handshake endpoint
  server.post('/api/v1/handshake', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as ProtocolEnvelope;
    const validation = HandshakeRequestSchema.safeParse(body?.payload);

    if (!validation.success) {
      return reply.status(400).send({
        error: 'Invalid handshake payload',
        details: validation.error.format()
      });
    }

    const { token } = validation.data;
    if (!securityService.verifyToken(token)) {
      return reply.status(401).send({
        error: 'Invalid pairing token'
      });
    }

    const responseEnvelope: ProtocolEnvelope<HandshakeResponsePayload> = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: MessageType.HANDSHAKE_RESPONSE,
      timestamp: Date.now(),
      payload: {
        authenticated: true,
        serverVersion: BRIDGE_PROTOCOL_VERSION,
        workspacePath: configService.getSelectedWorkspace()
      }
    };

    return reply.status(200).send(responseEnvelope);
  });

  // Apply changes endpoint
  server.post('/api/v1/apply', async (req: FastifyRequest, reply: FastifyReply) => {
    const workspace = configService.getSelectedWorkspace();
    if (!workspace) {
      return reply.status(400).send({
        error: 'No active workspace selected in Bridge Desktop. Select a folder first.'
      });
    }

    const body = req.body as ProtocolEnvelope;
    const validation = ApplyChangesRequestSchema.safeParse(body?.payload);

    if (!validation.success) {
      return reply.status(400).send({
        error: 'Invalid apply payload schema',
        details: validation.error.format()
      });
    }

    const { batchId, changes } = validation.data;
    const results: ApplyFileResult[] = [];
    const undoChanges: Array<{ path: string; action: 'create' | 'modify' | 'delete'; originalContent?: string }> = [];

    for (const change of changes) {
      // Record original state for undo
      const originalContent = await fileManager.readOriginal(change.path);
      const res = await fileManager.applyFile(change);
      results.push(res);

      if (res.success) {
        undoChanges.push({
          path: change.path,
          action: change.action,
          originalContent
        });
      }
    }

    if (undoChanges.length > 0) {
      historyManager.recordBatch({
        batchId,
        timestamp: new Date().toISOString(),
        changes: undoChanges
      });
    }

    const responsePayload: ApplyBatchResult = {
      batchId,
      appliedAt: new Date().toISOString(),
      results,
      canUndo: historyManager.canUndo()
    };

    const envelope: ProtocolEnvelope<ApplyBatchResult> = {
      version: BRIDGE_PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      type: MessageType.APPLY_CHANGES_RESPONSE,
      timestamp: Date.now(),
      payload: responsePayload
    };

    return reply.status(200).send(envelope);
  });

  // Status endpoint
  server.get('/api/v1/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      workspace: configService.getSelectedWorkspace(),
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      canUndo: historyManager.canUndo()
    });
  });
}
