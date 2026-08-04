/**
 * Unit tests for the file-backed session storage.
 *
 * Uses real temporary directories under `os.tmpdir()` so we exercise the
 * actual filesystem semantics (atomic rename, append, backwards seek).
 * Each test gets its own fresh tmpdir so they cannot leak state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStorage } from '../src/session/storage.js';
import { createSessionRecord } from '../src/session/types.js';
import type { SessionRecord } from '../src/session/types.js';

async function makeStorage() {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-storage-'));
  const storage = createFileStorage(dataDir);
  await storage.init();
  return { dataDir, storage };
}

function record(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return createSessionRecord(id, { cmd: 'sh', args: ['-c', 'echo hi'], mode: 'process' });
}

test('insert/get round-trips a session and persists a JSON file on disk', async () => {
  const { dataDir, storage } = await makeStorage();
  const rec = record('s1');
  storage.insert(rec);

  assert.deepEqual(storage.get('s1'), rec);
  const files = await readdir(join(dataDir, 'sessions'));
  assert.deepEqual(files.sort(), ['s1.json']);

  const onDisk = JSON.parse(await readFile(join(dataDir, 'sessions', 's1.json'), 'utf-8'));
  assert.deepEqual(onDisk, rec);
  await storage.close();
});

test('get returns undefined for unknown ids', async () => {
  const { storage } = await makeStorage();
  assert.equal(storage.get('nope'), undefined);
  await storage.close();
});

test('update merges partial fields into the stored record', async () => {
  const { storage } = await makeStorage();
  storage.insert(record('s1'));

  storage.update({ id: 's1', status: 'running', pid: 1234 });
  const rec = storage.get('s1')!;
  assert.equal(rec.status, 'running');
  assert.equal(rec.pid, 1234);
  // Unrelated fields are preserved.
  assert.equal(rec.cmd, 'sh');

  // Updating a missing session is a no-op, not a throw.
  storage.update({ id: 'ghost', status: 'exited' });
  await storage.close();
});

test('list sorts by createdAt desc and can filter by status', async () => {
  const { storage } = await makeStorage();
  const old = record('s-old', {});
  old.createdAt = 100;
  const mid = record('s-mid', {});
  mid.createdAt = 200;
  const new_ = record('s-new', {});
  new_.createdAt = 300;
  storage.insert(old);
  storage.insert(mid);
  storage.insert(new_);

  const all = storage.list();
  assert.deepEqual(all.map((r) => r.id), ['s-new', 's-mid', 's-old']);

  storage.update({ id: 's-mid', status: 'exited' });
  const exited = storage.list('exited');
  assert.deepEqual(exited.map((r) => r.id), ['s-mid']);
  const starting = storage.list('starting');
  assert.deepEqual(starting.map((r) => r.id), ['s-new', 's-old']);
  await storage.close();
});

test('list ignores non-.json files such as output logs', async () => {
  const { storage } = await makeStorage();
  storage.insert(record('s1'));
  storage.appendOutput('s1', new TextEncoder().encode('output'));

  const all = storage.list();
  assert.deepEqual(all.map((r) => r.id), ['s1']);
  await storage.close();
});

test('appendOutput/readOutput/readOutputTail stream the append-only log', async () => {
  const { storage } = await makeStorage();
  storage.insert(record('s1'));

  const first = storage.appendOutput('s1', new TextEncoder().encode('hello '));
  const second = storage.appendOutput('s1', new TextEncoder().encode('world'));
  assert.equal(first, 6);
  assert.equal(second, 11);

  // readOutput honours offsets and optional limits.
  const from0 = storage.readOutput('s1', 0);
  assert.equal(from0.upTo, 11);
  assert.equal(new TextDecoder().decode(from0.chunks[0]!.data), 'hello world');

  const from6 = storage.readOutput('s1', 6);
  assert.equal(new TextDecoder().decode(from6.chunks[0]!.data), 'world');

  const limited = storage.readOutput('s1', 0, 5);
  assert.equal(new TextDecoder().decode(limited.chunks[0]!.data), 'hello');
  assert.equal(limited.upTo, 11);

  // readOutputTail does a backwards seek.
  const tail = storage.readOutputTail('s1', 5);
  assert.equal(tail.truncated, true);
  assert.equal(tail.upTo, 11);
  assert.equal(new TextDecoder().decode(tail.chunks[0]!.data), 'world');
  assert.equal(tail.chunks[0]!.offset, 6);

  const whole = storage.readOutputTail('s1', 100);
  assert.equal(whole.truncated, false);
  assert.equal(new TextDecoder().decode(whole.chunks[0]!.data), 'hello world');

  // byteOffset in metadata tracks the log size.
  assert.equal(storage.get('s1')!.byteOffset, 11);
  await storage.close();
});

test('delete removes the metadata file, log file, and any stale tmp file', async () => {
  const { dataDir, storage } = await makeStorage();
  storage.insert(record('s1'));
  storage.appendOutput('s1', new TextEncoder().encode('data'));

  assert.equal(storage.delete('s1'), true);
  assert.equal(storage.get('s1'), undefined);
  assert.equal(existsSync(join(dataDir, 'sessions', 's1.json')), false);
  assert.equal(existsSync(join(dataDir, 'sessions', 's1.log')), false);

  // Deleting an unknown id reports false.
  assert.equal(storage.delete('s1'), false);
  await storage.close();
});

test('pruneOlderThan removes only sessions older than the cutoff', async () => {
  const { storage } = await makeStorage();
  const now = Date.now();

  const stale = record('stale', {});
  stale.createdAt = now - 2 * 3600 * 1000;
  stale.status = 'running';
  const staleExited = record('stale-exited', {});
  staleExited.createdAt = now - 3600 * 1000;
  staleExited.status = 'exited';
  staleExited.exitedAt = now - 3600 * 1000;
  const fresh = record('fresh', {});
  fresh.createdAt = now;

  storage.insert(stale);
  storage.insert(staleExited);
  storage.insert(fresh);

  const removed = storage.pruneOlderThan(3600 * 1000);
  assert.equal(removed, 2);
  assert.equal(storage.get('stale'), undefined);
  assert.equal(storage.get('stale-exited'), undefined);
  assert.ok(storage.get('fresh'));
  await storage.close();
});

test('list is resilient to a corrupt JSON metadata file', async () => {
  const { dataDir, storage } = await makeStorage();
  storage.insert(record('good'));
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(join(dataDir, 'sessions', 'bad.json'), '{not valid json', 'utf-8'),
  );

  const all = storage.list();
  assert.deepEqual(all.map((r) => r.id), ['good']);
  await storage.close();
});
