/**
 * Fastify application factory for the PTY-only agent.
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import type { Storage } from './session/storage.js';
import type { SessionManager } from './session/manager.js';
import type { DirectoryService, DirectoryStore } from './directory/types.js';
import { API_PREFIX } from '@tired-agent/protocol';
import { registerAuth } from './auth.js';
import { registerSessionsRoutes } from './routes/sessions.js';
import { registerStreamRoute } from './routes/stream.js';
import { registerDirectoryRoutes } from './routes/directories.js';
import { registerClaudeProjectsRoutes } from './routes/claude-projects.js';
import { log, initLogger } from './util/log.js';
import { config as loadDotenv } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch, release } from 'node:os';
import { readFileSync } from 'node:fs';

// Read version from package.json at module load time
const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_VERSION: string = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8'),
).version ?? '0.0.0';

export async function createApp(
  cfg: ServerConfig,
  storage: Storage,
  manager: SessionManager,
  directoryService: DirectoryService,
  directoryStore: DirectoryStore,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  registerAuth(app, cfg.token);

  // ── API Routes (all under API_PREFIX) ────────────────────────────────
  app.register(async (scoped) => {
    registerSessionsRoutes(scoped, manager, storage, cfg);
    registerStreamRoute(scoped, manager, storage, cfg);
    registerDirectoryRoutes(scoped, directoryService, directoryStore);
    registerClaudeProjectsRoutes(scoped, directoryService);
  }, { prefix: API_PREFIX });

  // Health check (no auth required)
  app.get('/health', async (_req, reply) =>
    reply.code(200).send({
      status: 'ok',
      name: cfg.name,
      port: cfg.port,
      ts: Date.now(),
      version: AGENT_VERSION,
      uptime: Math.floor(process.uptime()),
      platform: { os: platform(), arch: arch(), release: release() },
    }),
  );

  // Global error handler — never crash on a single request
  app.setErrorHandler((err: unknown, req, reply) => {
    const e = err as { message?: string; code?: string; statusCode?: number };
    log.error({ err: e.message, code: e.code, url: req.url }, 'request error');
    if (reply.sent) return reply;
    try {
      return reply.code(e.statusCode ?? 500).send({
        error: { code: 'INTERNAL', message: e.message ?? 'Unknown error' },
      });
    } catch {
      return reply;
    }
  });

  return app;
}
