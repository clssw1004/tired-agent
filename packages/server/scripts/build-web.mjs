/**
 * Build the web SPA via Vite.
 * Resolves vite from web/node_modules (where it actually lives).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, '..', 'web');

// Import vite from web's node_modules
const webRequire = createRequire(join(webDir, 'package.json'));
const { build, createServer } = webRequire('vite');

const configFile = join(webDir, 'vite.config.ts');
const isWatch = process.argv.includes('--watch');

if (isWatch) {
  const server = await createServer({ configFile });
  await server.listen();
  server.printUrls();
} else {
  console.log('[build-web] building…');
  await build({ configFile });
  console.log('[build-web] ✓ done');
}
