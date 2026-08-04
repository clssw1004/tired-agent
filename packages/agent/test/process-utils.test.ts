/**
 * Unit tests for the cross-platform process/port helpers in
 * src/util/process-utils.ts.
 *
 * These tests only ever use temporary directories, throwaway child
 * processes, and random/ephemeral ports — they never touch the running
 * agent (8444), the manager (8443), or any real data directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import {
  readPidFile,
  isProcessAlive,
  signalProcess,
  waitForProcessExit,
  terminateProcess,
  isPortListening,
  checkAgentStartGuard,
  isDirectEntry,
  parseNetstatPort,
  parseLsofPort,
  parseSsPort,
} from '../src/util/process-utils.js';
import { pathToFileURL } from 'node:url';

function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tired-agent-utils-'));
}

/** Spawn a node child that sleeps forever; cleaned up by the test harness. */
function spawnSleeper(t: { after: (fn: () => void) => void }): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ok */
    }
  });
  return child;
}

async function waitUntilGone(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─── readPidFile ─────────────────────────────────────────────────

test('readPidFile parses a valid PID file', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'agent.pid'), '12345\n');
  assert.equal(readPidFile(dir), 12345);
  await rm(dir, { recursive: true, force: true });
});

test('readPidFile trims surrounding whitespace', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'agent.pid'), '  9876  \n');
  assert.equal(readPidFile(dir), 9876);
  await rm(dir, { recursive: true, force: true });
});

test('readPidFile returns null for missing file', async () => {
  const dir = await makeTmpDir();
  assert.equal(readPidFile(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test('readPidFile returns null for corrupt PID files', async () => {
  const dir = await makeTmpDir();
  await writeFile(join(dir, 'agent.pid'), 'not-a-number');
  assert.equal(readPidFile(dir), null);
  await writeFile(join(dir, 'agent.pid'), '-1');
  assert.equal(readPidFile(dir), null);
  await writeFile(join(dir, 'agent.pid'), '0');
  assert.equal(readPidFile(dir), null);
  await rm(dir, { recursive: true, force: true });
});

// ─── isProcessAlive ──────────────────────────────────────────────

test('isProcessAlive rejects non-PIDs', () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(Number.NaN), false);
  assert.equal(isProcessAlive(Number.POSITIVE_INFINITY), false);
});

test('isProcessAlive reports false for an impossibly high PID', () => {
  assert.equal(isProcessAlive(2147483647), false);
});

test('isProcessAlive tracks a real child process', async (t) => {
  const child = spawnSleeper(t);
  assert.equal(isProcessAlive(child.pid), true);
  child.kill();
  await waitUntilGone(child.pid);
  assert.equal(isProcessAlive(child.pid), false);
});

// ─── signalProcess ───────────────────────────────────────────────

test('signalProcess returns false for a dead PID', () => {
  assert.equal(signalProcess(2147483647, 'SIGTERM'), false);
});

test('signalProcess delivers SIGTERM to a real child', async (t) => {
  const child = spawnSleeper(t);
  assert.equal(signalProcess(child.pid, 'SIGTERM'), true);
  await waitUntilGone(child.pid);
  assert.equal(isProcessAlive(child.pid), false);
});

// ─── waitForProcessExit ──────────────────────────────────────────

test('waitForProcessExit returns immediately when already gone', async () => {
  const ok = await waitForProcessExit(999999, () => false, 500);
  assert.equal(ok, true);
});

test('waitForProcessExit waits for a process to disappear', async () => {
  let alive = true;
  setTimeout(() => {
    alive = false;
  }, 150);
  const ok = await waitForProcessExit(42, () => alive, 2000, {
    pollIntervalMs: 20,
  });
  assert.equal(ok, true);
});

test('waitForProcessExit times out for a live process', async () => {
  const start = Date.now();
  const ok = await waitForProcessExit(42, () => true, 120, {
    pollIntervalMs: 20,
  });
  assert.equal(ok, false);
  assert.ok(Date.now() - start >= 100, 'should not return early');
});

// ─── terminateProcess ────────────────────────────────────────────

test('terminateProcess no-ops when the process is already gone', async () => {
  const result = await terminateProcess(999999, { isAlive: () => false });
  assert.deepEqual(result, { exited: true, killed: false });
});

test('terminateProcess waits for a graceful exit', async () => {
  let alive = true;
  setTimeout(() => {
    alive = false;
  }, 150);
  const result = await terminateProcess(42, {
    isAlive: () => alive,
    timeoutMs: 2000,
  });
  assert.deepEqual(result, { exited: true, killed: false });
});

test('terminateProcess escalates to SIGKILL when graceful exit times out', async () => {
  const result = await terminateProcess(42, {
    isAlive: () => true, // never dies, even after SIGKILL
    timeoutMs: 100,
  });
  assert.equal(result.exited, false);
  assert.equal(result.killed, true);
});

test('terminateProcess stops a real child process', async (t) => {
  const child = spawnSleeper(t);
  const result = await terminateProcess(child.pid, { timeoutMs: 2000 });
  assert.equal(result.exited, true);
  assert.equal(isProcessAlive(child.pid), false);
});

test('terminateProcess force-kills a child that ignores SIGTERM', {
  skip: process.platform === 'win32',
}, async (t) => {
  // SIGTERM handler swallows the signal; only SIGKILL can stop it.
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: 'ignore' },
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ok */
    }
  });
  const result = await terminateProcess(child.pid, { timeoutMs: 300 });
  assert.equal(result.exited, true);
  assert.equal(result.killed, true);
});

// ─── isPortListening ─────────────────────────────────────────────

test('isPortListening detects a live listener', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as net.AddressInfo;
  try {
    assert.equal(await isPortListening('127.0.0.1', addr.port, 500), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('isPortListening returns false when nothing listens', async () => {
  // Random high port — very unlikely to be bound in a test sandbox.
  const port = 20000 + Math.floor(Math.random() * 40000);
  assert.equal(await isPortListening('127.0.0.1', port, 300), false);
});

// ─── checkAgentStartGuard ────────────────────────────────────────

test('start guard: no PID file → ok', async () => {
  const result = await checkAgentStartGuard('/tmp/x', '127.0.0.1', 8444, {
    readPid: () => null,
  });
  assert.deepEqual(result, { ok: true, stalePid: null });
});

test('start guard: dead PID → ok with DEAD_PROCESS stale', async () => {
  const result = await checkAgentStartGuard('/tmp/x', '127.0.0.1', 8444, {
    readPid: () => 42,
    isAlive: () => false,
  });
  assert.deepEqual(result, { ok: true, stalePid: 42, staleReason: 'DEAD_PROCESS' });
});

test('start guard: live PID + listening port → ALREADY_RUNNING', async () => {
  const result = await checkAgentStartGuard('/tmp/x', '127.0.0.1', 8444, {
    readPid: () => 42,
    isAlive: () => true,
    isListening: async () => true,
  });
  assert.deepEqual(result, {
    ok: false,
    reason: 'ALREADY_RUNNING',
    pid: 42,
    host: '127.0.0.1',
    port: 8444,
  });
});

test('start guard: live PID + silent port → ok with NOT_LISTENING stale', async () => {
  const result = await checkAgentStartGuard('/tmp/x', '127.0.0.1', 8444, {
    readPid: () => 42,
    isAlive: () => true,
    isListening: async () => false,
  });
  assert.deepEqual(result, {
    ok: true,
    stalePid: 42,
    staleReason: 'NOT_LISTENING',
  });
});

test('start guard: no liveness probe falls back to the real one', async () => {
  // readPid returns null, so the real probes are never invoked.
  const result = await checkAgentStartGuard('/tmp/x', '127.0.0.1', 8444, {
    readPid: () => null,
  });
  assert.equal(result.ok, true);
});

// ─── isDirectEntry ───────────────────────────────────────────────

test('isDirectEntry is true when index.js itself is the entry point', async () => {
  const dir = await makeTmpDir();
  const entry = join(dir, 'index.js');
  await writeFile(entry, 'export {}');
  const url = pathToFileURL(entry).href;
  assert.equal(isDirectEntry(entry, url), true);
  await rm(dir, { recursive: true, force: true });
});

test('isDirectEntry is false when cli.js is the entry point', async () => {
  const dir = await makeTmpDir();
  const indexPath = join(dir, 'index.js');
  const cliPath = join(dir, 'cli.js');
  await writeFile(indexPath, 'export {}');
  await writeFile(cliPath, 'export {}');
  const url = pathToFileURL(indexPath).href;
  assert.equal(isDirectEntry(cliPath, url), false);
  await rm(dir, { recursive: true, force: true });
});

test('isDirectEntry resolves symlinks (npm bin shim case)', {
  skip: process.platform === 'win32',
}, async () => {
  const dir = await makeTmpDir();
  const real = join(dir, 'cli.js');
  const link = join(dir, 'tired-agent');
  await writeFile(real, 'export {}');
  const { symlinkSync } = await import('node:fs');
  symlinkSync(real, link);
  const indexPath = join(dir, 'index.js');
  await writeFile(indexPath, 'export {}');
  const url = pathToFileURL(indexPath).href;
  // argv[1] is the symlink (like ~/.npm-global/bin/tired-agent); it must
  // NOT be treated as a direct entry for index.js.
  assert.equal(isDirectEntry(link, url), false);
  // A symlink pointing at index.js itself IS a direct entry.
  const indexLink = join(dir, 'bin-index');
  symlinkSync(indexPath, indexLink);
  assert.equal(isDirectEntry(indexLink, url), true);
  await rm(dir, { recursive: true, force: true });
});

test('isDirectEntry is false when argv[1] is missing', () => {
  assert.equal(isDirectEntry(undefined, 'file:///x/index.js'), false);
});

// ─── Port occupant parsing ───────────────────────────────────────

const NETSTAT_SAMPLE = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040',
  '  TCP    0.0.0.0:8444           0.0.0.0:0              LISTENING       5678',
  '  TCP    [::]:8444              [::]:0                 LISTENING       5678',
  '',
].join('\n');

test('parseNetstatPort finds the listening PID for a port', () => {
  assert.equal(parseNetstatPort(NETSTAT_SAMPLE, 8444), 'PID 5678');
  assert.equal(parseNetstatPort(NETSTAT_SAMPLE, 135), 'PID 1040');
});

test('parseNetstatPort returns null when the port is not listening', () => {
  assert.equal(parseNetstatPort(NETSTAT_SAMPLE, 9999), null);
});

const LSOF_SAMPLE = [
  'COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'node    12345 alice  20u  IPv4 54321      0t0  TCP *:8444 (LISTEN)',
  'python  22222 bob    21u  IPv6 54322      0t0  TCP *:8444 (LISTEN)',
].join('\n');

test('parseLsofPort extracts name and PID', () => {
  assert.equal(parseLsofPort(LSOF_SAMPLE, 8444), 'node (PID 12345)');
});

test('parseLsofPort returns null for an absent port', () => {
  assert.equal(parseLsofPort(LSOF_SAMPLE, 9999), null);
});

const SS_SAMPLE = [
  'State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port   Process',
  'LISTEN  0       128     0.0.0.0:8444         0.0.0.0:*           users:(("node",pid=12345,fd=10))',
].join('\n');

test('parseSsPort extracts process name and PID', () => {
  assert.equal(parseSsPort(SS_SAMPLE, 8444), 'node (PID 12345)');
});

test('parseSsPort returns null for an absent port', () => {
  assert.equal(parseSsPort(SS_SAMPLE, 9999), null);
});
