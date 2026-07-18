/**
 * tired-agent agent daemon — PTY executor entry point.
 *
 * Exports {@link main} for programmatic use. Also runs as a standalone
 * entry (from `node dist/index.js` or `npm start`) — in that case it
 * parses argv with the embedded CLI.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env when invoked directly (e.g. `node dist/index.js`).
// When invoked via cli.ts, dotenv is already loaded — this is harmless.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import { loadConfig, validateConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { createStorage } from './session/storage.js';
import { SessionManager } from './session/manager.js';
import { createApp } from './app.js';
import { registerShutdown } from './shutdown.js';
import { log } from './util/log.js';
import { getOrRegisterCredentials } from './register.js';
import type { StorageKind } from './session/storage.js';

/** Start the agent with a fully resolved config. */
export async function main(cfg: ServerConfig) {
  validateConfig(cfg);

  // ── Auto-register with Manager if configured ───────────────────
  if (cfg.registerString) {
    try {
      log.info('Registering with Manager…');
      const creds = await getOrRegisterCredentials(cfg);
      if (creds) {
        cfg.token = creds.token;
        log.info({ agentId: creds.id }, 'Registration complete');
      }
    } catch (err) {
      log.error({ err }, 'Registration failed');
      // Non-fatal: the agent will still start with its configured token.
    }
  } else {
    // Check for previously saved credentials (from a prior registration).
    try {
      const creds = await getOrRegisterCredentials(cfg);
      if (creds) {
        cfg.token = creds.token;
        log.debug('Loaded agent credentials from file');
      }
    } catch {
      // Ignore — will use configured token.
    }
  }

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

  const manager = new SessionManager(storage);
  const reconciled = manager.reconcileWithStorage();
  if (reconciled > 0) log.warn({ reconciled }, 'orphaned sessions marked exited on startup');
  manager.startCleanupTimer();

  const app = await createApp(cfg, storage, manager);

  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  registerShutdown(app, storage, manager);

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    log.info({ host: cfg.host, port: cfg.port }, 'tired-agent agent listening');
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

// Direct invocation: parse argv and start.
// When invoked via cli.ts the commander entry bypasses this.
const _cfg = loadConfig(process.argv);
main(_cfg).catch((err) => {
  log.fatal({ err }, 'unhandled startup error');
  process.exit(1);
});
