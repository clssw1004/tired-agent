/**
 * Agent CRUD routes.
 *
 *   GET    /v1/manager/agents       → list registered agents (no tokens)
 *   POST   /v1/manager/agents       → register a new agent
 *   DELETE /v1/manager/agents/:id   → unregister an agent
 *
 * The browser-facing list deliberately omits the agent's own token — the
 * proxy uses it from the manager_sessions side and the browser has no
 * business knowing it. PUT (edit) is not implemented yet; v0 expects the
 * user to delete + re-add.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Storage } from '../storage.js';
import type { ManagerConfig } from '../config.js';

const AddAgentSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  token: z.string().min(1),
});

const RegisterAgentSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  registerToken: z.string().min(1),
  /** Agent's persistent key — sent on re-registration for dedup. */
  agentKey: z.string().optional(),
});

export function registerAgentRoutes(app: FastifyInstance, storage: Storage, cfg: ManagerConfig): void {
  app.get('/v1/manager/agents', async (_req, reply) => {
    const agents = storage.listAgents();
    // Strip the agent's own token before returning — the browser only
    // needs name + baseUrl to build a ServerRef pointing at the manager.
    return reply.code(200).send(
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        baseUrl: a.baseUrl,
        enabled: a.enabled,
        createdAt: a.createdAt,
      })),
    );
  });

  app.post('/v1/manager/agents', async (req, reply) => {
    const parsed = AddAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.message },
      });
    }
    const { id } = storage.addAgent(
      parsed.data.name,
      parsed.data.baseUrl,
      parsed.data.token,
    );
    return reply.code(201).send({ id });
  });

  // ── Auto-register (public, no session auth — but protected by registerToken) ──
  app.post('/v1/manager/agents/register', async (req, reply) => {
    if (!cfg.registerSecret) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'Registration is not enabled' },
      });
    }

    const parsed = RegisterAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: parsed.error.message },
      });
    }

    // Constant-time compare the register token.
    const provided = parsed.data.registerToken;
    if (provided.length !== cfg.registerSecret.length ||
        !constantTimeEqual(provided, cfg.registerSecret)) {
      return reply.code(403).send({
        error: { code: 'invalid_register_token', message: 'Invalid register token' },
      });
    }

    const { id, token } = storage.registerAgent(parsed.data.name, parsed.data.baseUrl, parsed.data.agentKey);
    return reply.code(201).send({ id, token });
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/manager/agents/:id',
    async (req, reply) => {
      const agent = storage.getAgent(req.params.id);
      if (!agent) {
        return reply.code(404).send({
          error: { code: 'not_found', message: 'agent not found' },
        });
      }
      storage.deleteAgent(req.params.id);
      return reply.code(200).send({ ok: true });
    },
  );
}

/**
 * Constant-time string comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}