/**
 * Server configuration — sourced from CLI args and environment variables.
 * CLI args take precedence over env vars; defaults are documented inline.
 */

import { resolve } from 'node:path';

export interface ServerConfig {
  /** Port to listen on. */
  port: number;
  /** Host to bind to. Default 127.0.0.1 (loopback only). Override for LAN use. */
  host: string;
  /** Bearer token required on every request. */
  token: string;
  /** Directory where SQLite DB and PTY log files are stored. */
  dataDir: string;
  /**
   * CORS strategy. Resolved from CLSSW_STRICT_CORS / CORS_ORIGIN /
   * CLSSW_PERMISSIVE_CORS. See index.ts for the exact precedence.
   *
   *   'off'         → no CORS middleware (use when the SPA is served from
   *                   the same origin as /v1/*, typically via nginx).
   *   'allowlist'   → only the comma-separated origins in `corsOrigins`.
   *   'wildcard'    → echo back whatever the browser asks for (ReflectOrPermit).
   */
  corsMode: 'off' | 'allowlist' | 'wildcard';
  /** Origins to allow when corsMode === 'allowlist'. */
  corsOrigins: string[];
  /** Encoding used in the SSE `data:` payloads for output chunks. */
  sseFormat: 'base64' | 'hex';
  /** When true, server logs a hex+ASCII dump of every input/output byte
   *  stream to its own pino log — intended for local debugging only. */
  sseDebugLog: boolean;
}

function parseInt10(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv: string[]): Partial<ServerConfig> {
  const out: Partial<ServerConfig> = {};
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
    }
  }
  return out;
}

/** Split a comma-separated origin list, trimming whitespace, dropping empties. */
function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

export function loadConfig(argv: string[]): ServerConfig {
  const cli = parseArgs(argv);
  const env = process.env;

  // CORS resolution (highest precedence first):
  //   CLSSW_STRICT_CORS=1   → off      (same-origin via reverse proxy)
  //   CORS_ORIGIN=…         → allowlist of those origins
  //   CLSSW_PERMISSIVE_CORS=1 or unset → wildcard
  let corsMode: ServerConfig['corsMode'];
  let corsOrigins: string[];
  if (env['CLSSW_STRICT_CORS'] === '1') {
    corsMode = 'off';
    corsOrigins = [];
  } else if (env['CORS_ORIGIN']) {
    corsMode = 'allowlist';
    corsOrigins = parseOrigins(env['CORS_ORIGIN']);
  } else {
    corsMode = 'wildcard';
    corsOrigins = [];
  }

  return {
    port: cli.port ?? parseInt10(env.PORT, 8443),
    host: cli.host ?? env.HOST ?? '127.0.0.1',
    token: cli.token ?? env.CLSSW_TOKEN ?? '',
    dataDir: cli.dataDir ?? resolve(env.CLSSW_DATA ?? './data'),
    corsMode,
    corsOrigins,
    sseFormat: env['CLSSW_SSE_FORMAT'] === 'hex' ? 'hex' : 'base64',
    sseDebugLog: env['CLSSW_DEBUG_SSE'] === '1',
  };
}

/**
 * Throw a clear error if the configuration is unusable.
 * Called once during startup.
 */
export function validateConfig(cfg: ServerConfig): void {
  if (!cfg.token || cfg.token.length < 8) {
    throw new Error(
      'Refusing to start: --token (or CLSSW_TOKEN) must be at least 8 chars. ' +
        'Generate one with `openssl rand -hex 16`.',
    );
  }
  if (cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`Refusing to start: invalid port ${cfg.port}`);
  }
}
