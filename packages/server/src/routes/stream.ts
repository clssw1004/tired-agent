/**
 * SSE (Server-Sent Events) streaming endpoint.
 *
 * GET /v1/sessions/:id/stream
 *
 * Emits three event types:
 *   output  — PTY bytes arrived
 *   state   — session state changed (including byteOffset updates)
 *   heartbeat — 15 s keepalive to prevent proxy timeouts
 *
 * Subscribers receive events for as long as the connection is open.
 * The connection is filterable by query param `?from=N` to replay missed
 * output on reconnect (the client sends the last byte offset it has seen).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionManager } from '../session/manager.js';
import { log } from '../util/log.js';
import '../types.js'; // module augmentation for FastifyInstance.storage

const HEARTBEAT_INTERVAL_MS = 15_000;

interface StreamParams { id: string }
interface StreamQuery { access_token?: string; from?: string }

export function registerStreamRoute(app: FastifyInstance, manager: SessionManager): void {
  app.get<{ Params: StreamParams; Querystring: StreamQuery }>(
    '/v1/sessions/:id/stream',
    { config: { raw: true } },
    async (req: FastifyRequest<{ Params: StreamParams; Querystring: StreamQuery }>, reply: FastifyReply) => {
      const { id } = req.params;
      const session = manager.get(id);
      if (!session) {
        // Use raw writeHead to avoid Fastify's automatic 200-then-replace headers
        // (which would conflict if reply.send is called later).
        reply.raw.writeHead(404, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({
          error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
        }));
        // Don't return the Fastify reply object — that triggers Fastify's
        // own response cycle on the same connection.
        return;
      }

      // Check from= query param for replay
      const fromOffset = Math.max(0, Number(req.query.from ?? '0'));

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Accel-Buffering': 'no', // disable nginx buffering
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Flush headers immediately so EventSource can connect
      reply.raw.flushHeaders();

      let unsubscribed = false;

      // ── Replay missed output ────────────────────────────────────────────
      if (fromOffset < session.byteOffset) {
        const storage = req.server.storage;
        const result = storage.readOutput(id, fromOffset);
        for (const chunk of result.chunks) {
          reply.raw.write(
            `event: output\ndata: ${JSON.stringify({
              offset: chunk.offset,
              data: Buffer.from(chunk.data).toString('base64'),
            })}\n\n`,
          );
        }
        // Also emit current state after replay
        const current = manager.get(id);
        if (current) {
          reply.raw.write(
            `event: state\ndata: ${JSON.stringify(current)}\n\n`,
          );
        }
      }

      // ── Heartbeat ───────────────────────────────────────────────────────
      const heartbeatTimer = setInterval(() => {
        if (reply.raw.writableEnded) { clearInterval(heartbeatTimer); return; }
        reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
      }, HEARTBEAT_INTERVAL_MS);

      // ── Subscribe to live events ────────────────────────────────────────
      const unsubscribe = manager.subscribe(id, (ev) => {
        if (reply.raw.writableEnded) return;
        if (ev.type === 'output') {
          reply.raw.write(
            `event: output\ndata: ${JSON.stringify({
              offset: ev.offset,
              data: Buffer.from(ev.data).toString('base64'),
            })}\n\n`,
          );
        } else if (ev.type === 'state') {
          reply.raw.write(`event: state\ndata: ${JSON.stringify(ev.record)}\n\n`);
        }
      });

      // ── Cleanup on close ───────────────────────────────────────────────
      req.raw.on('close', () => {
        unsubscribed = true;
        unsubscribe();
        clearInterval(heartbeatTimer);
        log.debug({ sessionId: id }, 'SSE client disconnected');
      });

      log.debug({ sessionId: id, fromOffset }, 'SSE client connected');
    },
  );
}
