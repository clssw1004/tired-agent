/**
 * Fastify application factory — creates, configures, and returns a fully
 * wired Fastify instance ready for a single `app.listen()` call.
 *
 * History: extracted from index.ts (stage 3 refactor) so the entry point
 * is pure orchestration.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Storage } from './session/storage.js';
import type { SessionManager } from './session/manager.js';
import { registerAuth } from './auth.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerStreamRoute } from './routes/stream.js';
import { log } from './util/log.js';
import './types.js'; // module augmentation for FastifyInstance.storage

export interface AppFactory {
  app: FastifyInstance;
}

export async function createApp(
  cfg: ServerConfig,
  storage: Storage,
  manager: SessionManager,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use our own pino logger
    trustProxy: true,
  });

  // Expose storage on the app so routes can use it (typed via module augmentation)
  app.storage = storage;

  // ── CORS ───────────────────────────────────────────────────────────────
  if (cfg.corsMode === 'off') {
    log.info('CORS disabled — assume SPA + API share an origin (reverse-proxy it)');
  } else if (cfg.corsMode === 'allowlist') {
    await app.register(cors, {
      origin: cfg.corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
    });
    log.info({ origins: cfg.corsOrigins }, 'CORS allowlist active');
  } else {
    await app.register(cors, {
      origin: true,
      credentials: false,
      methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
    });
    log.info('CORS wildcard — set CORS_ORIGIN or CLSSW_STRICT_CORS=1 to tighten');
  }

  // ── Auth ───────────────────────────────────────────────────────────────
  registerAuth(app, cfg.token);

  // ── Routes ─────────────────────────────────────────────────────────────
  registerSessionsRoutes(app, manager, storage, cfg);
  registerStreamRoute(app, manager, cfg);

  // Health check (no auth required)
  app.get('/health', async (_req, reply) => reply.code(200).send({ status: 'ok', ts: Date.now() }));

  // ── Global error handler — never crash on a single request ───────────
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
