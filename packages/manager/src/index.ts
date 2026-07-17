/**
 * tired-pc manager — entry point.
 *
 * Orchestrates bootstrapping; heavy lifting lives in app.ts / shutdown.ts.
 *
 * Run with:
 *   npm run dev -- --port 8443 --token <secret> --host 0.0.0.0
 *
 * Or via env vars (loaded automatically from the package root):
 *   CLSSW_MANAGER_PORT, CLSSW_MANAGER_HOST, CLSSW_MANAGER_TOKEN,
 *   CLSSW_MANAGER_DATA, CLSSW_MANAGER_WEB_DIST, CORS_ORIGIN.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load .env from the manager package root, regardless of process.cwd().
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import { loadConfig, validateConfig } from './config.js';
import { createStorage } from './storage.js';
import { createApp } from './app.js';
import { registerShutdown } from './shutdown.js';
import { log } from './util/log.js';

async function main(argv: string[]) {
  const cfg = loadConfig(argv);
  validateConfig(cfg);

  const storage = createStorage(cfg.dataDir);
  await storage.init();
  log.info({ dataDir: cfg.dataDir }, 'storage initialized');

  const app = await createApp(cfg, storage);

  // Process-level error logs (prevent crash, log only).
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  registerShutdown(app, storage);

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    log.info({ host: cfg.host, port: cfg.port }, 'tired-pc manager listening');
    log.info(
      { tokenHint: cfg.token.slice(0, 4) + '****' },
      'Log in with: POST /v1/manager/auth/login { "token": "<token>" }',
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