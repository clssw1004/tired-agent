/**
 * Bearer-session authentication middleware.
 *
 * Every request (except the public login & refresh routes, the health
 * probe, and CORS
 * preflights) must carry `Authorization: Bearer <session-token>` or
 * `?access_token=<session-token>` (SSE EventSource cannot send headers).
 * The token is looked up in the manager_sessions table and rejected if
 * missing or expired.
 *
 * On success, the request is decorated with `req.userToken` so downstream
 * handlers (e.g. the proxy) can use it without re-parsing the header.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Storage } from './storage.js';
import { API_PREFIX } from '@tired-agent/protocol';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by registerAuth when the request carries a valid session token. */
    userToken?: string;
  }
}

const PUBLIC_PATHS = new Set<string>([
  '/health',
  `${API_PREFIX}/manager/auth/login`,
  `${API_PREFIX}/manager/auth/refresh`,   // refresh authenticates with refreshToken, not sessionToken
  `${API_PREFIX}/manager/agents/register`,
]);

export function registerAuth(app: FastifyInstance, storage: Storage): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // CORS preflight: respond without inspecting auth.
    if (req.method === 'OPTIONS') return;

    // Strip query string before matching public paths.
    const path = req.url.split('?')[0] ?? req.url;
    if (PUBLIC_PATHS.has(path)) return;

    // Anything that isn't under the API prefix is a SPA asset — always allow.
    if (!path.startsWith(API_PREFIX) && path !== '/health') return;

    // Extract token from Authorization header or ?access_token= query param
    // (the latter is needed for SSE streams where EventSource cannot set
    // custom headers, matching the agent's auth behaviour).
    const header = req.headers['authorization'] ?? '';
    let token = '';
    if (header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    } else {
      const queryToken = (req.query as Record<string, string>)['access_token'] ?? '';
      if (queryToken) token = queryToken;
    }

    if (!token) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'missing bearer token or access_token' },
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
