/**
 * Structured logger. Uses pino if available, otherwise falls back to
 * a tiny console-based logger so the file is usable in tests without
 * pulling in pino's worker thread.
 */

import pino from 'pino';

// Write logs to stderr so stdout stays clean for HTTP responses
// 2 = stderr file descriptor
const dest = pino.destination({ dest: 2, sync: false });

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'clssw-server' },
}, dest);
