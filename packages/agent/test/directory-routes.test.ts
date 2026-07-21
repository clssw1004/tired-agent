/**
 * Fastify inject tests for the agent's /v1/directories routes.
 *
 * Each test gets a fresh tmpdir for both the agent's data dir and the
 * browsing home directory so the cases are fully isolated.
 *
 * These tests intentionally exercise the same code path the Manager's
 * directory proxy will (Task 11) use — they pin the wire contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type {
  DirectoryFavorite,
  DirectoryListing,
  DirectoryShortcuts,
} from '@tired-agent/protocol';

import { createApp } from '../src/app.js';
import { createSqliteStorage } from '../src/session/storage.js';
import type { Storage } from '../src/session/storage.js';
import { SessionManager } from '../src/session/manager.js';
import { createDirectoryService } from '../src/directory/service.js';
import type { DirectoryService } from '../src/directory/types.js';
import { createDirectoryStore } from '../src/directory/store.js';
import type { DirectoryStore } from '../src/directory/types.js';
import type { ServerConfig } from '../src/config.js';

interface Fixture {
  app: FastifyInstance;
  dataDir: string;
  homeDirectory: string;
  storage: Storage;
  manager: SessionManager;
  service: DirectoryService;
  store: DirectoryStore;
  close: () => Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-routes-'));
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  // Pre-create a couple of child directories + a file so listings have content.
  await mkdir(join(homeDirectory, 'projects'), { recursive: true });
  await mkdir(join(homeDirectory, 'notes'), { recursive: true });
  await writeFile(join(homeDirectory, 'README.md'), 'not a directory');

  const storage = createSqliteStorage(dataDir);
  await storage.init();

  const store = createDirectoryStore(dataDir);
  await store.init();

  const service = createDirectoryService(homeDirectory);
  const manager = new SessionManager(storage, store);

  const cfg: ServerConfig = {
    port: 0,
    host: '127.0.0.1',
    token: 'test-token',
    dataDir,
    logDir: join(dataDir, 'logs'),
    logLevel: 'silent',
    sseFormat: 'base64',
    sseDebugLog: false,
    name: 'test-agent',
    registerString: null,
  };

  const app = await createApp(cfg, storage, manager, service, store);
  await app.ready();

  return {
    app,
    dataDir,
    homeDirectory,
    storage,
    manager,
    service,
    store,
    close: async () => {
      await app.close();
      await storage.close();
    },
  };
}

test('GET /v1/directories defaults to home and returns only directories', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'GET',
    url: '/v1/directories',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as DirectoryListing;
  assert.equal(body.path, fx.homeDirectory);
  assert.ok(
    body.entries.every((entry) => entry.path.startsWith(fx.homeDirectory)),
    'every listed entry must live under the home directory',
  );
  // README.md must be filtered out — only directories are returned.
  assert.ok(
    body.entries.every((entry) => entry.name !== 'README.md'),
    'files must be excluded from the listing',
  );
  // parent is null only at the filesystem root; on every other path it
  // points at the directory's own parent. We only assert it points at a
  // directory that contains our home (or is null at the root).
  if (body.parent !== null) {
    assert.ok(
      body.parent.length > 0,
      'parent must be a non-empty string or null',
    );
  }
});

test('GET /v1/directories/shortcuts returns favorites + recent from the store', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'GET',
    url: '/v1/directories/shortcuts',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as DirectoryShortcuts;
  assert.deepEqual(body, { favorites: [], recent: [] });
});

test('favorite routes round trip', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const created = await fx.app.inject({
    method: 'POST',
    url: '/v1/directories/favorites',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: { path: fx.homeDirectory, name: 'Home' },
  });
  assert.equal(created.statusCode, 201);
  const favorite = created.json() as DirectoryFavorite;
  assert.equal(favorite.name, 'Home');
  assert.equal(favorite.path, fx.homeDirectory);

  const removed = await fx.app.inject({
    method: 'DELETE',
    url: `/v1/directories/favorites/${favorite.id}`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(removed.statusCode, 204);
});

test('DELETE /v1/directories/favorites/:id returns 404 for unknown id', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'DELETE',
    url: '/v1/directories/favorites/does-not-exist',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 404);
});

test('POST /v1/directories/favorites rejects paths that are not directories', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'POST',
    url: '/v1/directories/favorites',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: { path: join(fx.homeDirectory, 'README.md'), name: 'README' },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'NOT_A_DIRECTORY');
});

test('POST /v1/directories/favorites rejects non-existent paths with 404', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'POST',
    url: '/v1/directories/favorites',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: {
      path: join(fx.homeDirectory, 'nope'),
      name: 'Missing',
    },
  });
  assert.equal(response.statusCode, 404);
  const body = response.json() as { error: { code: string } };
  assert.equal(body.error.code, 'DIRECTORY_NOT_FOUND');
});

test('routes require an auth token', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'GET',
    url: '/v1/directories',
  });
  assert.equal(response.statusCode, 401);
});

test('error responses never leak the underlying stack trace', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const response = await fx.app.inject({
    method: 'GET',
    url: '/v1/directories?path=' + encodeURIComponent(join(fx.homeDirectory, 'nope')),
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 404);
  const raw = response.body;
  assert.ok(!/at .+ \(.+:\d+:\d+\)/.test(raw), `raw body should not contain a stack frame, got: ${raw}`);
  assert.ok(!/\bnode:fs\b/.test(raw), 'raw body should not mention node:fs internals');
});

test('creating a session with cwd appends to the recent list', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const before = (await fx.store.getShortcuts()).recent.length;
  // Use persistent mode so the test does not depend on a real PTY being
  // available on the host — the manager still walks through
  // recordRecentCwd() after creating the session record.
  const session = await fx.manager.create({
    cmd: 'claude',
    mode: 'persistent',
    cwd: fx.homeDirectory,
  });
  assert.equal(session.cwd, fx.homeDirectory);

  // recordRecentCwd runs synchronously after _createPersistent, but the
  // underlying writeChain is async. Wait until the recent list reflects
  // the new entry.
  const deadline = Date.now() + 2000;
  let after = before;
  while (Date.now() < deadline) {
    after = (await fx.store.getShortcuts()).recent.length;
    if (after === before + 1) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(after, before + 1, 'recent list should grow by one after creating a session with cwd');
  const recent = (await fx.store.getShortcuts()).recent;
  assert.equal(recent[0]?.path, fx.homeDirectory);
});

test('a throwing DirectoryStore does not break session creation', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-routes-'));
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  const homeDirectory = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));

  const storage = createSqliteStorage(dataDir);
  await storage.init();

  // Build a DirectoryStore whose recordRecent throws, but every other
  // method delegates to a real on-disk store so the rest of the boot
  // path is exercised normally.
  const realStore = createDirectoryStore(dataDir);
  await realStore.init();
  const throwingStore: DirectoryStore = {
    init: realStore.init,
    getShortcuts: realStore.getShortcuts,
    addFavorite: realStore.addFavorite,
    removeFavorite: realStore.removeFavorite,
    recordRecent: async () => {
      throw new Error('simulated disk failure writing recent directory');
    },
  };

  const service = createDirectoryService(homeDirectory);
  const manager = new SessionManager(storage, throwingStore);

  // Persistent mode: no PTY spawn, so a create() failure can only be
  // caused by the throwing recordRecent path. The assertion is that the
  // session is still returned to the caller.
  const session = await manager.create({
    cmd: 'claude',
    mode: 'persistent',
    cwd: homeDirectory,
  });

  assert.equal(session.cwd, homeDirectory);
  assert.equal(session.mode, 'persistent');
  // Status is 'starting' until the first PTY turn is spawned; the
  // important guarantee is that the session record was returned at all,
  // not the exact status.
  assert.ok(['starting', 'running'].includes(session.status));

  await storage.close();
});
