/**
 * Agent proxy routes.
 *
 * Browser → Manager → Agent. The manager owns the agent's token; the
 * browser only ever talks to the manager and never sees the agent URL.
 *
 *   GET    /v1/agents/:aid/sessions                → list sessions
 *   POST   /v1/agents/:aid/sessions                → create session
 *   GET    /v1/agents/:aid/sessions/:sid           → get session metadata
 *   DELETE /v1/agents/:aid/sessions/:sid           → kill/delete session
 *   POST   /v1/agents/:aid/sessions/:sid/input     → send input
 *   POST   /v1/agents/:aid/sessions/:sid/resize    → resize PTY
 *   GET    /v1/agents/:aid/sessions/:sid/output    → fetch historical output
 *   GET    /v1/agents/:aid/sessions/:sid/stream    → SSE live passthrough
 *
 * The agent's token is passed as `?access_token=…` on every forwarded
 * request — that matches what HttpSseTransport does on the client side,
 * so the agent's auth middleware can accept either a Bearer header or
 * the query parameter.
 *
 * The SSE route streams bytes from the agent's response straight to the
 * browser's response — we never buffer the full session output in memory.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Storage } from '../storage.js';
import { log } from '../util/log.js';

/** Build the upstream URL for a non-stream proxy call. */
function buildAgentUrl(base: string, path: string, token: string): string {
  return `${base.replace(/\/+$/, '')}${path}?access_token=${encodeURIComponent(token)}`;
}

/**
 * Generic JSON proxy: forwards the request body verbatim to the agent,
 * mirrors the status + body back to the browser. Used for the non-stream
 * REST endpoints.
 */
async function proxyJson(
  storage: Storage,
  aid: string | undefined,
  method: 'GET' | 'POST' | 'DELETE',
  upstreamPath: string,
  body: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  if (!aid) {
    return reply.code(400).send({ error: 'missing aid' });
  }
  const agent = storage.getAgent(aid);
  if (!agent) {
    return reply.code(404).send({
      error: { code: 'not_found', message: 'agent not found' },
    });
  }

  const url = buildAgentUrl(agent.baseUrl, upstreamPath, agent.token);
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }

  let agentRes: Response;
  try {
    agentRes = await fetch(url, init);
  } catch (err) {
    log.error({ err, aid, upstream: url }, 'proxy: upstream fetch failed');
    return reply.code(502).send({
      error: { code: 'upstream_unreachable', message: (err as Error).message },
    });
  }

  reply.code(agentRes.status);
  if (agentRes.status === 204) return reply.send();

  const text = await agentRes.text();
  reply.header('Content-Type', agentRes.headers.get('content-type') ?? 'application/json');
  try {
    return reply.send(JSON.parse(text));
  } catch {
    return reply.send(text);
  }
}

export function registerProxyRoutes(app: FastifyInstance, storage: Storage): void {
  // ── List / create sessions ────────────────────────────────────────────
  app.get<{ Params: { aid: string } }>('/v1/agents/:aid/sessions', async (req, reply) => {
    return proxyJson(storage, req.params.aid, 'GET', '/v1/sessions', undefined, reply);
  });

  app.post<{ Params: { aid: string } }>('/v1/agents/:aid/sessions', async (req, reply) => {
    return proxyJson(storage, req.params.aid, 'POST', '/v1/sessions', req.body, reply);
  });

  // ── Single-session operations ──────────────────────────────────────────
  app.get<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid',
    async (req, reply) => {
      return proxyJson(
        storage,
        req.params.aid,
        'GET',
        `/v1/sessions/${encodeURIComponent(req.params.sid)}`,
        undefined,
        reply,
      );
    },
  );

  app.delete<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid',
    async (req, reply) => {
      return proxyJson(
        storage,
        req.params.aid,
        'DELETE',
        `/v1/sessions/${encodeURIComponent(req.params.sid)}`,
        undefined,
        reply,
      );
    },
  );

  app.post<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid/input',
    async (req, reply) => {
      return proxyJson(
        storage,
        req.params.aid,
        'POST',
        `/v1/sessions/${encodeURIComponent(req.params.sid)}/input`,
        req.body,
        reply,
      );
    },
  );

  app.post<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid/resize',
    async (req, reply) => {
      return proxyJson(
        storage,
        req.params.aid,
        'POST',
        `/v1/sessions/${encodeURIComponent(req.params.sid)}/resize`,
        req.body,
        reply,
      );
    },
  );

  app.get<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid/output',
    async (req, reply) => {
      // Preserve any query params the browser sent (e.g. ?from=…).
      const queryString = req.url.split('?')[1] ?? '';
      const upstreamPath = `/v1/sessions/${encodeURIComponent(req.params.sid)}/output${
        queryString ? `?${queryString}` : ''
      }`;
      return proxyJson(storage, req.params.aid, 'GET', upstreamPath, undefined, reply);
    },
  );

  // ── SSE stream — long-lived passthrough ────────────────────────────────
  // We deliberately bypass Fastify's JSON serialization here: the response
  // is text/event-stream and we want zero buffering between the agent and
  // the browser. The agent's auth token rides along in the URL, matching
  // what HttpSseTransport does on the client side.
  app.get<{ Params: { aid: string; sid: string } }>(
    '/v1/agents/:aid/sessions/:sid/stream',
    async (req: FastifyRequest<{ Params: { aid: string; sid: string } }>, reply: FastifyReply) => {
      const { aid, sid } = req.params;
      const agent = storage.getAgent(aid);
      if (!agent) {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'agent not found' },
        });
      }

      const url = `${agent.baseUrl.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sid)}/stream?access_token=${encodeURIComponent(agent.token)}`;

      let agentRes: Response;
      try {
        agentRes = await fetch(url);
      } catch (err) {
        log.error({ err, aid, sid }, 'proxy: SSE upstream fetch failed');
        return reply.code(502).send({
          error: { code: 'upstream_unreachable', message: (err as Error).message },
        });
      }

      if (!agentRes.ok) {
        // Mirror non-2xx upstream so the browser's EventSource sees the
        // real status (e.g. 404 for unknown session) instead of 502.
        const text = await agentRes.text();
        reply.code(agentRes.status);
        reply.header('Content-Type', agentRes.headers.get('content-type') ?? 'application/json');
        return reply.send(text);
      }

      if (!agentRes.body) {
        reply.code(204).send();
        return;
      }

      // Switch to raw mode: write SSE headers manually and stream chunks.
      reply.raw.writeHead(agentRes.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Disable nginx-style buffering if behind a reverse proxy.
        'X-Accel-Buffering': 'no',
      });

      const reader = agentRes.body.getReader();
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        try { reader.cancel(); } catch { /* ignore */ }
        try { reply.raw.end(); } catch { /* ignore */ }
      };

      // If the browser disconnects, stop pulling from the agent.
      req.raw.on('close', cleanup);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!reply.raw.write(Buffer.from(value))) {
            // Respect backpressure from the browser.
            await new Promise<void>((resolve) => reply.raw.once('drain', resolve));
          }
        }
      } catch (err) {
        log.warn({ err, aid, sid }, 'proxy: SSE pump error');
      } finally {
        cleanup();
      }

      // Tell Fastify we handled the response ourselves.
      return reply;
    },
  );
}