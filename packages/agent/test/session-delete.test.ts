/**
 * Regression tests for DELETE /sessions/:id semantics.
 *
 * Reported bug: deleting an exited session does not remove it from the
 * session list immediately. Root cause: the DELETE route removed the
 * storage record but left the session in the in-memory live map, and
 * pruneStale() has a 60s grace period before it drops exited sessions —
 * so GET /sessions kept returning the deleted session.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../src/app.js';
import { createFileStorage } from '../src/session/storage.js';
import type { Storage } from '../src/session/storage.js';
import { SessionManager } from '../src/session/manager.js';
import { createDirectoryStore } from '../src/directory/store.js';
import type { DirectoryStore } from '../src/directory/types.js';
import { createDirectoryService } from '../src/directory/service.js';
import type { ServerConfig } from '../src/config.js';

interface Fixture {
  app: FastifyInstance;
  storage: Storage;
  manager: SessionManager;
  close: () => Promise<void>;
}

async function buildFixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-del-'));
  const storage = createFileStorage(dataDir);
  await storage.init();

  const store: DirectoryStore = createDirectoryStore(dataDir);
  await store.init();
  const service = createDirectoryService(dataDir);

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
    storage,
    manager,
    close: async () => {
      await app.close();
      await storage.close();
    },
  };
}

/** A command that exits immediately on both platforms. */
function quickExitSpec(): { cmd: string; args: string[] } {
  return process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/c', 'exit 0'] }
    : { cmd: 'sh', args: ['-c', 'exit 0'] };
}

/** Create a process session whose process exits immediately. */
async function createQuickExitSession(fx: Fixture): Promise<string> {
  const { cmd, args } = quickExitSpec();
  const session = await fx.manager.create({ cmd, args });
  return session.id;
}

/** Poll manager.get() until a session reports exited, or throw on timeout. */
async function waitForExited(
  fx: Fixture,
  id: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rec = fx.manager.get(id);
    if (rec && rec.status === 'exited') return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`session ${id} did not exit within ${timeoutMs}ms`);
}

test('DELETE on an exited process session removes it from the list immediately', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const id = await createQuickExitSession(fx);
  await waitForExited(fx, id);
  assert.ok(fx.manager.get(id), 'session should exist before delete');

  const del = await fx.app.inject({
    method: 'DELETE',
    url: `/api/v1/sessions/${id}`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(del.statusCode, 204);

  const list = await fx.app.inject({
    method: 'GET',
    url: '/api/v1/sessions',
    headers: { authorization: 'Bearer test-token' },
  });
  const sessions = list.json() as Array<{ id: string }>;
  assert.ok(
    !sessions.some((s) => s.id === id),
    'deleted exited session must not appear in the list immediately',
  );
});

test('manager.forget removes an exited session from the live map immediately', async (t) => {
  const fx = await buildFixture();
  t.after(() => fx.close());

  const id = await createQuickExitSession(fx);
  await waitForExited(fx, id);
  assert.ok(fx.manager.get(id), 'session should be visible in the live map');

  // DELETE 路由的完整路径：先删 storage 记录，再 forget（移除 live map）。
  // 只有两者都做，list()（storage + live 合并）才不再返回它。
  fx.storage.delete(id);
  fx.manager.forget(id);
  assert.equal(
    fx.manager.get(id),
    undefined,
    'session must be gone from manager.get() after storage.delete + forget()',
  );
});
