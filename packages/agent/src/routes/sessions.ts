/**
 * REST API routes for session lifecycle management.
 *
 * Base path: /sessions
 *
 * Schema validation via zod on request bodies.
 * Wire-level types (Session, SessionSpec…) are re-exported from @tired-agent/protocol
 * so both client and server share the same contract.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionSpec, SessionStatus } from '@tired-agent/protocol';
import type { ServerConfig } from '../config.js';
import type { SessionManager } from '../session/manager.js';
import type { Storage } from '../session/storage.js';
import { log } from '../util/log.js';
import { hexAsciiDump } from '../util/hex-dump.js';

const SessionSpecSchema: z.ZodType<SessionSpec> = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  cols: z.number().int().min(1).max(500).optional().default(80),
  rows: z.number().int().min(1).max(200).optional().default(24),
  label: z.string().optional(),
  mode: z.enum(['process', 'persistent']).optional().default('process'),
  executionMode: z.enum(['auto', 'manual', 'plan']).optional().default('auto'),
});

const ResizeSchema = z.object({
  cols: z.number().int().min(1).max(500),
  rows: z.number().int().min(1).max(200),
});

const OutputQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10 * 1024 * 1024).optional(),
  // `tail` reads only the last N bytes via a backwards seek — used by the
  // client to fast-load into a session whose log is huge. Mutually
  // exclusive with `from`/`limit`: an incremental replay path (from>0 or
  // a small limit) and a one-shot tail path answer different questions.
  tail: z.coerce.number().int().min(1).max(10 * 1024 * 1024).optional(),
}).refine(
  (q) => !(q.tail != null && (q.from !== 0 || q.limit != null)),
  { message: 'tail is mutually exclusive with from/limit; omit from when using tail' },
);

export function registerSessionsRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  storage: Storage,
  cfg: Pick<ServerConfig, 'sseDebugLog'>,
): void {
  // ── List (optional ?status=running filter) ───────────────────
  app.get<{ Querystring: { status?: string } }>('/sessions', async (req, reply) => {
    const filter = req.query.status as SessionStatus | undefined;
    let sessions = manager.list();
    if (filter) sessions = sessions.filter((s) => s.status === filter);
    return reply.code(200).send(sessions);
  });

  // ── Bulk prune: drop DB rows + log files whose sessions are stale ───
  //   DELETE /sessions/prune?olderThanHours=24
  app.delete<{ Querystring: { olderThanHours?: string } }>(
    '/sessions/prune',
    async (req, reply) => {
      const hours = Math.max(0, Number(req.query.olderThanHours ?? 24));
      const removed = storage.pruneOlderThan(hours * 3600 * 1000);
      manager.pruneStale();
      log.info({ olderThanHours: hours, removed }, 'pruned old sessions');
      return reply.code(200).send({ removed });
    },
  );

  // ── Create ──────────────────────────────────────────────────────────────
  app.post('/sessions', async (req, reply) => {
    const parsed = SessionSpecSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    try {
      const session = await manager.create(parsed.data);
      log.info({ sessionId: session.id }, 'POST /sessions → created');
      return reply.code(201).send(session);
    } catch (err) {
      log.error({ err }, 'POST /sessions failed');
      return reply.code(500).send({
        error: { code: 'SPAWN_ERROR', message: (err as Error).message },
      });
    }
  });

  // ── Get one ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const { id } = req.params;
    const session = manager.get(id);
    if (!session) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
      });
    }
    return reply.code(200).send(session);
  });

  // ── Kill (running) or hard-delete (already exited) ───────────────────
  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const { id } = req.params;
    const session = manager.get(id);
    if (!session) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
      });
    }
    try {
      if (session.status === 'exited') {
        storage.delete(id);
        manager.pruneStale();
        log.info({ sessionId: id }, 'DELETE /sessions/:id → deleted (exited)');
        return reply.code(204).send();
      }
      await manager.kill(id);
      log.info({ sessionId: id }, 'DELETE /sessions/:id → killed');
      return reply.code(204).send();
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'KILL_ERROR', message: (err as Error).message },
      });
    }
  });

  // ── Resize ─────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/resize',
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ResizeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const session = manager.get(id);
      if (!session) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
        });
      }
      try {
        manager.resize(id, parsed.data.cols, parsed.data.rows);
        return reply.code(200).send(manager.get(id));
      } catch (err) {
        return reply.code(500).send({
          error: { code: 'RESIZE_ERROR', message: (err as Error).message },
        });
      }
    },
  );

  // ── Fetch historical output ────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { from?: string; limit?: string } }>(
    '/sessions/:id/output',
    async (req, reply) => {
      const { id } = req.params;
      const session = manager.get(id);
      if (!session) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
        });
      }
      const parsed = OutputQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      const tail = parsed.data.tail;
      if (tail != null) {
        const tailResult = storage.readOutputTail(id, tail);
        return reply.code(200).send({
          chunks: tailResult.chunks.map((c) => ({
            offset: c.offset,
            data: Buffer.from(c.data).toString('base64'),
          })),
          upTo: tailResult.upTo,
          // Tail mode: truncated when the file was larger than `tail` bytes.
          truncated: tailResult.truncated,
          totalBytes: tailResult.upTo,
        });
      }
      const result = storage.readOutput(id, parsed.data.from, parsed.data.limit);
      return reply.code(200).send({
        chunks: result.chunks.map((c) => ({
          offset: c.offset,
          data: Buffer.from(c.data).toString('base64'),
        })),
        upTo: result.upTo,
        // from/limit returns the whole remaining range by definition, so
        // truncated is always false here — but we still emit the field so
        // older clients that ignore the missing field see consistent shape.
        truncated: false,
        totalBytes: result.upTo,
      });
    },
  );

  // ── Send input ─────────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/input',
    async (req, reply) => {
      const { id } = req.params;
      const session = manager.get(id);
      if (!session) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `Session ${id} not found` },
        });
      }
      if (session.status === 'exited') {
        return reply.code(409).send({
          error: { code: 'SESSION_EXITED', message: 'Cannot write to an exited session' },
        });
      }
      const body = req.body as { data?: unknown };
      if (typeof body?.data !== 'string') {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: '"data" (base64 string) is required' },
        });
      }
      try {
        const buf = Buffer.from(body.data, 'base64');
        const bytes = new Uint8Array(buf);
        if (cfg.sseDebugLog) {
          log.debug({ sessionId: id, len: bytes.byteLength, dump: hexAsciiDump(bytes) }, 'sse-input');
        }
        manager.write(id, bytes);
        return reply.code(204).send();
      } catch (err) {
        return reply.code(500).send({
          error: { code: 'WRITE_ERROR', message: (err as Error).message },
        });
      }
    },
  );
}
