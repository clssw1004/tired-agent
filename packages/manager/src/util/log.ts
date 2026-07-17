/**
 * Structured logger for tired-pc manager.
 *
 * Mirrors the server package's log module so the two daemons have a
 * consistent on-the-wire log shape when read together.
 */

import pino from 'pino';

// Write logs to stderr so stdout stays clean for HTTP responses.
// 2 = stderr file descriptor.
const dest = pino.destination({ dest: 2, sync: false });

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'tired-pc-manager' },
}, dest);