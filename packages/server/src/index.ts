/**
 * tired-pc server daemon — entry point.
 *
 * Usage:
 *   npm run dev -- --token=<secret> --port=8443 --data=./data
 *   node dist/index.js --token=<secret> --port=8443 --data=./data
 *
 * Configuration sources, in priority order (highest first):
 *   1. CLI flags         — e.g. --port 8443 --data ./data --token <secret>
 *   2. Process env vars  — e.g. CLSSW_TOKEN=…  PORT=8443  CLSSW_DATA=…
 *   3. packages/server/.env file (loaded at startup; never overrides existing env)
 *
 * Recognised environment variables:
 *   CLSSW_TOKEN=<secret>          Bearer token (REQUIRED, ≥8 chars)
 *   PORT=8443                     TCP port to listen on
 *   HOST=127.0.0.1                Network interface to bind
 *   CLSSW_DATA=/path/to/data      SQLite DB + PTY log directory
 *   STORAGE_KIND=sqlite           sqlite | mysql | postgres
 *   CLSSW_PERMISSIVE_CORS=1       Allow any CORS origin (also default-on)
 *   CLSSW_STRICT_CORS=1           Disable permissive CORS (production)
 *
 * MySQL (when STORAGE_KIND=mysql):
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *
 * PostgreSQL (when STORAGE_KIND=postgres):
 *   POSTGRES_CONNECTION_STRING
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the server package root, regardless of process.cwd().
// By default dotenv does NOT override existing process.env entries, so CLI flags
// and pre-exported vars stay higher-priority than values declared in .env.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadConfig, validateConfig } from './config.js';
import { createStorage } from './session/storage.js';
import { SessionManager } from './session/manager.js';
import { registerAuth } from './auth.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerStreamRoute } from './routes/stream.js';
import { log } from './util/log.js';
import type { StorageKind } from './session/storage.js';
import './types.js'; // module augmentation for FastifyInstance.storage

async function main(argv: string[]) {
  const cfg = loadConfig(argv);
  validateConfig(cfg);

  // ── Storage ────────────────────────────────────────────────────────────
  const storage = createStorage({
    kind: (process.env['STORAGE_KIND'] as StorageKind) ?? 'sqlite',
    dataDir: cfg.dataDir,
    mysql: process.env['MYSQL_HOST']
      ? {
          host: process.env['MYSQL_HOST']!,
          port: Number(process.env['MYSQL_PORT'] ?? 3306),
          user: process.env['MYSQL_USER'] ?? 'root',
          password: process.env['MYSQL_PASSWORD'] ?? '',
          database: process.env['MYSQL_DATABASE'] ?? 'tired_pc',
        }
      : undefined,
    postgres: process.env['POSTGRES_CONNECTION_STRING']
      ? { connectionString: process.env['POSTGRES_CONNECTION_STRING']! }
      : undefined,
  });

  await storage.init();
  log.info({ dataDir: cfg.dataDir, storageKind: process.env['STORAGE_KIND'] ?? 'sqlite' }, 'storage initialized');

  // ── Session manager ────────────────────────────────────────────────────
  const manager = new SessionManager(storage);

  // ── Fastify ────────────────────────────────────────────────────────────
  const app = Fastify({
    logger: false, // we use our own pino logger
    trustProxy: true,
  });

  // Expose storage on the app so routes can use it (typed via module augmentation)
  app.storage = storage;

  // ── CORS ───────────────────────────────────────────────────────────────
  // Three modes (see config.ts for resolution rules):
  //   'off'        → register nothing (same-origin via reverse proxy).
  //   'allowlist'  → only the explicit origins in `cfg.corsOrigins`.
  //   'wildcard'   → echo back whatever Origin the browser sends (dev conv.).
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
  registerSessionsRoutes(app, manager, cfg);
  registerStreamRoute(app, manager, cfg);

  // Health check (no auth required)
  app.get('/health', async (_req, reply) => reply.code(200).send({ status: 'ok', ts: Date.now() }));

  // ── Global error handler — never crash on a single request ───────────
  app.setErrorHandler((err, req, reply) => {
    log.error({ err: err.message, code: (err as { code?: string }).code, url: req.url }, 'request error');
    // If headers were already sent (e.g. SSE stream), we cannot reply.
    if (reply.sent) return reply;
    try {
      return reply.code((err as { statusCode?: number }).statusCode ?? 500).send({
        error: { code: 'INTERNAL', message: err.message },
      });
    } catch {
      return reply;
    }
  });

  // Catch any uncaught async error and log it instead of crashing
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  // ── Start ─────────────────────────────────────────────────────────────
  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    log.info({ host: cfg.host, port: cfg.port }, 'tired-pc server listening');
    log.info(
      { tokenHint: cfg.token.slice(0, 4) + '****' },
      'Connect with: Authorization: Bearer <token>',
    );
  } catch (err) {
    log.fatal({ err }, 'failed to bind port');
    await storage.close();
    process.exit(1);
  }

  // ── Graceful shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    await app.close();
    await storage.close();
    log.info('server stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main(process.argv).catch((err) => {
  log.fatal({ err }, 'unhandled startup error');
  process.exit(1);
});
