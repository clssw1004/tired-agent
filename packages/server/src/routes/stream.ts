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
 *
 * Wire format of the `data:` payload in `output` events depends on
 * `CLSSW_SSE_FORMAT`:
 *   base64 (default) — `data` is a base64 string of the raw PTY bytes
 *   hex              — `data` is a lowercase hex string of the raw bytes
 *                      (debug mode; lets you copy bytes straight from
 *                      `curl -N` without a decoder handy)
 *
 * When `CLSSW_DEBUG_SSE=1`, the server also logs a hex+ASCII dump of every
 * chunk to its own log — local debugging only.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SessionManager } from '../session/manager.js';
import type { ServerConfig } from '../config.js';
import { log } from '../util/log.js';
import { hexAsciiDump } from '../util/hex-dump.js';
import '../types.js'; // module augmentation for FastifyInstance.storage

const HEARTBEAT_INTERVAL_MS = 15_000;

interface StreamParams { id: string }
interface StreamQuery { access_token?: string; from?: string }

/** Encode raw PTY bytes as a string suitable for the SSE `data:` line. */
function encodeChunk(bytes: Uint8Array, format: 'base64' | 'hex'): string {
  if (format === 'hex') {
    return Buffer.from(bytes).toString('hex');
  }
  return Buffer.from(bytes).toString('base64');
}

export function registerStreamRoute(
  app: FastifyInstance,
  manager: SessionManager,
  cfg: Pick<ServerConfig, 'sseFormat' | 'sseDebugLog'>,
): void {
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

      // Log format/upgrades along with the connect event so curl+grep is easy.
      log.debug({ sessionId: id, fromOffset, format: cfg.sseFormat, debug: cfg.sseDebugLog }, 'SSE client connected');

      // ── Replay missed output ────────────────────────────────────────────
      if (fromOffset < session.byteOffset) {
        const storage = req.server.storage;
        const result = storage.readOutput(id, fromOffset);
        for (const chunk of result.chunks) {
          const dataBytes = new Uint8Array(chunk.data);
          if (cfg.sseDebugLog) {
            log.debug({ replay: true, off: chunk.offset, len: dataBytes.byteLength, dump: hexAsciiDump(dataBytes) }, 'sse-replay-output');
          }
          reply.raw.write(
            `event: output\ndata: ${JSON.stringify({
              offset: chunk.offset,
              data: encodeChunk(dataBytes, cfg.sseFormat),
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
          if (cfg.sseDebugLog) {
            log.debug({ off: ev.offset, len: ev.data.byteLength, dump: hexAsciiDump(ev.data) }, 'sse-live-output');
          }
          reply.raw.write(
            `event: output\ndata: ${JSON.stringify({
              offset: ev.offset,
              data: encodeChunk(ev.data, cfg.sseFormat),
            })}\n\n`,
          );
        } else if (ev.type === 'state') {
          reply.raw.write(`event: state\ndata: ${JSON.stringify(ev.record)}\n\n`);
        }
      });

      // ── Cleanup on close ───────────────────────────────────────────────
      req.raw.on('close', () => {
        unsubscribe();
        clearInterval(heartbeatTimer);
        log.debug({ sessionId: id }, 'SSE client disconnected');
      });

      log.debug({ sessionId: id, fromOffset }, 'SSE client connected');
    },
  );
}
