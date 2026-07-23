/**
 * Fastify application factory for the manager.
 *
 * Wires up CORS, auth, routes, the SPA host, and a global error handler.
 * Heavy lifting lives in the route modules; this file is pure glue.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import type { ManagerConfig } from './config.js';
import type { Storage } from './storage.js';
import { API_PREFIX } from '@tired-agent/protocol';
import { registerAuth } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerProxyRoutes } from './routes/proxy.js';
import { registerWebRoutes } from './web.js';
import { log } from './util/log.js';

export async function createApp(
  cfg: ManagerConfig,
  storage: Storage,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // we use our own pino logger
    trustProxy: true,
  });

  // ── CORS ───────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: cfg.corsOrigin,
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
  });

  // ── Health check (public, no auth) ─────────────────────────────────────
  app.get('/health', async (_req, reply) =>
    reply.code(200).send({ status: 'ok', ts: Date.now() }),
  );

  // ── Auth ───────────────────────────────────────────────────────────────
  // Auth must be registered before any protected route, including
  // /api/v1/manager/auth/me (which is itself authenticated and just returns OK).
  registerAuth(app, storage);

  // ── API Routes (all under API_PREFIX) ──────────────────────────────────
  app.register(async (scoped) => {
    registerAuthRoutes(scoped, storage, cfg);
    registerAgentRoutes(scoped, storage);
    registerProxyRoutes(scoped, storage);
  }, { prefix: API_PREFIX });

  // ── SPA host (must come last so it can install a catch-all 404) ─────────
  await registerWebRoutes(app, cfg.webDistPath);

  // ── Global error handler — never crash on a single request ────────────
  app.setErrorHandler((err, req, reply) => {
    log.error(
      { err: err.message, code: (err as { code?: string }).code, url: req.url },
      'request error',
    );
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