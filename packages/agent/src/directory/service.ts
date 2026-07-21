/**
 * DirectoryService — filesystem browser used by the agent's directory
 * routes. Lists immediate child directories and validates paths before
 * the route layer accepts them.
 *
 * ## Error mapping
 *
 * Every filesystem error is mapped to a stable `code` string that the
 * route layer translates 1:1 into the wire-protocol's ErrorResponse.
 * Codes:
 *   - DIRECTORY_NOT_FOUND      — ENOENT
 *   - DIRECTORY_ACCESS_DENIED  — EACCES / EPERM
 *   - NOT_A_DIRECTORY          — ENOTDIR
 *
 * Unknown errno codes fall through as the raw error so callers can
 * still surface them in logs.
 *
 * ## Home root
 *
 * `createDirectoryService(homeDirectory)` accepts an explicit root used
 * when `list()` is called without arguments. This makes the service
 * trivially testable (no real `os.homedir()` coupling) and lets the
 * agent start with a configurable browsing root.
 *
 * `validateDirectory()` does NOT enforce the home root — any accessible
 * directory is considered valid. The route layer is free to apply
 * additional policy on top.
 */

import { stat, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, isAbsolute, resolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import type {
  DirectoryEntry,
  DirectoryListing,
} from '@tired-agent/protocol';
import type { DirectoryService } from './types.js';

export function createDirectoryService(
  homeDirectory: string = homedir(),
): DirectoryService {
  const root = resolve(homeDirectory);

  async function list(path?: string): Promise<DirectoryListing> {
    // Path resolution rules:
    //   - omitted → use the injected homeDirectory
    //   - absolute → use as-is
    //   - relative → resolve against the homeDirectory (not cwd), so the
    //     UI can browse "down" without knowing where the daemon started.
    const target = path == null
      ? root
      : isAbsolute(path)
        ? resolve(path)
        : resolve(root, path);

    let entries: Dirent[];
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (err) {
      throw mapFsError(err, target);
    }

    const dirs: string[] = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    dirs.sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );

    const parent = computeParent(target);

    return {
      path: target,
      parent,
      entries: dirs.map<DirectoryEntry>((name) => ({
        name,
        path: pathJoin(target, name),
      })),
    };
  }

  async function validateDirectory(path: string): Promise<void> {
    const target = isAbsolute(path) ? path : resolve(path);
    let stats;
    try {
      stats = await stat(target);
    } catch (err) {
      throw mapFsError(err, target);
    }
    if (!stats.isDirectory()) {
      const err: NodeJS.ErrnoException = new Error(
        `Not a directory: ${target}`,
      );
      err.code = 'NOT_A_DIRECTORY';
      throw err;
    }
  }

  return { list, validateDirectory };
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * `path.dirname('/')` returns '/', so we cannot rely on equality to
 * detect "at the filesystem root". We compare the resolved parent
 * against the input — if they're equal, we're at the root and should
 * return `null`.
 */
function computeParent(currentPath: string): string | null {
  const parent = dirname(currentPath);
  if (parent === currentPath) return null;
  return parent;
}

function mapFsError(err: unknown, target: string): NodeJS.ErrnoException {
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case 'ENOENT':
      return enriched('DIRECTORY_NOT_FOUND', `Directory not found: ${target}`, e);
    case 'EACCES':
    case 'EPERM':
      return enriched(
        'DIRECTORY_ACCESS_DENIED',
        `Permission denied: ${target}`,
        e,
      );
    case 'ENOTDIR':
      return enriched('NOT_A_DIRECTORY', `Not a directory: ${target}`, e);
    default:
      return e;
  }
}

function enriched(
  code: string,
  message: string,
  cause: NodeJS.ErrnoException,
): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  // Preserve the underlying cause for log inspection without polluting the message.
  (err as NodeJS.ErrnoException & { cause?: unknown }).cause = cause;
  return err;
}
