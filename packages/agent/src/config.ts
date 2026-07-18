/**
 * Agent configuration — sourced from CLI args and environment variables.
 * CLI args take precedence over env vars; defaults are documented inline.
 */

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/** Default data directory: ~/.tiredagent */
const DEFAULT_DATA_DIR = join(homedir(), '.tiredagent');

export interface ServerConfig {
  /** Port to listen on. */
  port: number;
  /** Host to bind to. Default 127.0.0.1 (loopback only). Override for LAN use. */
  host: string;
  /** Bearer token required on every request. */
  token: string;
  /** Directory where SQLite DB and PTY log files are stored. */
  dataDir: string;
  /** Directory for log files (defaults to {dataDir}/logs). */
  logDir: string;
  /** Log level. Default info. */
  logLevel: string;
  /** Encoding used in the SSE `data:` payloads for output chunks. */
  sseFormat: 'base64' | 'hex';
  /** When true, logs a hex+ASCII dump of every input/output byte stream. */
  sseDebugLog: boolean;
  /** Agent name for manager registration. */
  name: string;
  /** Base64-encoded registration string for manager auto-registration. */
  registerString: string | null;
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
        if (next) { out.port = parseInt10(next, out.port ?? 8444); i++; }
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
      case '--name':
      case '-n':
        if (next) { out.name = next; i++; }
        break;
      case '--register':
        if (next) { out.registerString = next; i++; }
        break;
    }
  }
  return out;
}

export function loadConfig(argv: string[]): ServerConfig {
  const cli = parseArgs(argv);
  const env = process.env;

  const registerString = cli.registerString ?? env.CLSSW_REGISTER ?? null;

  // If registering with a remote Manager, default to 0.0.0.0 so the
  // Manager can reach us.  Otherwise keep the safe loopback default.
  const defaultHost = registerString ? '0.0.0.0' : '127.0.0.1';
  const dataDir = cli.dataDir ? resolve(cli.dataDir) : resolve(env.CLSSW_DATA ?? DEFAULT_DATA_DIR);

  return {
    port: cli.port ?? parseInt10(env.PORT, 8444),
    host: cli.host ?? env.HOST ?? defaultHost,
    token: cli.token ?? env.CLSSW_TOKEN ?? '',
    dataDir,
    logDir: resolve(env.CLSSW_LOG_DIR ?? join(dataDir, 'logs')),
    logLevel: env.CLSSW_LOG_LEVEL ?? 'info',
    sseFormat: env['CLSSW_SSE_FORMAT'] === 'hex' ? 'hex' : 'base64',
    sseDebugLog: env['CLSSW_DEBUG_SSE'] === '1',
    name: cli.name ?? env.CLSSW_AGENT_NAME ?? '',
    registerString,
  };
}

/** Throw a clear error if the configuration is unusable. */
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
