#!/usr/bin/env node

/**
 * CLI entry point for tired-agent.
 *
 * Provides the `tired-agent` command with subcommands and options:
 *
 *   tired-agent start [options]      启动 agent 守护进程
 *   tired-agent register <base64>    注册到 Manager 后退出
 *   tired-agent --version            版本号
 *   tired-agent --help               帮助
 *
 * All options can also be set via environment variables (see --help output).
 */

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import { readFileSync } from 'node:fs';

// Load .env from package root.
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

import { main } from './index.js';
import { type ServerConfig } from './config.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
);

async function run() {
  const program = new Command();

  program
    .name('tired-agent')
    .description('tired-agent — PTY session executor. Run interactive CLI tools remotely.')
    .version(pkg.version ?? '0.0.0');

  // ── start ─────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start the agent daemon')
    .option('-p, --port <port>', `Port to listen on (env: PORT, default ${process.env['PORT'] ?? 8444})`, String(process.env['PORT'] ?? 8444))
    .option('-H, --host <address>', `Host to bind to (env: HOST, default ${process.env['HOST'] ?? '127.0.0.1'})`, process.env['HOST'] ?? '127.0.0.1')
    .option('-t, --token <token>', 'Bearer token for incoming auth (env: CLSSW_TOKEN)')
    .option('-d, --data-dir <path>', `Data directory (env: CLSSW_DATA, default ./data)`, process.env['CLSSW_DATA'] ?? './data')
    .option('-n, --name <name>', 'Agent name for Manager registration (env: CLSSW_AGENT_NAME)', process.env['CLSSW_AGENT_NAME'] ?? '')
    .option('--register <string>', 'Base64-encoded Manager registration string (env: CLSSW_REGISTER)', process.env['CLSSW_REGISTER'] ?? '')
    .option('--sse-format <format>', 'SSE data format: base64 | hex', process.env['CLSSW_SSE_FORMAT'] ?? 'base64')
    .option('--sse-debug', 'Enable SSE hex dump logging', process.env['CLSSW_DEBUG_SSE'] === '1')
    .action(async (opts) => {
      const cfg: ServerConfig = {
        port: Number(opts.port),
        host: opts.host,
        token: opts.token ?? process.env['CLSSW_TOKEN'] ?? '',
        dataDir: opts.dataDir,
        sseFormat: opts.sseFormat === 'hex' ? 'hex' : 'base64',
        sseDebugLog: !!opts.sseDebug,
        name: opts.name,
        registerString: opts.register || null,
      };
      await main(cfg);
    });

  // ── register ──────────────────────────────────────────────────
  program
    .command('register <base64>')
    .description('Register with a Manager using a base64-encoded connection string, then exit')
    .action(async (base64: string) => {
      const { decodeRegisterString, registerWithManager } = await import('./register.js');

      const payload = decodeRegisterString(base64);
      // Derive agent URL from sensible defaults.
      const host = process.env['HOST'] ?? '127.0.0.1';
      const port = process.env['PORT'] ?? '8444';
      const agentBaseUrl = `http://${host}:${port}`;

      const creds = await registerWithManager(
        payload.managerUrl,
        payload.agentName,
        payload.registerSecret,
        agentBaseUrl,
      );
      console.log(JSON.stringify(creds, null, 2));
    });

  await program.parseAsync(process.argv);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ─── Helper: env var with fallback ──────────────────────────────

function envString(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}
