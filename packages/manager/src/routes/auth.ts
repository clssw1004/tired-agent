/**
 * Auth routes — login / logout / me.
 *
 *   POST /v1/manager/auth/login   → exchange admin token for session token
 *   POST /v1/manager/auth/logout  → invalidate current session (best-effort)
 *   GET  /v1/manager/auth/me      → confirm session is valid (auth already
 *                                   enforced by registerAuth)
 *
 * The login endpoint is the only public route under /v1 — registerAuth
 * skips it.
 */

import type { FastifyInstance } from 'fastify';
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
  app.post('/v1/manager/auth/login', async (req, reply) => {
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

    const session = storage.createSession();
    return reply.code(200).send({
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.post('/v1/manager/auth/logout', async (req, reply) => {
    // Auth is verified by registerAuth before we get here, so the
    // current session token is always present and valid.
    const token = req.userToken;
    if (token) storage.deleteSession(token);
    return reply.code(200).send({ ok: true });
  });

  app.get('/v1/manager/auth/me', async (req, reply) => {
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