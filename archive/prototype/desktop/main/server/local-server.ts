import fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { configService } from '../services/config.service';
import { securityService } from '../services/security.service';
import { registerRoutes } from './routes';

export class LocalServer {
  private app: FastifyInstance | null = null;
  private isRunning = false;

  async start(): Promise<number> {
    if (this.isRunning && this.app) {
      return configService.getServerPort();
    }

    this.app = fastify({
      logger: false // Suppress raw server logging to prevent token/credential leaks
    });

    // Configure CORS for loopback and extension communication
    await this.app.register(cors, {
      origin: (origin, cb) => {
        if (!origin) {
          // Allow non-browser requests or local tools
          return cb(null, true);
        }
        if (origin.startsWith('chrome-extension://') || origin.startsWith('http://127.0.0.1')) {
          return cb(null, true);
        }
        return cb(new Error('Origin not allowed by Bridge CORS policy'), false);
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization']
    });

    // Global authentication hook for protected API routes
    this.app.addHook('onRequest', async (request, reply) => {
      // Allow preflight OPTIONS
      if (request.method === 'OPTIONS') {
        return;
      }

      // Handshake handles its own token in body payload
      if (request.url.startsWith('/api/v1/handshake')) {
        return;
      }

      const authHeader = request.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

      if (!securityService.verifyToken(token)) {
        return reply.status(401).send({
          error: 'Unauthorized: Invalid or missing bearer authentication token'
        });
      }
    });

    await registerRoutes(this.app);

    const port = configService.getServerPort();
    const host = configService.getServerHost(); // Strictly '127.0.0.1'

    try {
      await this.app.listen({ port, host });
      this.isRunning = true;
      console.log(`[Bridge Desktop] Secure local server listening on http://${host}:${port}`);
      return port;
    } catch (err) {
      console.error('[Bridge Desktop] Failed to bind local server:', err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.isRunning = false;
      console.log('[Bridge Desktop] Local server stopped');
    }
  }

  getStatus(): { isRunning: boolean; port: number; host: string } {
    return {
      isRunning: this.isRunning,
      port: configService.getServerPort(),
      host: configService.getServerHost()
    };
  }
}

export const localServer = new LocalServer();
