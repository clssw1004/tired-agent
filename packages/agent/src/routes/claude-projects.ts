import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DirectoryService } from '../directory/types.js';
import { log } from '../util/log.js';

const QuerySchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export function registerClaudeProjectsRoutes(
  app: FastifyInstance,
  service: DirectoryService,
): void {
  app.get<{ Querystring: { path?: string } }>(
    '/directories/claude-projects',
    async (req, reply) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      try {
        const result = await service.getClaudeProjects(parsed.data.path);
        return reply.code(200).send(result);
      } catch (err) {
        log.error({ err }, 'GET /directories/claude-projects failed');
        return reply.code(500).send({
          error: { code: 'DIRECTORY_READ_ERROR', message: (err as Error).message },
        });
      }
    },
  );
}
