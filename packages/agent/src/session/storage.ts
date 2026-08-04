/**
 * Storage abstraction — pluggable persistence layer for session metadata.
 *
 * The default adapter is `createFileStorage` (kind `file`), which keeps
 * every session's metadata in a small JSON file under `sessions/`:
 *
 *   - `<id>.json` — session metadata (no external dependencies)
 *   - `<id>.log`  — append-only PTY output (unchanged)
 *
 * MySQL / Postgres adapters remain reserved placeholders (kinds `mysql`
 * / `postgres`), selected via the `STORAGE_KIND` env var.
 */

import {
  appendFileSync,
  statSync,
  readFileSync,
  existsSync,
  unlinkSync,
  openSync,
  closeSync,
  readSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRecord } from './types.js';
import type { SessionStatus } from '@tired-agent/protocol';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface Storage {
  init(): Promise<void>;
  insert(session: SessionRecord): void;
  update(partial: Partial<SessionRecord> & { id: string }): void;
  /** Permanently remove a session row + its append-only log file. */
  delete(id: string): boolean;
  list(): SessionRecord[];
  /** If status is given, only sessions matching the status are returned. */
  list(status?: SessionStatus): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  appendOutput(id: string, data: Uint8Array): number;
  readOutput(id: string, fromOffset: number, limit?: number): {
    chunks: Array<{ offset: number; data: Uint8Array }>;
    upTo: number;
  };
  /**
   * Read the last `n` bytes of the session log via a backwards seek. Used by
   * the client to land on a PTY session without paying the cost of streaming
   * the entire log file when only the tail matters. Returns `truncated=false`
   * when the whole file was returned (i.e. the log is smaller than `n`).
   */
  readOutputTail(id: string, n: number): {
    chunks: Array<{ offset: number; data: Uint8Array }>;
    upTo: number;
    truncated: boolean;
  };
  /**
   * Delete all sessions whose `exitedAt` (or, for sessions still flagged
   * `running`, their `createdAt`) is older than `olderThanMs`.
   * Returns the count removed. Used to keep the store from growing forever.
   */
  pruneOlderThan(olderThanMs: number): number;
  close(): Promise<void>;
}

// ─── FileStorage ──────────────────────────────────────────────────────────────

export function createFileStorage(dataDir: string): Storage {
  const sessionsDir = join(dataDir, 'sessions');

  function jsonPath(id: string): string {
    return join(sessionsDir, `${id}.json`);
  }
  function logPath(id: string): string {
    return join(sessionsDir, `${id}.log`);
  }

  /**
   * Atomically write a session record: write a temp file then rename over the
   * target. A crash between the two steps leaves at most a stray `.tmp` file
   * (never a corrupt `.json`), and a partially written JSON is never observed.
   */
  function writeRecord(id: string, record: SessionRecord): void {
    const target = jsonPath(id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), 'utf-8');
    renameSync(tmp, target);
  }

  async function init() {
    await mkdir(sessionsDir, { recursive: true });
  }

  function insert(s: SessionRecord) {
    writeRecord(s.id, s);
  }

  function update(partial: Partial<SessionRecord> & { id: string }) {
    const path = jsonPath(partial.id);
    if (!existsSync(path)) return;
    const current = JSON.parse(readFileSync(path, 'utf-8')) as SessionRecord;
    writeRecord(partial.id, { ...current, ...partial });
  }

  function list(status?: SessionStatus): SessionRecord[] {
    if (!existsSync(sessionsDir)) return [];
    const records: SessionRecord[] = [];
    for (const name of readdirSync(sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        records.push(
          JSON.parse(readFileSync(join(sessionsDir, name), 'utf-8')) as SessionRecord,
        );
      } catch {
        // Skip corrupt / unreadable metadata files rather than crashing the list.
      }
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    return status ? records.filter((r) => r.status === status) : records;
  }

  function get(id: string): SessionRecord | undefined {
    const path = jsonPath(id);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as SessionRecord;
    } catch {
      return undefined;
    }
  }

  function deleteSession(id: string): boolean {
    let removed = false;
    for (const p of [jsonPath(id), `${jsonPath(id)}.tmp`, logPath(id)]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
          removed = true;
        } catch {
          /* ignore */
        }
      }
    }
    return removed;
  }

  function pruneOlderThan(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let count = 0;
    for (const rec of list()) {
      const ref = rec.status === 'exited' ? rec.exitedAt : rec.createdAt;
      if (ref && ref < cutoff) {
        if (deleteSession(rec.id)) count++;
      }
    }
    return count;
  }

  function appendOutput(id: string, data: Uint8Array): number {
    const path = logPath(id);
    appendFileSync(path, Buffer.from(data));
    const size = statSync(path).size;
    update({ id, byteOffset: size });
    return size;
  }

  function readOutput(id: string, fromOffset: number, limit?: number) {
    const path = logPath(id);
    if (!existsSync(path)) return { chunks: [], upTo: 0 };
    const total = statSync(path).size;
    const remaining = total - fromOffset;
    if (remaining <= 0) return { chunks: [], upTo: total };
    const toRead = limit != null ? Math.min(remaining, limit) : remaining;
    const fullBuf = readFileSync(path);
    const slice = fullBuf.subarray(fromOffset, fromOffset + toRead);
    return { chunks: [{ offset: fromOffset, data: new Uint8Array(slice) }], upTo: total };
  }

  function readOutputTail(id: string, n: number) {
    // Backwards seek so we don't pay the cost of reading 50MB just to
    // discard 49.9MB of it. openSync + readSync is the cheapest way to do
    // this with built-ins; fs.createReadStream({start}) would also work
    // but allocates a stream + promises for a single contiguous slice.
    const path = logPath(id);
    if (!existsSync(path)) return { chunks: [], upTo: 0, truncated: false };
    const total = statSync(path).size;
    if (total <= 0 || n <= 0) return { chunks: [], upTo: total, truncated: false };
    const want = Math.min(n, total);
    const start = total - want;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(want);
      readSync(fd, buf, 0, want, start);
      return {
        chunks: [{ offset: start, data: new Uint8Array(buf) }],
        upTo: total,
        truncated: want < total,
      };
    } finally {
      closeSync(fd);
    }
  }

  async function close() {
    // Nothing to close — file storage has no long-lived handles.
  }

  return { init, insert, update, delete: deleteSession, list, get, appendOutput, readOutput, readOutputTail, pruneOlderThan, close };
}

// ─── MySQL ────────────────────────────────────────────────────────────────────

export interface MysqlConfig { host: string; port?: number; user: string; password: string; database: string; }
export function createMysqlStorage(_: MysqlConfig): Storage {
  throw new Error('MysqlStorage: implementation pending');
}

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

export interface PostgresConfig { connectionString: string; }
export function createPostgresStorage(_: PostgresConfig): Storage {
  throw new Error('PostgresStorage: implementation pending');
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export type StorageKind = 'file' | 'mysql' | 'postgres';
export interface StorageConfig {
  kind: StorageKind;
  dataDir: string;
  mysql?: MysqlConfig;
  postgres?: PostgresConfig;
}

export function createStorage(cfg: StorageConfig): Storage {
  switch (cfg.kind) {
    case 'file': return createFileStorage(cfg.dataDir);
    case 'mysql':
      if (!cfg.mysql) throw new Error('mysql config required');
      return createMysqlStorage(cfg.mysql);
    case 'postgres':
      if (!cfg.postgres) throw new Error('postgres config required');
      return createPostgresStorage(cfg.postgres);
    default:
      throw new Error(`Unknown storage kind: ${String(cfg.kind)}`);
  }
}
