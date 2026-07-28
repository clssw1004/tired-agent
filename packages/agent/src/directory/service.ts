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
import { createReadStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, resolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import type {
  ClaudeProjectInfo,
  ClaudeProjectSession,
  DirectoryEntry,
  DirectoryListing,
} from '@tired-agent/protocol';
import type { DirectoryService } from './types.js';
import { encodeClaudeProjectPath } from './claude-path.js';

/**
 * Walk the last ~100KB of a .jsonl file for a human-readable display name.
 *
 * Priority: `aiTitle` > `agent-name` > `custom-title`. Returns null when
 * none of these events are found in the tail window.
 */
async function readJsonlDisplayName(
  filePath: string,
  tailBytes = 100 * 1024,
): Promise<string | null> {
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let customTitle: string | null = null;

  try {
    const stats = await stat(filePath);
    if (stats.size === 0) return null;
    const start = Math.max(0, stats.size - tailBytes);
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8', start }),
      crlfDelay: Infinity,
    });

    const buf: string[] = [];
    for await (const line of rl) {
      if (line.length > 0) buf.push(line);
    }
    rl.close();

    // Walk backward through the tail lines.
    for (let i = buf.length - 1; i >= 0; i--) {
      const raw = buf[i];
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const t = obj['type'];
        if (t === 'ai-title' && typeof obj['aiTitle'] === 'string') {
          aiTitle ??= obj['aiTitle'] as string;
        } else if (
          t === 'agent-name' &&
          typeof obj['agentName'] === 'string'
        ) {
          agentName ??= obj['agentName'] as string;
        } else if (
          t === 'custom-title' &&
          typeof obj['content'] === 'string'
        ) {
          customTitle ??= obj['content'] as string;
        }
        if (aiTitle && agentName && customTitle) break;
      } catch {
        // skip unparseable lines
      }
    }
  } catch {
    return null;
  }

  return aiTitle ?? agentName ?? customTitle;
}

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

  async function getClaudeProjects(cwd: string): Promise<ClaudeProjectInfo> {
    const encoded = encodeClaudeProjectPath(cwd);
    const projectDir = pathJoin(homedir(), '.claude', 'projects', encoded);

    let entries: Dirent[];
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { displayPath: cwd, sessions: [] };
      }
      throw err;
    }

    const jsonlFiles = entries.filter(
      (e) => e.isFile() && e.name.endsWith('.jsonl'),
    );

    const sessions: ClaudeProjectSession[] = [];
    for (const f of jsonlFiles) {
      const sessionId = f.name.slice(0, -'.jsonl'.length);
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) continue;
      const filePath = pathJoin(projectDir, f.name);
      try {
        const stats = await stat(filePath);
        // Read the last 2KB for a human-readable label. If the file
        // doesn't contain a custom-title or slug, displayName stays null
        // and the UI falls back to the session id.
        const displayName = await readJsonlDisplayName(filePath);
        sessions.push({
          sessionId,
          lastModified: stats.mtimeMs,
          size: stats.size,
          displayName,
        });
      } catch {
        continue;
      }
    }

    sessions.sort((a, b) => b.lastModified - a.lastModified);
    return { displayPath: cwd, sessions };
  }

  return { list, validateDirectory, getClaudeProjects };
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
