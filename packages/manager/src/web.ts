/**
 * Static SPA hosting.
 *
 * Serves the built web app from `packages/web/dist/`:
 *   - Any path that looks like an asset (e.g. /assets/index-abc.js) is
 *     served directly by @fastify/static.
 *   - Any non-API path that doesn't match a static file falls back to
 *     `index.html` so the SPA router can take over.
 *   - /api/v1/* and /health always return JSON errors (not the SPA shell).
 *
 * If the SPA dist directory is missing at startup, we log a warning and
 * skip the static handler — the manager still works as a pure API
 * + proxy server.
 */

import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '@tired-agent/protocol';
import { log } from './util/log.js';

export async function registerWebRoutes(
  app: FastifyInstance,
  webDistPath: string,
): Promise<void> {
  if (!existsSync(webDistPath)) {
    log.warn(
      { webDistPath },
      'SPA dist not found — serving API only. Build packages/web and restart.',
    );
    return;
  }

  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: '/',
    // SPA-style: do not redirect /foo to /foo/, just 404 if the file is
    // missing (the not-found handler below will serve index.html).
    redirect: false,
  });

  // Catch-all for non-API routes: serve the SPA shell so client-side
  // routing works for deep links.
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (path === '/health' || path.startsWith(API_PREFIX)) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'not found' },
      });
    }
    return reply.sendFile('index.html');
  });
}