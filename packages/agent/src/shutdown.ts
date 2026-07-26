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
  cleanup?: () => void,
): void {
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutdown signal received');

    // Force-exit after 1.5s — must be faster than tsx watch's internal
    // timeout (which on Windows is ~2-3s) so we release the port before
    // tsx tries to spawn the replacement child process.
    const forceExitTimer = setTimeout(() => {
      log.warn('graceful shutdown timed out, forcing exit');
      process.exit(0);
    }, 1500);

    cleanup?.();
    manager.stopCleanupTimer();
    try {
      await app.close();
    } catch (err) {
      log.warn({ err }, 'error while closing Fastify');
    }
    try {
      await storage.close();
    } catch (err) {
      log.warn({ err }, 'error while closing storage');
    }

    clearTimeout(forceExitTimer);
    log.info('server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
