/**
 * tired-pc server daemon — entry point.
 *
 * Orchestrates bootstrapping; heavy lifting lives in app.ts / shutdown.ts.
 *
 * See config.ts for the full list of env variables and CLI flags.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the server package root, regardless of process.cwd().
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import { loadConfig, validateConfig } from './config.js';
import { createStorage } from './session/storage.js';
import { SessionManager } from './session/manager.js';
import { createApp } from './app.js';
import { registerShutdown } from './shutdown.js';
import { log } from './util/log.js';
import type { StorageKind } from './session/storage.js';

async function main(argv: string[]) {
  const cfg = loadConfig(argv);
  validateConfig(cfg);

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

  // Reconcile stale DB rows from a previous run.
  const manager = new SessionManager(storage);
  const reconciled = manager.reconcileWithStorage();
  if (reconciled > 0) log.warn({ reconciled }, 'orphaned sessions marked exited on startup');
  manager.startCleanupTimer();

  // Build the Fastify server.
  const app = await createApp(cfg, storage, manager);

  // Process-level error logs (prevent crash, log only).
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  // Graceful shutdown.
  registerShutdown(app, storage, manager);

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
}

main(process.argv).catch((err) => {
  log.fatal({ err }, 'unhandled startup error');
  process.exit(1);
});
