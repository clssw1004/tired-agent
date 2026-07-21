/**
 * DirectoryStore — persistent JSON-backed storage for the user's
 * favorite + recent directory shortcuts.
 *
 * ## Layout
 *
 *   <dataDir>/
 *     directories.json   <- { favorites, recent }
 *     directories.json.tmp <- in-flight write, renamed on success
 *
 * ## Concurrency
 *
 * All mutating operations (`addFavorite`, `removeFavorite`, `recordRecent`)
 * are queued through a single promise chain so two concurrent callers
 * cannot interleave their writes and corrupt the JSON file. Reads
 * (`getShortcuts`) are not queued because they don't mutate the snapshot
 * the chain sees — they always operate on the most recent committed
 * in-memory copy.
 *
 * ## Path normalization
 *
 * Every input path passed to `addFavorite` or `recordRecent` is first
 * normalized via `path.resolve`, which:
 *   - converts relative paths to absolute paths (anchored at cwd);
 *   - collapses `..` and `.` segments;
 *   - normalizes path separators on Windows (`/` → `\`).
 *
 * On top of that, Windows filesystems are case-insensitive, so duplicate
 * detection compares paths via a key that is the original path on POSIX
 * and the lowercased path on Windows. The stored `path` field preserves
 * the normalized absolute path (not the raw caller input), ensuring that
 * "C:\Foo", "c:\foo", and "C:/foo" all collapse to a single record.
 *
 * ## Failure recovery
 *
 * If `directories.json` exists but contains invalid JSON, the store logs
 * a warning and starts from an empty dataset. This matches the project's
 * general philosophy that a single corrupted user data file must never
 * prevent the agent from booting.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { DirectoryFavorite, RecentDirectory } from '@tired-agent/protocol';
import { log } from '../util/log.js';
import type {
  DirectoryData,
  DirectoryShortcuts,
  DirectoryStore,
} from './types.js';

const FILE_NAME = 'directories.json';
const TMP_SUFFIX = '.tmp';
const RECENT_LIMIT = 10;

// ─── Public factory ───────────────────────────────────────────────────

export function createDirectoryStore(dataDir: string): DirectoryStore {
  const filePath = join(dataDir, FILE_NAME);
  const tmpPath = filePath + TMP_SUFFIX;

  // Internal state — only mutated inside `writeChain` to keep it consistent.
  let state: DirectoryData = { favorites: [], recent: [] };
  let initialized = false;

  // Serialize all writes through this chain so concurrent callers do not
  // race on the file. The chain is started in init() and reused thereafter.
  let writeChain: Promise<void> = Promise.resolve();

  // ─── Public methods ────────────────────────────────────────────────

  async function init(): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    state = await loadFromDisk(filePath);
    initialized = true;
  }

  function getShortcuts(): Promise<DirectoryShortcuts> {
    // Defensive copy so callers can't mutate the store's internal arrays.
    return Promise.resolve({
      favorites: state.favorites.map((f) => ({ ...f })),
      recent: state.recent.map((r) => ({ ...r })),
    });
  }

  function addFavorite(path: string, name?: string): Promise<DirectoryFavorite> {
    return schedule(async () => {
      assertInitialized();
      const normalized = resolve(path);
      const key = normalizeKey(normalized);
      const existing = state.favorites.find((f) => normalizeKey(f.path) === key);
      const resolvedName = name?.trim()
        ? name.trim()
        : deriveDefaultName(normalized);
      if (existing) {
        existing.name = resolvedName;
        existing.path = normalized;
        await persist();
        return { ...existing };
      }
      const favorite: DirectoryFavorite = {
        id: randomUUID(),
        name: resolvedName,
        path: normalized,
      };
      state.favorites.push(favorite);
      await persist();
      return { ...favorite };
    });
  }

  function removeFavorite(id: string): Promise<boolean> {
    return schedule(async () => {
      assertInitialized();
      const idx = state.favorites.findIndex((f) => f.id === id);
      if (idx === -1) {
        await persist();
        return false;
      }
      state.favorites.splice(idx, 1);
      await persist();
      return true;
    });
  }

  function recordRecent(path: string): Promise<void> {
    return schedule(async () => {
      assertInitialized();
      const normalized = resolve(path);
      const key = normalizeKey(normalized);
      const now = Date.now();
      const idx = state.recent.findIndex((r) => normalizeKey(r.path) === key);
      // When the path already exists, reuse its stored casing so the user
      // sees a consistent display regardless of which case variant they
      // happened to pass this time. Then refresh lastUsedAt and move to head.
      const storedPath = idx !== -1 ? state.recent[idx]!.path : normalized;
      if (idx !== -1) {
        state.recent.splice(idx, 1);
      }
      const entry: RecentDirectory = { path: storedPath, lastUsedAt: now };
      state.recent.unshift(entry);
      if (state.recent.length > RECENT_LIMIT) {
        state.recent.length = RECENT_LIMIT;
      }
      await persist();
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────

  function schedule<T>(task: () => Promise<T>): Promise<T> {
    // Queue the task behind whatever is already pending. We swallow errors
    // inside the chain so one failure does not poison subsequent writes —
    // but the task itself receives the error through its own returned
    // promise so the caller can react.
    const next: Promise<unknown> = writeChain.then(task, task);
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }

  function assertInitialized(): void {
    if (!initialized) {
      throw new Error('DirectoryStore: init() must be called before use');
    }
  }

  async function persist(): Promise<void> {
    const snapshot: DirectoryData = {
      favorites: state.favorites.map((f) => ({ ...f })),
      recent: state.recent.map((r) => ({ ...r })),
    };
    await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  return {
    init,
    getShortcuts,
    addFavorite,
    removeFavorite,
    recordRecent,
  };
}

// ─── Pure helpers (exported for testing) ──────────────────────────────

/** Normalize a path for duplicate-detection only. POSIX keeps the path as-is. */
export function normalizeKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function deriveDefaultName(path: string): string {
  const base = basename(path);
  if (base && base.length > 0) return base;
  return path;
}

async function loadFromDisk(filePath: string): Promise<DirectoryData> {
  if (!existsSync(filePath)) {
    return { favorites: [], recent: [] };
  }
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    log.warn(
      { err, filePath },
      'directories.json could not be read; starting with empty shortcuts',
    );
    return { favorites: [], recent: [] };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DirectoryData>;
    return sanitize(parsed);
  } catch (err) {
    log.warn(
      { err, filePath },
      'directories.json is corrupt; starting with empty shortcuts',
    );
    return { favorites: [], recent: [] };
  }
}

function sanitize(raw: Partial<DirectoryData> | undefined): DirectoryData {
  const favorites = Array.isArray(raw?.favorites)
    ? raw!.favorites.filter(
        (f): f is DirectoryFavorite =>
          !!f &&
          typeof f.id === 'string' &&
          typeof f.name === 'string' &&
          typeof f.path === 'string',
      )
    : [];
  const recent = Array.isArray(raw?.recent)
    ? raw!.recent.filter(
        (r): r is RecentDirectory =>
          !!r &&
          typeof r.path === 'string' &&
          typeof r.lastUsedAt === 'number',
      )
    : [];
  return { favorites, recent };
}
