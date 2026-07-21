#!/usr/bin/env node
/**
 * Cross-platform test runner for @tired-agent/agent.
 *
 * Recursively walks packages/agent/test/ and forwards every *.test.ts
 * file to Node's built-in test runner with the tsx loader (so
 * TypeScript sources are compiled on the fly).
 *
 * Why not just `node --test test/`?
 *   - Node treats a bare directory argument as an import target, not a
 *     glob root. Without explicit files the test runner looks for
 *     test/index.ts, which we don't ship.
 *   - node --test has no --glob flag in Node 20-22, so the runner's
 *     built-in discovery (* + .test.{cjs,mjs,js}) won't pick up .test.ts
 *     files on its own.
 *
 * This wrapper does the file discovery in plain Node so the same script
 * works in `npm run` on Windows (cmd / PowerShell) and bash on Linux.
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const testDir = join(here, '..', 'test');

/** Recursively collect every *.test.ts file under `dir`. */
async function collectTests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectTests(p)));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

const files = (await collectTests(testDir)).sort();
if (files.length === 0) {
  console.error(`run-tests: no *.test.ts files found under ${testDir}`);
  process.exit(1);
}

const args = ['--import', 'tsx', '--test', ...files];

// Echo the exact command so CI logs are inspectable.
console.log(`> node ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);

const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});