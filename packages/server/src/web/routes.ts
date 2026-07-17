/**
 * Web UI routes — serve the React SPA built into src/web/static/.
 *
 * Critical: /web/assets/* must be served as static JS/CSS with correct MIME
 * types. Other /web/<path> routes serve index.html for SPA fallback.
 *
 * We do NOT use setNotFoundHandler — instead we explicitly declare routes
 * so fastify-static's lookup happens before any fallback.
 */

import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static');

const FAVICON_ICO = Buffer.from([
  0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00,
  0x18, 0x00, 0x30, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x28, 0x00,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00,
  0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);

export async function registerWebRoutes(app: FastifyInstance): Promise<void> {
  // favicon
  app.get('/favicon.ico', async (_req, reply) => {
    reply.header('Content-Type', 'image/x-icon');
    return reply.send(FAVICON_ICO);
  });

  if (!existsSync(STATIC_DIR)) {
    app.log.warn(
      { dir: STATIC_DIR },
      'Web UI not built yet — run `npm run build:web` in packages/server',
    );
  }

  // Register fastify-static in a CHILD context with prefix /web.
  // It registers its own /web/* routes internally for serving files.
  await app.register(async (child) => {
    await child.register(fastifyStatic, {
      root: STATIC_DIR,
      prefix: '/web/', // serves /web/, /web/index.html, /web/assets/*, etc.
      decorateReply: true, // needed for reply.sendFile in our fallback routes
      setHeaders: (res, path) => {
        res.setHeader('Cache-Control', 'no-cache');
        if (path.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
        if (path.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
      },
    });
  }, { prefix: '/web' });

  // SPA fallback routes — only explicit paths, no catch-all
  // (so /web/assets/*.js falls through to fastify-static, not this)
  const serveIndex = async (_req: unknown, reply: any) => reply.sendFile('index.html');

  app.get('/web', serveIndex);
  app.get('/web/', serveIndex);
  app.get('/web/:p', serveIndex);
  app.get('/web/:p/:s', serveIndex);
  app.get('/web/:p/:s/:e', serveIndex);

  // Root redirect
  app.get('/', async (_req, reply) => reply.redirect('/web/'));
}
