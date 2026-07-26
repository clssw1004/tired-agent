/**
 * Graceful shutdown helpers for the manager.
 *
 * Registers SIGINT/SIGTERM handlers that close the Fastify server and
 * the SQLite handle in the right order. No PTY sessions to clean up —
 * the manager is a pure proxy, so any active sessions are owned by
 * agents and will continue running independently.
 */

import type { FastifyInstance } from 'fastify';
import type { Storage } from './storage.js';
import { log } from './util/log.js';

export function registerShutdown(
  app: FastifyInstance,
  storage: Storage,
  cleanup?: () => void | Promise<void>,
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

    try {
      await cleanup?.();
    } catch (err) {
      log.warn({ err }, 'error during cleanup');
    }
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
    log.info('manager stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}