/**
 * Module augmentations and shared types for tired-pc server.
 */

import type { Storage } from './session/storage.js';

// Make FastifyInstance recognize our attached `storage` field
declare module 'fastify' {
  interface FastifyInstance {
    storage: Storage;
  }
}

export {};
