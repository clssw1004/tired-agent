/**
 * Cross-platform process / port helpers used by the CLI lifecycle
 * (`start` / `stop` / `restart`) and the daemon entry point.
 *
 * Everything is designed so unit tests can inject fake dependencies
 * (PID reader, liveness probe, port probe) — tests never touch real
 * ports, real PIDs, or a running agent.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const execFileAsync = promisify(execFile);

// ─── Entry-point detection ───────────────────────────────────────

/**
 * Whether a module is the directly-invoked entry point.
 *
 * `moduleUrl` should be `import.meta.url` of the module making the check;
 * `argv1` should be `process.argv[1]`. Paths are compared after resolving
 * symlinks so that npm bin symlinks (which do NOT contain the script name,
 * e.g. `.../bin/tired-agent`) correctly resolve to `cli.js` — the old
 * `process.argv[1]?.includes('cli')` heuristic wrongly treated those as a
 * direct entry, running `main()` twice and fighting over the port.
 */
export function isDirectEntry(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  const selfPath = fileURLToPath(moduleUrl);
  try {
    return realpathSync(argv1) === selfPath;
  } catch {
    return resolve(argv1) === selfPath;
  }
}

// ─── PID file ────────────────────────────────────────────────────

/** Path to the agent PID file inside a data directory. */
export function pidFilePath(dataDir: string): string {
  return join(dataDir, 'agent.pid');
}

/**
 * Read the PID file. Returns `null` when the file is missing or does
 * not contain a valid positive integer (e.g. a stale/corrupt file).
 */
export function readPidFile(dataDir: string): number | null {
  const file = pidFilePath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ─── Process liveness ────────────────────────────────────────────

/**
 * Check whether a PID refers to a live process.
 *
 * Uses `process.kill(pid, 0)` which never sends a signal — it only
 * probes for existence. `EPERM` means the process exists but belongs
 * to another user.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort signal delivery. Returns false if the PID is gone/unreachable. */
export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

// ─── Wait / terminate ────────────────────────────────────────────

export interface WaitOptions {
  pollIntervalMs?: number;
}

/**
 * Poll until the process exits or `timeoutMs` elapses.
 * Returns true only once the process is confirmed gone.
 */
export async function waitForProcessExit(
  pid: number,
  isAlive: (pid: number) => boolean,
  timeoutMs: number,
  options: WaitOptions = {},
): Promise<boolean> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return !isAlive(pid);
}

export interface TerminateOptions {
  /** First signal to send. Default `SIGTERM` (graceful). */
  signal?: NodeJS.Signals;
  /** How long to wait for a graceful exit before escalating to `SIGKILL`. */
  timeoutMs?: number;
  /** Injectable liveness probe (defaults to {@link isProcessAlive}). */
  isAlive?: (pid: number) => boolean;
}

export interface TerminateResult {
  /** True once the process is confirmed gone. */
  exited: boolean;
  /** True if a `SIGKILL` escalation was required. */
  killed: boolean;
}

/**
 * Gracefully terminate a process: send `SIGTERM`, wait up to
 * `timeoutMs`, then escalate to `SIGKILL`. Works on Windows too —
 * Node maps both signals to forced termination there.
 */
export async function terminateProcess(
  pid: number,
  options: TerminateOptions = {},
): Promise<TerminateResult> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const timeoutMs = options.timeoutMs ?? 5000;
  const signal = options.signal ?? 'SIGTERM';

  if (!isAlive(pid)) return { exited: true, killed: false };

  signalProcess(pid, signal);
  if (await waitForProcessExit(pid, isAlive, timeoutMs)) {
    return { exited: true, killed: false };
  }

  signalProcess(pid, 'SIGKILL');
  const exited = await waitForProcessExit(pid, isAlive, timeoutMs);
  return { exited, killed: true };
}

// ─── Port probing ────────────────────────────────────────────────

/**
 * Probe whether something is accepting connections on `host:port`.
 * Returns false on timeout, ECONNREFUSED, or any other failure.
 */
export function isPortListening(
  host: string,
  port: number,
  timeoutMs = 800,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(value: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// ─── Start pre-flight guard ──────────────────────────────────────

export type StartGuardResult =
  | { ok: true; stalePid: null }
  | { ok: true; stalePid: number; staleReason: 'DEAD_PROCESS' | 'NOT_LISTENING' }
  | { ok: false; reason: 'ALREADY_RUNNING'; pid: number; host: string; port: number };

export interface StartGuardDeps {
  readPid?: (dataDir: string) => number | null;
  isAlive?: (pid: number) => boolean;
  isListening?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  probeTimeoutMs?: number;
}

/**
 * Decide whether a fresh `start` is safe to run.
 *
 * - No PID file            → ok.
 * - PID file, dead process → ok, report stale PID.
 * - PID file, live process → probe the port: if something listens,
 *   refuse (an agent is already running); otherwise report a stale
 *   PID whose process is alive but not bound to our port.
 *
 * Kept as a pure decision function so the CLI can format the user
 * message while tests exercise every branch with fakes.
 */
export async function checkAgentStartGuard(
  dataDir: string,
  host: string,
  port: number,
  deps: StartGuardDeps = {},
): Promise<StartGuardResult> {
  const readPid = deps.readPid ?? readPidFile;
  const isAlive = deps.isAlive ?? isProcessAlive;
  const isListening = deps.isListening ?? isPortListening;
  const probeTimeoutMs = deps.probeTimeoutMs ?? 800;

  const pid = readPid(dataDir);
  if (pid === null) return { ok: true, stalePid: null };
  if (!isAlive(pid)) return { ok: true, stalePid: pid, staleReason: 'DEAD_PROCESS' };

  const listening = await isListening(host, port, probeTimeoutMs);
  if (listening) {
    return { ok: false, reason: 'ALREADY_RUNNING', pid, host, port };
  }
  return { ok: true, stalePid: pid, staleReason: 'NOT_LISTENING' };
}

// ─── Port occupant diagnostics ───────────────────────────────────

/**
 * Best-effort summary of what is listening on `port`, using the
 * platform's own tooling (netstat on Windows, lsof on macOS, ss on
 * Linux). Returns null when the tool is missing or parsing fails.
 */
export async function findPortOccupant(port: number): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return parseNetstatPort(stdout, port);
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('lsof', [
        '-nP',
        `-iTCP:${port}`,
        '-sTCP:LISTEN',
      ]);
      return parseLsofPort(stdout, port);
    }
    const { stdout } = await execFileAsync('ss', ['-ltnp', `sport = :${port}`], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseSsPort(stdout, port);
  } catch {
    return null;
  }
}

/** Parse `netstat -ano` output for a listening socket on `port`. */
export function parseNetstatPort(stdout: string, port: number): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(
      /^\s*TCP\s+(\S+):(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i,
    );
    if (m && Number(m[2]) === port && /listen/i.test(m[4] ?? '')) {
      return `PID ${m[5]}`;
    }
  }
  return null;
}

/** Parse `lsof -iTCP:<port> -sTCP:LISTEN` output → "name (PID n)". */
export function parseLsofPort(stdout: string, port: number): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim() || /^\s*COMMAND\s+PID/i.test(line)) continue;
    if (!new RegExp(`:${port}\\b`).test(line)) continue;
    const cols = line.split(/\s+/);
    const cmd = cols[0];
    const pid = cols[1];
    if (cmd && pid && /^\d+$/.test(pid)) {
      return `${cmd} (PID ${pid})`;
    }
  }
  return null;
}

/** Parse `ss -ltnp` output → "name (PID n)". */
export function parseSsPort(stdout: string, port: number): string | null {
  const portRe = new RegExp(`:${port}(?:\\s|$)`);
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    if (!portRe.test(line)) continue;
    const m = line.match(/users:\s*\(\("([^"]+)",pid=(\d+)/);
    if (m) return `${m[1]} (PID ${m[2]})`;
  }
  return null;
}

// ─── User shell environment ──────────────────────────────────────

const SHELL_ENV_TTL_MS = 10_000;

let _shellEnvCache: { env: Record<string, string>; at: number } | null = null;

/**
 * Compute the user's login-shell environment (`bash -lc 'env'` with
 * `~/.bashrc` sourced) so session processes see a FRESH view of PATH
 * and other variables — not the daemon's startup snapshot. This way a
 * command installed (or a PATH entry added) after the agent started is
 * still found when spawning a session.
 *
 * Results are cached for a short TTL to avoid the ~100ms bash cost on
 * every spawn. Returns an empty object on Windows (no shell to query)
 * or when the shell invocation fails — callers fall back to
 * `process.env`.
 */
export function getLoginShellEnv(): Record<string, string> {
  if (process.platform === 'win32') return {};
  const now = Date.now();
  if (_shellEnvCache && now - _shellEnvCache.at < SHELL_ENV_TTL_MS) {
    return _shellEnvCache.env;
  }
  try {
    const out = execFileSync(
      'bash',
      ['-lc', 'source ~/.bashrc 2>/dev/null; env'],
      { timeout: 3000, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    );
    const env: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    _shellEnvCache = { env, at: now };
    return env;
  } catch {
    return {};
  }
}

/**
 * Build the environment for a spawned session process.
 *
 * The user's login-shell env wins over the daemon's snapshot (so
 * PATH/PATH entries updated after start are honoured), then explicit
 * per-session `extra` vars override everything. `NODE_OPTIONS` is
 * always stripped (it could inject flags into the child).
 */
export function buildSpawnEnv(
  processEnv: NodeJS.ProcessEnv,
  shellEnv: Record<string, string>,
  extra: Record<string, string> | null,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(processEnv)) {
    if (v != null && !(k in shellEnv)) base[k] = v;
  }
  for (const [k, v] of Object.entries(shellEnv)) {
    if (v != null) base[k] = v;
  }
  delete base['NODE_OPTIONS'];
  if (extra) Object.assign(base, extra);
  return base;
}
