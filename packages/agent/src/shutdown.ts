/**
 * Graceful shutdown helpers — registers SIGINT/SIGTERM handlers that
 * tear down the server and its dependencies in the right order.
 *
 * History: extracted from index.ts (stage 3 refactor).
 */

import type { FastifyInstance } from 'fastify';
import type { Storage } from './session/storage.js';
import type { SessionManager } from './session/manager.js';
import { log } from './util/log.js';

export function registerShutdown(
  app: FastifyInstance,
  storage: Storage,
  manager: SessionManager,
): void {
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');
    manager.stopCleanupTimer();
    await app.close();
    await storage.close();
    log.info('server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
