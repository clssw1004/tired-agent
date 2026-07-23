/**
 * Manager configuration — sourced from CLI args and environment variables.
 *
 * CLI args take precedence over env vars; defaults are documented inline.
 *
 * Unlike the server (which has the agent's PTY token), the manager's token
 * is an *admin* secret: presenting it lets the holder mint a session token
 * via /v1/manager/auth/login and then CRUD the agent registry.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor default paths to the manager package root (not CWD) so the
// daemon finds the SPA regardless of where it was launched from.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, '..');

/**
 * Default TTLs. Overridable via CLI / env so operators can tune the
 * session/refresh window without rebuilding.
 *
 * Both mobile and web clients receive the absolute `sessionExpiresIn` /
 * `refreshExpiresIn` in the login response so they don't bake constants.
 */
export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ManagerConfig {
  /** Port to listen on. */
  port: number;
  /** Host to bind on. Default 127.0.0.1 (loopback only). Override for LAN use. */
  host: string;
  /** Admin token required to log in. */
  token: string;
  /** Directory where the manager's SQLite DB lives. */
  dataDir: string;
  /** Filesystem path to the built SPA. */
  webDistPath: string;
  /** CORS origin value for the Fastify cors plugin. */
  corsOrigin: string;
  /** sessionToken TTL (ms). Per RFC, short-lived (minutes to hours). */
  sessionTtlMs: number;
  /** refreshToken TTL (ms). Long-lived; sliding on use. */
  refreshTtlMs: number;
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv: string[]): Partial<ManagerConfig> {
  const out: Partial<ManagerConfig> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--port':
      case '-p':
        if (next) { out.port = parseInt10(next, out.port ?? 8443); i++; }
        break;
      case '--host':
      case '-h':
        if (next) { out.host = next; i++; }
        break;
      case '--token':
      case '-t':
        if (next) { out.token = next; i++; }
        break;
      case '--data':
      case '-d':
        if (next) { out.dataDir = resolve(next); i++; }
        break;
      case '--web-dist':
      case '-w':
        if (next) { out.webDistPath = resolve(next); i++; }
        break;
      case '--cors-origin':
        if (next) { out.corsOrigin = next; i++; }
        break;
      case '--session-ttl-ms':
        if (next) { out.sessionTtlMs = parseInt10(next, DEFAULT_SESSION_TTL_MS); i++; }
        break;
      case '--refresh-ttl-ms':
        if (next) { out.refreshTtlMs = parseInt10(next, DEFAULT_REFRESH_TTL_MS); i++; }
        break;
    }
  }
  return out;
}

export function loadConfig(argv: string[]): ManagerConfig {
  const cli = parseArgs(argv);
  const env = process.env;

  return {
    port: cli.port ?? parseInt10(env.CLSSW_MANAGER_PORT, 8443),
    host: cli.host ?? env.CLSSW_MANAGER_HOST ?? '127.0.0.1',
    token: cli.token ?? env.CLSSW_MANAGER_TOKEN ?? '',
    dataDir: cli.dataDir ?? resolve(env.CLSSW_MANAGER_DATA ?? './data'),
    webDistPath:
      cli.webDistPath ?? resolve(env.CLSSW_MANAGER_WEB_DIST ?? resolve(PACKAGE_ROOT, '../web/dist')),
    corsOrigin: cli.corsOrigin ?? env.CORS_ORIGIN ?? '*',
    sessionTtlMs:
      cli.sessionTtlMs ??
      parseInt10(env.CLSSW_MANAGER_SESSION_TTL_MS, DEFAULT_SESSION_TTL_MS),
    refreshTtlMs:
      cli.refreshTtlMs ??
      parseInt10(env.CLSSW_MANAGER_REFRESH_TTL_MS, DEFAULT_REFRESH_TTL_MS),
  };
}

/**
 * Throw a clear error if the configuration is unusable.
 * Called once during startup.
 */
export function validateConfig(cfg: ManagerConfig): void {
  if (!cfg.token || cfg.token.length < 8) {
    throw new Error(
      'Refusing to start: --token (or CLSSW_MANAGER_TOKEN) must be at least 8 chars. ' +
        'Generate one with `openssl rand -hex 16`.',
    );
  }
  if (cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`Refusing to start: invalid port ${cfg.port}`);
  }
  if (cfg.sessionTtlMs < 60 * 1000) {
    throw new Error(`Refusing to start: --session-ttl-ms must be ≥ 60000 (1 minute)`);
  }
  if (cfg.refreshTtlMs < cfg.sessionTtlMs) {
    throw new Error(
      `Refusing to start: --refresh-ttl-ms (${cfg.refreshTtlMs}) must be ≥ sessionTtlMs (${cfg.sessionTtlMs})`,
    );
  }
}
