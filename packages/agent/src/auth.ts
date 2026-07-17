/**
 * Bearer-token authentication middleware for Fastify.
 *
 * Applied globally on the server; returns 401 for unauthenticated requests.
 * The token is configured once at startup (--token flag / CLSSW_TOKEN env var).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export function registerAuth(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Skip auth for health check and CORS preflights. Preflights must be
    // answered *without* credentials or browsers will block the real request.
    if (req.url.split('?')[0] === '/health') return;
    if (req.method === 'OPTIONS') return;

    const header = req.headers['authorization'] ?? '';
    const provided = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : header.trim();

    // Also accept token as query param for SSE (EventSource cannot send headers)
    const queryToken = (req.query as Record<string, string>)['access_token'] ?? '';

    if (!provided && !queryToken) {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header or access_token query param' },
      });
    }

    const ok = (provided && provided === token) || (queryToken && queryToken === token);
    if (!ok) {
      return reply.code(401).send({
        error: { code: 'FORBIDDEN', message: 'Invalid token' },
      });
    }
  });
}
