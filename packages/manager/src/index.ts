/**
 * tired-agent manager — entry point.
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
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Load .env from the manager package root, regardless of process.cwd().
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import { loadConfig, validateConfig } from './config.js';
import { createStorage } from './storage.js';
import { HealthPoller } from './health-poller.js';
import { createApp } from './app.js';
import { registerShutdown } from './shutdown.js';
import { log } from './util/log.js';

async function main(argv: string[]) {
  const cfg = loadConfig(argv);

  // Auto-generate admin token if not configured, persist to .env.
  if (!cfg.token || cfg.token.length < 8) {
    const generated = randomBytes(16).toString('hex');
    cfg.token = generated;
    await persistToken(cfg.token);
    console.log(
      '[tired-agent] No CLSSW_MANAGER_TOKEN configured; auto-generated one.\n' +
      `  Token: ${generated}\n` +
      `  Saved to packages/manager/.env\n` +
      '  Set CLSSW_MANAGER_TOKEN=<value> in .env to pin it.',
    );
  }

  validateConfig(cfg);

  const storage = createStorage(cfg.dataDir);
  await storage.init();
  log.info({ dataDir: cfg.dataDir }, 'storage initialized');

  const healthPoller = new HealthPoller(storage);
  healthPoller.start();

  const app = await createApp(cfg, storage);

  // Process-level error logs (prevent crash, log only).
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  registerShutdown(app, storage, () => {
    healthPoller.stop();
  });

  try {
    await app.listen({ port: cfg.port, host: cfg.host });
    log.info({ host: cfg.host, port: cfg.port }, 'tired-agent manager listening');
    log.info(
      { tokenHint: cfg.token.slice(0, 4) + '****' },
      'Log in with: POST /api/v1/manager/auth/login { "token": "<token>" }',
    );
  } catch (err) {
    // Dev-mode hot-reload guard: if port is still held by a dying process,
    // wait 1s and retry once before giving up.
    if ((err as { code?: string }).code === 'EADDRINUSE') {
      log.warn('port in use, retrying in 1s…');
      await new Promise((r) => setTimeout(r, 1000));
      try {
        await app.listen({ port: cfg.port, host: cfg.host });
      } catch (retryErr) {
        log.fatal({ err: retryErr }, 'failed to bind port after retry');
        console.error(
          `[tired-agent] Port ${cfg.port} is still in use after retry. ` +
            `Check the listener with: lsof -nP -iTCP:${cfg.port} -sTCP:LISTEN`,
        );
        await storage.close();
        process.exit(1);
      }
      log.info({ host: cfg.host, port: cfg.port }, 'tired-agent manager listening');
    } else {
      log.fatal({ err }, 'failed to bind port');
      await storage.close();
      process.exit(1);
    }
  }
}

main(process.argv).catch((err) => {
  log.fatal({ err }, 'unhandled startup error');
  process.exit(1);
});

/** Write the auto-generated token to the manager's .env file. */
async function persistToken(token: string): Promise<void> {
  try {
    const envPath = resolve(__dirname, '../.env');
    let existing = '';
    if (existsSync(envPath)) {
      existing = await readFile(envPath, 'utf-8');
    }
    const lines = existing.split('\n');
    const out: string[] = [];
    let found = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('CLSSW_MANAGER_TOKEN=')) {
        out.push(`CLSSW_MANAGER_TOKEN=${token}`);
        found = true;
      } else {
        out.push(line);
      }
    }
    if (!found) {
      out.push(`CLSSW_MANAGER_TOKEN=${token}`);
    }
    // Ensure parent directory exists before writing.
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(envPath, out.join('\n') + '\n', 'utf-8');
  } catch (err) {
    console.error('[tired-agent] Failed to persist token to .env:', (err as Error).message);
  }
}