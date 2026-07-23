import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Standalone Vite config for the tired-agent web SPA.
 *
 * - npm run dev   → start Vite dev server on :5173 with /api/v1 proxied to :8443
 * - npm run build → emit static files to ./dist (deployable to nginx)
 *
 * The `@tired-agent/protocol` alias points to the file:-installed package
 * (../protocol), which after `npm install` contains either src/ or dist/
 * depending on whether protocol was built first.
 */
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',                 // relative paths so the SPA works under any mount
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  resolve: {
    alias: {
      // Serve protocol source directly so Vite/esbuild transforms it on the
      // fly — fixes the long-standing "fix protocol, refresh, still wrong"
      // bug caused by hardcoding this to dist/index.js (which only updates
      // when somebody remembers to rebuild).
      '@tired-agent/protocol': resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API to the running server during `vite dev`
      '/api/v1': {
        target: 'http://127.0.0.1:8443',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://127.0.0.1:8443',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
});
