/**
 * Structured logger with file output and 1 MB rotation.
 *
 * Usage:
 *   import { log, initLogger } from './util/log.js';
 *   initLogger({ logDir: '/path/to/logs', level: 'info' });
 *   log.info('started');
 *
 * The exported `log` is an ES-module live binding: once {@link initLogger}
 * is called, every module that imported `log` sees the new instance.
 *
 * Rotation scheme (checked every 60 s + at startup):
 *   agent.log  →  agent.1.log  →  agent.2.log  →  …  →  agent.5.log (deleted)
 */

import pino from 'pino';
import {
  mkdirSync,
  statSync,
  renameSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface LoggerConfig {
  /** Directory where log files are written.  If empty, logs to stderr. */
  logDir?: string;
  /** Log level (default: info). */
  level?: string;
}

// ─── Live binding ───────────────────────────────────────────────

/**
 * Module-level logger.  Starts as a silent stub; swapped by {@link initLogger}
 * once config is available.  Because ES module exports are live bindings,
 * every module that imported `log` will see the new instance after the swap.
 *
 * We use `pino({level:'silent'})` initially so the module is safe to import
 * before config is loaded (e.g. `--help` exits without calling initLogger).
 */
const _stub = pino({ level: 'silent' });

// eslint-disable-next-line prefer-const
export let log: pino.Logger = _stub;

// ─── Internal state ─────────────────────────────────────────────

const MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_BACKUPS = 5;
const ROTATE_INTERVAL_MS = 60_000;

let _rotateTimer: ReturnType<typeof setInterval> | null = null;
let _dest: pino.DestinationStream | null = null;

// ─── Initialisation ─────────────────────────────────────────────

/**
 * Initialise (or re-initialise) the logger.
 *
 * Call once at startup after the config is loaded and before any
 * application log lines are emitted.
 */
export function initLogger(cfg: LoggerConfig): void {
  if (_rotateTimer) {
    clearInterval(_rotateTimer);
    _rotateTimer = null;
  }

  const level = cfg.level ?? 'info';

  if (cfg.logDir) {
    mkdirSync(cfg.logDir, { recursive: true });
    rotateLogs(cfg.logDir);
    _dest = pino.destination({ dest: join(cfg.logDir, 'agent.log'), sync: false });
    log = pino({ level }, _dest);

    // Periodic rotation check.
    _rotateTimer = setInterval(() => {
      try {
        if (needsRotation(cfg.logDir!)) {
          rotateLogs(cfg.logDir!);
          (_dest as pino.DestinationStream & { reopen?: () => void })?.reopen?.();
        }
      } catch {
        // Best-effort — safe to ignore.
      }
    }, ROTATE_INTERVAL_MS);
    _rotateTimer.unref();
  } else {
    _dest = null;
    log = pino({ level });
  }
}

// ─── Rotation helpers ───────────────────────────────────────────

function needsRotation(logDir: string): boolean {
  const logPath = join(logDir, 'agent.log');
  return existsSync(logPath) && statSync(logPath).size > MAX_FILE_SIZE;
}

function rotateLogs(logDir: string): void {
  const logPath = join(logDir, 'agent.log');
  if (!existsSync(logPath)) return;
  if (statSync(logPath).size <= MAX_FILE_SIZE) return;

  const last = join(logDir, `agent.${MAX_BACKUPS}.log`);
  if (existsSync(last)) unlinkSync(last);
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const src = join(logDir, `agent.${i}.log`);
    const dst = join(logDir, `agent.${i + 1}.log`);
    if (existsSync(src)) renameSync(src, dst);
  }
  renameSync(logPath, join(logDir, 'agent.1.log'));
}
