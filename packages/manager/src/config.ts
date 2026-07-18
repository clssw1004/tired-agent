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

export interface ManagerConfig {
  /** Port to listen on. */
  port: number;
  /** Host to bind to. Default 127.0.0.1 (loopback only). Override for LAN use. */
  host: string;
  /** Admin token required to log in. */
  token: string;
  /** Directory where the manager's SQLite DB lives. */
  dataDir: string;
  /** Filesystem path to the built SPA. */
  webDistPath: string;
  /** CORS origin value for the Fastify cors plugin. */
  corsOrigin: string;
  /** Shared secret for agent auto-registration. Empty string = disabled. */
  registerSecret: string;
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
    registerSecret: env.CLSSW_MANAGER_REGISTER_SECRET ?? '',
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
}