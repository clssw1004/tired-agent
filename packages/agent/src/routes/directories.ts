/**
 * REST API routes for the agent's directory browser.
 *
 * Base path: /directories
 *
 * Schema validation via zod. Wire-level types are re-exported from
 * @tired-agent/protocol; this layer is responsible only for translating
 * between HTTP requests and the server-internal DirectoryService /
 * DirectoryStore interfaces.
 *
 * ## Error mapping
 *
 * Domain errors raised by the service carry a stable `code` string
 * (DIRECTORY_NOT_FOUND / DIRECTORY_ACCESS_DENIED / NOT_A_DIRECTORY) which
 * is translated 1:1 into the wire-protocol's ErrorResponse, with a
 * status code drawn from the design spec:
 *
 *   - 400 NOT_A_DIRECTORY          (path is a file, not a directory)
 *   - 400 INVALID_PATH             (validation: empty, not a string, …)
 *   - 400 VALIDATION_ERROR         (malformed body)
 *   - 404 DIRECTORY_NOT_FOUND
 *   - 403 DIRECTORY_ACCESS_DENIED
 *   - 404 NOT_FOUND                (favorite id does not exist)
 *   - 500 DIRECTORY_READ_ERROR     (anything else)
 *
 * The error handler never echoes the underlying error stack back to the
 * client — only `code` and `message` are exposed.
 *
 * ## Order matters
 *
 * The fixed paths (`/shortcuts`, `/favorites`) are registered before
 * the parameterized `:id` so a future `/shortcuts` lookup never collides
 * with a wildcard match.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DirectoryService, DirectoryStore } from '../directory/types.js';
import { log } from '../util/log.js';

const FavoriteSchema = z.object({
  path: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
});

const ListQuerySchema = z.object({
  path: z.string().optional(),
});

export function registerDirectoryRoutes(
  app: FastifyInstance,
  service: DirectoryService,
  store: DirectoryStore,
): void {
  // ── Shortcuts (favorites + recent) — fixed path before parameterized ones ──
  app.get('/directories/shortcuts', async (_req, reply) => {
    try {
      const shortcuts = await store.getShortcuts();
      return reply.code(200).send(shortcuts);
    } catch (err) {
      log.error({ err }, 'GET /directories/shortcuts failed');
      return mapError(reply, err);
    }
  });

  // ── List children of a directory ─────────────────────────────────────
  app.get<{ Querystring: { path?: string } }>('/directories', async (req, reply) => {
    const parsed = ListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    try {
      const listing = await service.list(parsed.data.path);
      return reply.code(200).send(listing);
    } catch (err) {
      log.error({ err }, 'GET /directories failed');
      return mapError(reply, err);
    }
  });

  // ── Add favorite ─────────────────────────────────────────────────────
  app.post('/directories/favorites', async (req, reply) => {
    const parsed = FavoriteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
      });
    }
    try {
      // Validate first so a malformed path never pollutes the store.
      await service.validateDirectory(parsed.data.path);
      const favorite = await store.addFavorite(parsed.data.path, parsed.data.name);
      return reply.code(201).send(favorite);
    } catch (err) {
      log.error({ err }, 'POST /directories/favorites failed');
      return mapError(reply, err);
    }
  });

  // ── Remove favorite by id (parameterized path, must come last) ───────
  app.delete<{ Params: { id: string } }>(
    '/directories/favorites/:id',
    async (req, reply) => {
      try {
        const removed = await store.removeFavorite(req.params.id);
        if (!removed) {
          return reply.code(404).send({
            error: { code: 'NOT_FOUND', message: `Favorite ${req.params.id} not found` },
          });
        }
        return reply.code(204).send();
      } catch (err) {
        log.error({ err }, 'DELETE /directories/favorites/:id failed');
        return mapError(reply, err);
      }
    },
  );
}

/**
 * Translate a directory-domain error (or anything else) into the
 * documented HTTP + code combination. Falls through to a generic 500
 * for unknown errors. Never forwards the raw stack.
 */
function mapError(
  reply: import('fastify').FastifyReply,
  err: unknown,
): import('fastify').FastifyReply {
  const e = err as NodeJS.ErrnoException & { cause?: unknown };
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case 'DIRECTORY_NOT_FOUND':
      return reply.code(404).send({
        error: { code: 'DIRECTORY_NOT_FOUND', message },
      });
    case 'DIRECTORY_ACCESS_DENIED':
      return reply.code(403).send({
        error: { code: 'DIRECTORY_ACCESS_DENIED', message },
      });
    case 'NOT_A_DIRECTORY':
      return reply.code(400).send({
        error: { code: 'NOT_A_DIRECTORY', message },
      });
    case 'INVALID_PATH':
      return reply.code(400).send({
        error: { code: 'INVALID_PATH', message },
      });
    default:
      return reply.code(500).send({
        error: { code: 'DIRECTORY_READ_ERROR', message },
      });
  }
}
