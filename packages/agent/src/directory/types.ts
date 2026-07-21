/**
 * Directory domain types — server-internal contracts for browsing the
 * filesystem and persisting user's directory shortcuts.
 *
 * Wire-level types (DirectoryListing, DirectoryFavorite, etc.) live in
 * @tired-agent/protocol. The interfaces here describe the agent-side
 * services that produce / consume those wire types.
 */

import type {
  DirectoryFavorite,
  DirectoryListing,
  DirectoryShortcuts,
  RecentDirectory,
} from '@tired-agent/protocol';

export type { DirectoryFavorite, DirectoryListing, DirectoryShortcuts, RecentDirectory };

/** Snapshot of the persisted directories.json file. */
export interface DirectoryData {
  favorites: DirectoryFavorite[];
  recent: RecentDirectory[];
}

/**
 * Persistent store for the user's directory shortcuts.
 *
 * Backed by a JSON file at `<dataDir>/directories.json` written atomically
 * (tmp + rename). Writes are serialised through an internal promise chain
 * so concurrent callers cannot interleave partial updates.
 *
 * The store keeps two collections:
 *   - favorites: user-pinned directories, deduplicated by normalized path.
 *   - recent:    most-recently-used directories (cap = 10), MRU first.
 */
export interface DirectoryStore {
  /** Load (or create) the data file. Safe to call multiple times. */
  init(): Promise<void>;

  /** Return a defensive copy of favorites + recents. */
  getShortcuts(): Promise<DirectoryShortcuts>;

  /**
   * Persist a new favorite.
   *
   * If a favorite already exists for the same normalized path, it is
   * overwritten (id kept, name updated if provided). The path is normalized
   * before storage; on Windows the comparison key is lowercased so the
   * store treats `C:\foo` and `c:\foo` as the same directory.
   */
  addFavorite(path: string, name?: string): Promise<DirectoryFavorite>;

  /**
   * Remove a favorite by id. Returns true if a favorite was removed,
   * false if no favorite matched the id.
   */
  removeFavorite(id: string): Promise<boolean>;

  /**
   * Record a directory as recently used. Deduplicates by normalized path
   * (moves the existing entry to the head), caps the list at 10 entries,
   * and updates `lastUsedAt` to now.
   */
  recordRecent(path: string): Promise<void>;
}

/**
 * Filesystem browsing service used by the directory routes.
 *
 * Provides list + validate operations. Errors raised here are surfaced
 * directly to the route layer, which maps them to the appropriate
 * ErrorResponse code (DIRECTORY_NOT_FOUND / DIRECTORY_ACCESS_DENIED /
 * NOT_A_DIRECTORY).
 */
export interface DirectoryService {
  /**
   * List the immediate child directories of `path` (or the injected
   * home directory when omitted). Files are excluded. The result
   * includes the requested path and its parent (null at filesystem root).
   */
  list(path?: string): Promise<DirectoryListing>;

  /**
   * Verify that `path` exists, is a directory, and is accessible.
   * Throws on any failure — does not enforce the home root.
   */
  validateDirectory(path: string): Promise<void>;
}
