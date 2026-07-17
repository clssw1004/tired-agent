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
  /** If true, allow any origin via CORS (development convenience). */
  permissiveCors: boolean;
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
      case '--permissive-cors':
        out.permissiveCors = true;
        break;
    }
  }
  return out;
}

export function loadConfig(argv: string[]): ServerConfig {
  const cli = parseArgs(argv);
  const env = process.env;
  return {
    port: cli.port ?? parseInt10(env.PORT, 8443),
    host: cli.host ?? env.HOST ?? '127.0.0.1',
    token: cli.token ?? env.CLSSW_TOKEN ?? '',
    dataDir: cli.dataDir ?? resolve(env.CLSSW_DATA ?? './data'),
    permissiveCors: cli.permissiveCors ?? env.CLSSW_PERMISSIVE_CORS === '1',
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
