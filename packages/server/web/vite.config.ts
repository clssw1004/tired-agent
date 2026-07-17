import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build output goes into ../src/web/static/ which Fastify serves at /web/*
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  build: {
    outDir: resolve(__dirname, '../src/web/static'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash].js`,
        chunkFileNames: `assets/[name]-[hash].js`,
        assetFileNames: `assets/[name]-[hash].[ext]`,
      },
    },
  },
  resolve: {
    alias: {
      '@tired-pc/protocol': resolve(__dirname, 'node_modules/@tired-pc/protocol/dist/index.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:8443',
      '/health': 'http://127.0.0.1:8443',
    },
  },
});
