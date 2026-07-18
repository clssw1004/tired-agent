/**
 * tired-agent agent daemon — PTY executor entry point.
 *
 * Exports {@link main} for programmatic use. Also runs as a standalone
 * entry (from `node dist/index.js` or `npm start`) — in that case it
 * parses argv with the embedded CLI.
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Load .env when invoked directly (e.g. `node dist/index.js`).
// When invoked via cli.ts, dotenv is already loaded — this is harmless.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });
// Also load user's .env from the default data directory.
loadDotenv({ path: join(homedir(), '.tiredagent', '.env'), override: true });

import { loadConfig, validateConfig } from './config.js';
import type { ServerConfig } from './config.js';
import { createStorage } from './session/storage.js';
import { SessionManager } from './session/manager.js';
import { createApp } from './app.js';
import { registerShutdown } from './shutdown.js';
import { log, initLogger } from './util/log.js';
import { getOrRegisterCredentials } from './register.js';
import type { StorageKind } from './session/storage.js';

/** Start the agent with a fully resolved config. */
export async function main(cfg: ServerConfig) {
  // Initialise the logger from config (file + rotation in daemon mode).
  initLogger({ logDir: cfg.logDir, level: cfg.logLevel });

  // First-pass validation: only fail on structural issues (port range).
  // Token length is re-checked after registration / credential load.
  if (cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`Refusing to start: invalid port ${cfg.port}`);
  }

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

  // Re-validate now that the token may have been populated.
  // If still missing (no register, no saved creds, no --token), auto-
  // generate one and persist it to ~/.tiredagent/.env so subsequent
  // restarts are stable.
  if (!cfg.token || cfg.token.length < 8) {
    const generated = randomBytes(16).toString('hex');
    log.warn('No --token / CLSSW_TOKEN provided; auto-generating one.');
    log.warn({ tokenHint: generated.slice(0, 4) + '****' },
      'Save this token — printed once. Set CLSSW_TOKEN=<value> in ~/.tiredagent/.env to pin it.');
    await persistAutoToken(cfg.dataDir, generated);
    cfg.token = generated;
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
// Guard: only run when invoked directly (not when imported by cli.ts).
const _isMain = !process.argv[1]?.includes('cli');
if (_isMain) {
  const _cfg = loadConfig(process.argv);
  main(_cfg).catch((err) => {
    log.fatal({ err }, 'unhandled startup error');
    process.exit(1);
  });
}

/**
 * Persist an auto-generated token to ~/.tiredagent/.env so subsequent
 * restarts are stable. Adds or replaces the `CLSSW_TOKEN=…` line.
 */
async function persistAutoToken(dataDir: string, token: string): Promise<void> {
  const envPath = join(dataDir, '.env');
  const line = `CLSSW_TOKEN=${token}\n`;
  try {
    await mkdir(dataDir, { recursive: true });
    let existing = '';
    if (existsSync(envPath)) {
      existing = await readFile(envPath, 'utf-8');
    }
    // Replace existing CLSSW_TOKEN line, or append.
    if (/^CLSSW_TOKEN=.*$/m.test(existing)) {
      existing = existing.replace(/^CLSSW_TOKEN=.*$/m, `CLSSW_TOKEN=${token}`);
      await writeFile(envPath, existing, 'utf-8');
    } else {
      await appendFile(envPath, line, 'utf-8');
    }
  } catch (err) {
    log.warn({ err }, 'failed to persist auto-generated token');
  }
}
