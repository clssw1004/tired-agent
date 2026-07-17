/**
 * Bearer-session authentication middleware.
 *
 * Every request (except the public login route, the health probe, and CORS
 * preflights) must carry `Authorization: Bearer <session-token>`. The token
 * is looked up in the manager_sessions table and rejected if missing or
 * expired.
 *
 * On success, the request is decorated with `req.userToken` so downstream
 * handlers (e.g. the proxy) can use it without re-parsing the header.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Storage } from './storage.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by registerAuth when the request carries a valid session token. */
    userToken?: string;
  }
}

const PUBLIC_PATHS = new Set<string>([
  '/health',
  '/v1/manager/auth/login',
]);

export function registerAuth(app: FastifyInstance, storage: Storage): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight: respond without inspecting auth. Browsers won't send
    // credentials on the preflight anyway.
    if (req.method === 'OPTIONS') return;

    // Strip query string before matching — /v1/manager/auth/login is public
    // regardless of how the client spelled it.
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;

    // Anything that isn't under /v1/ is treated as a SPA asset (HTML /
    // JS / CSS / static). The browser must be able to load the login
    // page and its bundles without a session token; the SPA then calls
    // /v1/manager/auth/me to discover whether a stored token is valid.
    if (!path.startsWith('/v1/')) return;

    const header = req.headers['authorization'] ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'missing bearer token' },
      });
    }

    const token = header.slice(7).trim();
    if (!token) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'missing bearer token' },
      });
    }

    const session = storage.getSession(token);
    if (!session) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'invalid or expired session' },
      });
    }

    req.userToken = token;
  });
}