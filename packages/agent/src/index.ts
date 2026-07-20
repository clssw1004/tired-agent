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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  // Register global error handlers FIRST so nothing during startup can crash
  // the process unobserved. Strategy: log, do not exit — a daemon should stay
  // up through transient faults (disk full, DB lock, subscriber callback errors).
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: String(reason) }, 'unhandledRejection');
  });

  // Ensure the data directory exists before any file operations (logs,
  // credentials, .env, SQLite DB). This is idempotent — safe on every start.
  await mkdir(cfg.dataDir, { recursive: true });

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
    cfg.token = generated;
  }

  // Persist effective config to ~/.tiredagent/.env so user can see and
  // override defaults. Token always written (fresh or existing).
  await persistEffectiveConfig(cfg);

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
 * Persist the agent's effective config to ~/.tiredagent/.env so the
 * user can see and override every setting. Writes a complete .env with
 * all resolved defaults — missing keys are added, existing ones updated
 * only if they differ from hard-coded defaults (user-pinned values are
 * preserved).
 */
async function persistEffectiveConfig(cfg: ServerConfig): Promise<void> {
  const envPath = join(cfg.dataDir, '.env');
  const defaults: Record<string, string> = {
    CLSSW_TOKEN: cfg.token,
    CLSSW_AGENT_NAME: cfg.name,
    CLSSW_DATA: cfg.dataDir,
    CLSSW_LOG_LEVEL: cfg.logLevel,
    CLSSW_SSE_FORMAT: cfg.sseFormat,
    PORT: String(cfg.port),
    HOST: cfg.host,
  };
  try {
    await mkdir(cfg.dataDir, { recursive: true });
    let existing = '';
    if (existsSync(envPath)) {
      existing = await readFile(envPath, 'utf-8');
    }
    const lines = existing.split('\n');
    const seen = new Set<string>();
    const out: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        out.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        out.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIdx);
      seen.add(key);
      // Keep user's value only if it's not a default we want to sync.
      if (key in defaults) {
        out.push(`${key}=${defaults[key]}`);
      } else {
        out.push(line);
      }
    }

    // Append missing keys.
    for (const [key, val] of Object.entries(defaults)) {
      if (!seen.has(key)) {
        out.push(`${key}=${val}`);
      }
    }

    await writeFile(envPath, out.join('\n') + '\n', 'utf-8');
    log.debug({ envPath }, 'persisted effective config');
  } catch (err) {
    log.warn({ err }, 'failed to persist effective config');
  }
}
