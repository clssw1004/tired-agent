/**
 * Auth routes — login / refresh / logout / me.
 *
 *   POST /manager/auth/login    → exchange admin token for paired
 *                                  (sessionToken, refreshToken)
 *   POST /manager/auth/refresh  → single-use sliding refresh; rotates
 *                                  both tokens and slides TTLs
 *   POST /manager/auth/logout   → invalidate current session (auth: bearer)
 *   GET  /manager/auth/me       → confirm session is valid (auth already
 *                                  enforced by registerAuth)
 *
 * Login & refresh are public; registerAuth skips them. Refresh is its own
 * public path because it authenticates with a different token (the refresh
 * token) — registerAuth's sessionToken check would otherwise 401 it.
 * The handler does its own validation against `findSessionByRefreshToken`.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../storage.js';
import type { ManagerConfig } from '../config.js';

const LoginSchema = z.object({
  token: z.string().min(1),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  storage: Storage,
  cfg: ManagerConfig,
): void {
  app.post('/manager/auth/login', async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.message },
      });
    }

    // Constant-time compare to avoid timing oracles on the admin token.
    const provided = parsed.data.token;
    const expected = cfg.token;
    if (!constantTimeEqual(provided, expected)) {
      return reply.code(401).send({
        error: { code: 'invalid_token', message: 'token mismatch' },
      });
    }

    const session = storage.createSession(cfg.sessionTtlMs, cfg.refreshTtlMs);
    return reply.code(200).send({
      sessionToken: session.token,
      refreshToken: session.refreshToken,
      sessionExpiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      refreshExpiresIn: Math.max(0, Math.floor((session.refreshExpiresAt - Date.now()) / 1000)),
    });
  });

  app.post('/manager/auth/refresh', async (req, reply) => {
    // Skip the global sessionToken hook (see comment on the export).
    const refreshToken = readBearerToken(req);
    if (!refreshToken) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'missing refresh token' },
      });
    }

    const session = storage.refreshSession(refreshToken, cfg.sessionTtlMs, cfg.refreshTtlMs);
    if (!session) {
      // Missing or single-use-spent or expired.
      return reply.code(401).send({
        error: { code: 'invalid_refresh', message: 'expired or used' },
      });
    }

    return reply.code(200).send({
      sessionToken: session.token,
      refreshToken: session.refreshToken,
      sessionExpiresIn: Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      refreshExpiresIn: Math.max(0, Math.floor((session.refreshExpiresAt - Date.now()) / 1000)),
    });
  });

  app.post('/manager/auth/logout', async (req, reply) => {
    // Auth is verified by registerAuth before we get here.
    const token = req.userToken;
    if (token) storage.deleteSession(token);
    return reply.code(200).send({ ok: true });
  });

  app.get('/manager/auth/me', async (req, reply) => {
    // No body needed — the fact that we reached this handler means the
    // session was just verified. Frontend uses this on startup to detect
    // a stale/invalid token.
    return reply.code(200).send({
      ok: true,
      sessionToken: req.userToken ?? null,
    });
  });
}

/**
 * Pull the bearer token out of `Authorization: Bearer <token>`.
 * Mirrors registerAuth's parsing so the refresh handler matches.
 *
 * NOT in a shared util to keep this file standalone — registerAuth may
 * still evolve independently (e.g. SSE query-string auth for refresh).
 */
function readBearerToken(req: FastifyRequest): string | null {
  const header = req.headers['authorization'] ?? '';
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const t = header.slice(7).trim();
    return t.length > 0 ? t : null;
  }
  return null;
}

/**
 * Constant-time string comparison. Returns false on length mismatch (which
 * is itself a leak, but the lengths of admin tokens are not secret).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
