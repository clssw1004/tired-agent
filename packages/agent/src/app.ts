/**
 * Fastify application factory for the PTY-only agent.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Storage } from './session/storage.js';
import type { SessionManager } from './session/manager.js';
import { registerAuth } from './auth.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerStreamRoute } from './routes/stream.js';
import { log } from './util/log.js';

export async function createApp(
  cfg: ServerConfig,
  storage: Storage,
  manager: SessionManager,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  registerAuth(app, cfg.token);
  registerSessionsRoutes(app, manager, storage, cfg);
  registerStreamRoute(app, manager, storage, cfg);

  // Health check (no auth required)
  app.get('/health', async (_req, reply) => reply.code(200).send({ status: 'ok', ts: Date.now() }));

  // Global error handler — never crash on a single request
  app.setErrorHandler((err, req, reply) => {
    log.error({ err: err.message, code: (err as { code?: string }).code, url: req.url }, 'request error');
    if (reply.sent) return reply;
    try {
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: { code: 'INTERNAL', message: err.message },
      });
    } catch {
      return reply;
    }
  });

  return app;
}
