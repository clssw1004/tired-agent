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
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

// Load .env from package root (bundled defaults, lowest priority).
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, '../.env') });

// Load .env from the default data directory (user config).
// This runs after the package .env so user values override bundled defaults.
// dotenv does NOT override existing shell env vars, so shell env wins.
const userEnvPath = join(homedir(), '.tiredagent', '.env');
loadDotenv({ path: userEnvPath, override: true });

import { main } from './index.js';
import { type ServerConfig } from './config.js';

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
);

const DEFAULT_DATA_DIR = join(homedir(), '.tiredagent');

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
    .option('-H, --host <address>', `Host to bind to (env: HOST, default 127.0.0.1; or 0.0.0.0 when --register is set)`, process.env['HOST'] ?? '')
    .option('-t, --token <token>', 'Bearer token for incoming auth (env: CLSSW_TOKEN)')
    .option('-d, --data-dir <path>', `Data directory (env: CLSSW_DATA, default ~/.tiredagent)`, process.env['CLSSW_DATA'] ?? DEFAULT_DATA_DIR)
    .option('-n, --name <name>', 'Agent name for Manager registration (env: CLSSW_AGENT_NAME, default: hostname)', process.env['CLSSW_AGENT_NAME'] ?? '')
    .option('--register <string>', 'Base64-encoded Manager registration string (env: CLSSW_REGISTER)', process.env['CLSSW_REGISTER'] ?? '')
    .option('--log-level <level>', `Log level (env: CLSSW_LOG_LEVEL, default info)`, process.env['CLSSW_LOG_LEVEL'] ?? 'info')
    .option('--sse-format <format>', 'SSE data format: base64 | hex', process.env['CLSSW_SSE_FORMAT'] ?? 'base64')
    .option('--sse-debug', 'Enable SSE hex dump logging', process.env['CLSSW_DEBUG_SSE'] === '1')
    .option('-D, --daemon', 'Run in background (detach from terminal)')
    .action(async (opts) => {
      // ── Daemon mode: fork a detached child and exit ───────────
      if (opts.daemon) {
        // Rebuild args without `--daemon` so the child runs in foreground.
        const args = process.argv
          .slice(2)
          .filter((a) => a !== '--daemon' && a !== '-D');
        const { execSync } = await import('node:child_process');
        const cmd =
          process.platform === 'win32'
            ? `start /B "" "${process.execPath}" "${process.argv[1]}" ${args.join(' ')}`
            : `nohup "${process.execPath}" "${process.argv[1]}" ${args.join(' ')} >/dev/null 2>&1 &`;
        try {
          execSync(cmd, { stdio: 'ignore' });
          console.log(`Agent started in background (PID written to ${join(opts.dataDir, 'agent.pid')}).`);
        } catch (err) {
          console.error('Failed to start daemon:', (err as Error).message);
          process.exit(1);
        }
        process.exit(0);
      }

      const registerString = opts.register || null;
      const host = opts.host || (registerString ? '0.0.0.0' : '127.0.0.1');
      const cfg: ServerConfig = {
        port: Number(opts.port),
        host,
        token: opts.token ?? process.env['CLSSW_TOKEN'] ?? '',
        dataDir: opts.dataDir,
        logDir: join(opts.dataDir, 'logs'),
        logLevel: opts.logLevel,
        sseFormat: opts.sseFormat === 'hex' ? 'hex' : 'base64',
        sseDebugLog: !!opts.sseDebug,
        name: opts.name || hostname(),
        registerString,
      };
      // Ensure the data directory exists before writing PID file or starting.
      mkdirSync(opts.dataDir, { recursive: true });
      writeFileSync(join(opts.dataDir, 'agent.pid'), String(process.pid), 'utf-8');
      await main(cfg);
    });

  // ── register ──────────────────────────────────────────────────
  program
    .command('register <base64>')
    .description('Register with a Manager using a base64-encoded connection string, then exit')
    .option('-d, --data-dir <path>', `Data directory (default ~/.tiredagent)`, process.env['CLSSW_DATA'] ?? DEFAULT_DATA_DIR)
    .action(async (base64: string, opts) => {
      const { decodeRegisterString, registerWithManager, loadCredentials, saveCredentials } = await import('./register.js');
      const { randomUUID } = await import('node:crypto');

      const payload = decodeRegisterString(base64);
      // Default to 0.0.0.0 (auto-detect LAN IP) unless user explicitly sets HOST.
      const { detectLanIp } = await import('./register.js');
      const rawHost = process.env['HOST'];
      const host = rawHost && rawHost !== '0.0.0.0' ? rawHost : detectLanIp();
      const port = process.env['PORT'] ?? '8444';
      const agentBaseUrl = `http://${host}:${port}`;

      const saved = await loadCredentials(opts.dataDir);
      const agentKey = saved?.agentKey ?? randomUUID();
      const result = await registerWithManager(
        payload.managerUrl,
        hostname(),
        agentBaseUrl,
        agentKey,
      );
      await saveCredentials(opts.dataDir, { agentKey, id: result.id, token: result.token });
      console.log(`Registered with Manager at ${payload.managerUrl}`);
      console.log(`  Agent ID:  ${result.id}`);
      console.log(`  Token:     ${result.token.slice(0, 4)}****`);
      console.log(`  Agent key: ${agentKey}`);
      console.log(`Credentials saved to ${join(opts.dataDir, '.agent-credentials')}`);
    });

  // ── stop ──────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Stop the running agent daemon')
    .option('-d, --data-dir <path>', `Data directory (default ~/.tiredagent)`, process.env['CLSSW_DATA'] ?? DEFAULT_DATA_DIR)
    .action(async (opts) => {
      const pidFile = join(opts.dataDir, 'agent.pid');
      let pid: number;
      try {
        pid = Number(readFileSync(pidFile, 'utf-8').trim());
      } catch {
        console.error('Agent does not appear to be running (no PID file)');
        console.log('If the agent is running, kill it manually and remove the .env HOST=127.0.0.1 restriction.');
        process.exit(1);
      }
      try {
        // Windows: taskkill. Unix: SIGTERM.
        const cmd = process.platform === 'win32'
          ? `taskkill /F /PID ${pid}`
          : `kill ${pid}`;
        const { execSync } = await import('node:child_process');
        execSync(cmd, { stdio: 'ignore' });
        unlinkSync(pidFile);
        console.log(`Agent (PID ${pid}) stopped.`);
      } catch {
        console.error(`Failed to stop agent (PID ${pid}). Try: taskkill /F /PID ${pid}`);
        process.exit(1);
      }
    });

  // ── restart ───────────────────────────────────────────────────
  program
    .command('restart')
    .description('Restart the running agent daemon')
    .option('-d, --data-dir <path>', `Data directory (default ~/.tiredagent)`, process.env['CLSSW_DATA'] ?? DEFAULT_DATA_DIR)
    .action(async (opts) => {
      const pidFile = join(opts.dataDir, 'agent.pid');
      let pid: number | null = null;
      try {
        pid = Number(readFileSync(pidFile, 'utf-8').trim());
      } catch { /* not running */ }

      if (pid) {
        console.log(`Stopping agent (PID ${pid})…`);
        const cmd = process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill ${pid}`;
        const { execSync } = await import('node:child_process');
        try { execSync(cmd, { stdio: 'ignore' }); } catch { /* ok */ }
        try { unlinkSync(pidFile); } catch { /* ok */ }
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Re-launch with `cmd /c start /B` on Windows (detached), or
      // `nohup` on Unix.  Re-use this same script + args + `start`.
      const args = process.argv
        .slice(2)
        .filter((a) => a !== 'restart')
        .join(' ');
      const { execSync } = await import('node:child_process');
      const nodeBin = process.execPath;
      const script = process.argv[1];
      const launchCmd =
        process.platform === 'win32'
          ? `start /B "" "${nodeBin}" "${script}" ${args} start`
          : `nohup "${nodeBin}" "${script}" ${args} start >/dev/null 2>&1 &`;
      execSync(launchCmd, { stdio: 'ignore' });
      console.log('Agent restarted.');
      process.exit(0);
    });

  // ── status ────────────────────────────────────────────────────
  program
    .command('status')
    .description('Show agent status — running, registered, config')
    .option('-d, --data-dir <path>', `Data directory (default ~/.tiredagent)`, process.env['CLSSW_DATA'] ?? DEFAULT_DATA_DIR)
    .action(async (opts) => {
      const { loadCredentials } = await import('./register.js');
      const creds = await loadCredentials(opts.dataDir);

      console.log(`Data dir:   ${opts.dataDir}`);
      console.log(`Registered: ${creds ? 'yes' : 'no'}`);
      if (creds) {
        console.log(`  Agent ID:  ${creds.id}`);
        console.log(`  Token:     ${creds.token.slice(0, 4)}****`);
        console.log(`  Agent key: ${creds.agentKey}`);
      }

      // Check if daemon is listening (configurable port from .env or default).
      const envPath = join(opts.dataDir, '.env');
      let agentPort = '8444';
      let agentHost = '127.0.0.1';
      try {
        const dotenv = readFileSync(envPath, 'utf-8');
        const portMatch = dotenv.match(/^PORT=(.+)$/m);
        if (portMatch?.[1]) agentPort = portMatch[1].trim();
        const hostMatch = dotenv.match(/^HOST=(.+)$/m);
        if (hostMatch?.[1]) agentHost = hostMatch[1].trim();
      } catch { /* .env doesn't exist yet */ }

      const healthUrl = `http://${agentHost}:${agentPort}/health`;
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        const json = (await res.json()) as Record<string, unknown>;
        const ts = Number(json.ts ?? 0);
        const uptime = ts ? Math.floor((Date.now() - ts) / 1000) : 0;
        console.log(`Running:    yes — ${healthUrl}`);
        console.log(`  Uptime:   ${uptime}s`);
        if (json.name) console.log(`  Name:    ${json.name}`);
      } catch {
        console.log(`Running:    no`);
      }
    });

  await program.parseAsync(process.argv);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
