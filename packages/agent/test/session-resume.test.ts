/**
 * Regression tests for claudeSessionId being mirrored into the session's
 * `extra` map.
 *
 * Reported bug: the mobile client reads resume metadata from
 * `extra.claudeSessionId`, but the server only ever wrote the top-level
 * `claudeSessionId` field — so resume fell through to the label and Claude
 * could not restore the historical context.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStorage } from '../src/session/storage.js';
import { SessionManager } from '../src/session/manager.js';
import { createDirectoryStore } from '../src/directory/store.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

/** Cross-platform shell command that exits immediately. */
function shell(): { cmd: string; args: string[] } {
  return process.platform === 'win32'
    ? { cmd: 'cmd.exe', args: ['/c', 'exit 0'] }
    : { cmd: 'sh', args: ['-c', 'exit 0'] };
}

async function makeManager() {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-resume-'));
  const storage = createFileStorage(dataDir);
  await storage.init();
  const store = createDirectoryStore(dataDir);
  await store.init();
  const manager = new SessionManager(storage, store);
  return { storage, store, manager, close: () => storage.close() };
}

test('create with --resume <uuid> mirrors claudeSessionId into extra', async (t) => {
  const { manager, close } = await makeManager();
  t.after(() => close());

  const base = shell();
  const session = await manager.create({
    cmd: base.cmd,
    args: [...base.args, '--resume', SESSION_ID],
    mode: 'process',
  });

  assert.equal(session.claudeSessionId, SESSION_ID, 'top-level field set');
  assert.equal(
    (session.extra?.['claudeSessionId'] as string | undefined),
    SESSION_ID,
    'extra.claudeSessionId mirrored so the mobile client can resume',
  );
});

test('create with --resume <non-uuid> does not set claudeSessionId', async (t) => {
  const { manager, close } = await makeManager();
  t.after(() => close());

  const base = shell();
  const session = await manager.create({
    cmd: base.cmd,
    args: [...base.args, '--resume', 'not-a-session-id'],
    mode: 'process',
  });

  assert.equal(session.claudeSessionId, null);
  assert.equal(session.extra?.['claudeSessionId'], undefined);
});
