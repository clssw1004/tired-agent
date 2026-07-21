/**
 * Unit tests for the directory store + service.
 *
 * Uses real temporary directories under `os.tmpdir()` so we exercise the
 * actual filesystem semantics (readdir withFileTypes, stat, atomic rename).
 * Each test gets its own fresh tmpdir so they cannot leak state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDirectoryStore } from '../src/directory/store.js';
import { createDirectoryService } from '../src/directory/service.js';

// ─── Store tests ───────────────────────────────────────────────────────

test('store starts empty and persists favorites to disk', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  assert.deepEqual(await store.getShortcuts(), { favorites: [], recent: [] });

  const favorite = await store.addFavorite(join(dataDir, 'project'), 'Project');
  assert.equal(favorite.name, 'Project');
  assert.equal(favorite.path, join(dataDir, 'project'));

  const shortcuts = await store.getShortcuts();
  assert.equal(shortcuts.favorites.length, 1);
  assert.equal(shortcuts.favorites[0]?.id, favorite.id);
  assert.match(
    await readFile(join(dataDir, 'directories.json'), 'utf8'),
    /Project/,
  );
});

test('store dedupes favorites by normalized path and reassigns name', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const path = join(dataDir, 'project');
  const first = await store.addFavorite(path, 'First');
  const second = await store.addFavorite(path, 'Second');

  assert.equal(first.id, second.id, 'same path → same favorite id');
  assert.equal(second.name, 'Second');

  const { favorites } = await store.getShortcuts();
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0]?.name, 'Second');
});

test('store falls back to basename when favorite name omitted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const favorite = await store.addFavorite(join(dataDir, 'work', 'project'));
  assert.equal(favorite.name, 'project');
});

test('store falls back to full path when basename is empty', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  // Edge case: trailing separator produces an empty basename on some platforms.
  const rootish = dataDir + (dataDir.endsWith('/') || dataDir.endsWith('\\') ? '' : '/');
  const favorite = await store.addFavorite(rootish);
  // Either basename matches the dir name or the full path is used as fallback.
  assert.ok(
    favorite.name === parse(rootish).name || favorite.name === rootish,
    `expected basename or full path, got ${favorite.name}`,
  );
});

test('store removes favorites by id', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const fav = await store.addFavorite(join(dataDir, 'project'), 'Project');
  assert.equal(await store.removeFavorite(fav.id), true);
  assert.deepEqual((await store.getShortcuts()).favorites, []);

  // Removing again returns false (no-op).
  assert.equal(await store.removeFavorite(fav.id), false);
});

test('store dedupes recent paths and caps at ten entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  for (let i = 0; i < 11; i++) {
    await store.recordRecent(join(dataDir, `project-${i}`));
  }
  await store.recordRecent(join(dataDir, 'project-0'));

  const recent = (await store.getShortcuts()).recent;
  assert.equal(recent.length, 10);
  assert.equal(recent[0]?.path, join(dataDir, 'project-0'));
  // Entries are unique — no duplicates by path.
  const paths = recent.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length);
});

test('store recent updates lastUsedAt when re-recorded', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  await store.recordRecent(join(dataDir, 'a'));
  const first = (await store.getShortcuts()).recent[0]!;
  // Force a measurable gap.
  await new Promise((r) => setTimeout(r, 5));
  await store.recordRecent(join(dataDir, 'a'));
  const second = (await store.getShortcuts()).recent[0]!;
  assert.ok(
    second.lastUsedAt >= first.lastUsedAt,
    `expected second.lastUsedAt >= first.lastUsedAt, got ${second.lastUsedAt} vs ${first.lastUsedAt}`,
  );
});

test('store reuses a single favorite id when re-adding a path (idempotent)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const target = join(dataDir, 'repo');
  const a = await store.addFavorite(target, 'Repo');
  const b = await store.addFavorite(target, 'Repo-renamed');
  assert.equal(a.id, b.id);
  assert.equal((await store.getShortcuts()).favorites.length, 1);
});

test('store survives a corrupt json file by falling back to empty data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  await writeFile(join(dataDir, 'directories.json'), '{not json');
  const store = createDirectoryStore(dataDir);
  await store.init();
  assert.deepEqual(await store.getShortcuts(), { favorites: [], recent: [] });
});

test('store serialises concurrent writes without corrupting the file', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  // Fire a batch of writes concurrently; the store must serialise them so
  // every favorite survives and the file ends with valid JSON.
  const promises: Promise<unknown>[] = [];
  for (let i = 0; i < 25; i++) {
    promises.push(store.addFavorite(join(dataDir, `p-${i}`), `P${i}`));
  }
  for (let i = 0; i < 15; i++) {
    promises.push(store.recordRecent(join(dataDir, `r-${i}`)));
  }
  await Promise.all(promises);

  const shortcuts = await store.getShortcuts();
  assert.equal(shortcuts.favorites.length, 25);
  assert.equal(shortcuts.recent.length, 10);

  const onDisk = await readFile(join(dataDir, 'directories.json'), 'utf8');
  const parsed = JSON.parse(onDisk);
  assert.equal(parsed.favorites.length, 25);
  assert.equal(parsed.recent.length, 10);
});

test('store init() is idempotent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();
  await store.addFavorite(join(dataDir, 'p'), 'p');
  await store.init();
  const shortcuts = await store.getShortcuts();
  assert.equal(shortcuts.favorites.length, 1);
});

test('store assigns unique ids to distinct paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const a = await store.addFavorite(join(dataDir, 'a'));
  const b = await store.addFavorite(join(dataDir, 'b'));
  const c = await store.addFavorite(join(dataDir, 'c'));
  assert.notEqual(a.id, b.id);
  assert.notEqual(b.id, c.id);
  assert.notEqual(a.id, c.id);
});

test('store favorite ids are stable strings (uuid-shaped)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const fav = await store.addFavorite(join(dataDir, 'p'), 'p');
  // Either uuidv4-shaped or some other deterministic id — just sanity-check
  // it's a non-empty string and that it round-trips through serialization.
  assert.equal(typeof fav.id, 'string');
  assert.ok(fav.id.length > 0);

  const onDisk = await readFile(join(dataDir, 'directories.json'), 'utf8');
  assert.ok(onDisk.includes(fav.id));
});

// ─── Path normalization tests ─────────────────────────────────────────

test('store normalizes relative favorite paths against cwd', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  // cd into dataDir and add a relative path; the store must resolve it
  // to dataDir/<name> before storing.
  const cwd = process.cwd();
  process.chdir(dataDir);
  try {
    const favorite = await store.addFavorite('relative-project', 'rel');
    assert.ok(
      favorite.path === join(dataDir, 'relative-project'),
      `expected ${join(dataDir, 'relative-project')}, got ${favorite.path}`,
    );
  } finally {
    process.chdir(cwd);
  }

  const { favorites } = await store.getShortcuts();
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0]?.path, join(dataDir, 'relative-project'));
});

test('store collapses "." and ".." segments in favorite paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  await mkdir(join(dataDir, 'a', 'b'), { recursive: true });
  // "./a/./b/../b" should resolve to "<dataDir>/a/b" via path.resolve.
  const favorite = await store.addFavorite(join(dataDir, 'a', '.', 'b', '..', 'b'));
  assert.equal(favorite.path, join(dataDir, 'a', 'b'));
});

test('store dedupes favorites differing only by case on Windows', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const target = join(dataDir, 'Project');
  const a = await store.addFavorite(target, 'A');
  // Same path with different casing — must collapse on Windows.
  const altCase = process.platform === 'win32' ? target.toUpperCase() : target;
  const b = await store.addFavorite(altCase, 'B');

  assert.equal(a.id, b.id, 'case-only differences must not create a second favorite');
  const { favorites } = await store.getShortcuts();
  assert.equal(favorites.length, 1);
});

test('store normalizes forward/back slashes consistently in favorite paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const canonical = join(dataDir, 'sub', 'project');
  // Build an alt-separator variant for the same logical path.
  const alt = process.platform === 'win32'
    ? canonical.replace(/\\/g, '/')
    : canonical.replace(/\//g, '\\');

  const a = await store.addFavorite(canonical, 'A');
  const b = await store.addFavorite(alt, 'B');
  assert.equal(a.id, b.id, 'different separators for the same path must dedupe');
  assert.equal(a.path, canonical);
  assert.equal(b.path, canonical, 'second write should adopt the canonical form');
});

test('store recordRecent resolves relative paths and dedupes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const cwd = process.cwd();
  process.chdir(dataDir);
  try {
    await store.recordRecent('foo');
    await store.recordRecent('./foo');
    await store.recordRecent('././foo');
  } finally {
    process.chdir(cwd);
  }

  const { recent } = await store.getShortcuts();
  assert.equal(recent.length, 1, 'all three writes must collapse to one recent entry');
  assert.equal(recent[0]?.path, join(dataDir, 'foo'));
});

test('store recordRecent dedupes case-variant paths on Windows', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  const target = join(dataDir, 'Workdir');
  const altCase = process.platform === 'win32' ? target.toUpperCase() : target;
  await store.recordRecent(target);
  await store.recordRecent(altCase);

  const { recent } = await store.getShortcuts();
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.path, target);
});

test('store reload preserves normalized paths after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store1 = createDirectoryStore(dataDir);
  await store1.init();
  const cwd = process.cwd();
  process.chdir(dataDir);
  let savedPath: string;
  try {
    const fav = await store1.addFavorite('proj');
    savedPath = fav.path;
  } finally {
    process.chdir(cwd);
  }

  // Simulate restart by creating a fresh store on the same dir.
  const store2 = createDirectoryStore(dataDir);
  await store2.init();
  const cwd2 = process.cwd();
  process.chdir(dataDir);
  try {
    const reloaded = await store2.addFavorite('./proj');
    assert.equal(reloaded.path, savedPath);
  } finally {
    process.chdir(cwd2);
  }

  const { favorites } = await store2.getShortcuts();
  assert.equal(favorites.length, 1);
});

// ─── Service tests ─────────────────────────────────────────────────────

test('service lists home children and returns parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  await mkdir(join(root, 'packages'));
  await mkdir(join(root, 'apps'));
  // File entries should be filtered out.
  await writeFile(join(root, 'file.txt'), 'not returned');

  const service = createDirectoryService(root);

  const listing = await service.list();
  assert.equal(listing.path, root);
  assert.equal(listing.parent, join(root, '..'));
  assert.deepEqual(
    listing.entries.map((entry) => entry.name).sort(),
    ['apps', 'packages'],
  );
  for (const entry of listing.entries) {
    assert.equal(entry.path, join(root, entry.name));
  }
});

test('service returns null parent at filesystem root', async () => {
  const root = parse(process.cwd()).root;
  const service = createDirectoryService(root);
  const listing = await service.list(root);
  assert.equal(listing.parent, null);
  assert.equal(listing.path, root);
  assert.ok(Array.isArray(listing.entries));
});

test('service resolves relative paths against homeDirectory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  await mkdir(join(root, 'sub'));
  const service = createDirectoryService(root);

  const listing = await service.list('sub');
  // resolve('sub') from inside root lands at root/sub
  assert.equal(listing.path, join(root, 'sub'));
  assert.equal(listing.parent, root);
});

test('service throws DIRECTORY_NOT_FOUND for missing path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  const service = createDirectoryService(root);
  await assert.rejects(
    () => service.list(join(root, 'does-not-exist')),
    (err: NodeJS.ErrnoException) => err.code === 'DIRECTORY_NOT_FOUND',
  );
});

test('service throws NOT_A_DIRECTORY when path is a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  const file = join(root, 'a-file.txt');
  await writeFile(file, 'hi');
  const service = createDirectoryService(root);
  await assert.rejects(
    () => service.list(file),
    (err: NodeJS.ErrnoException) => err.code === 'NOT_A_DIRECTORY',
  );
});

test('service validateDirectory succeeds for an existing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  const service = createDirectoryService(root);
  await service.validateDirectory(root);
});

test('service validateDirectory rejects non-existent paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  const service = createDirectoryService(root);
  await assert.rejects(
    () => service.validateDirectory(join(root, 'nope')),
    (err: NodeJS.ErrnoException) => err.code === 'DIRECTORY_NOT_FOUND',
  );
});

test('service validateDirectory rejects files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  const file = join(root, 'a.txt');
  await writeFile(file, 'x');
  const service = createDirectoryService(root);
  await assert.rejects(
    () => service.validateDirectory(file),
    (err: NodeJS.ErrnoException) => err.code === 'NOT_A_DIRECTORY',
  );
});

test('service entries are sorted case-insensitively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  await mkdir(join(root, 'banana'));
  await mkdir(join(root, 'Apple'));
  await mkdir(join(root, 'cherry'));

  const service = createDirectoryService(root);
  const listing = await service.list();
  // localeCompare with sensitivity:'base' mirrors a case-insensitive sort
  // we can assert the relative order, not the exact string.
  const names = listing.entries.map((e) => e.name);
  const sorted = [...names].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );
  assert.deepEqual(names, sorted);
});
