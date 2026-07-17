/**
 * Storage abstraction — pluggable persistence layer for session metadata.
 *
 * Three adapters:
 *   - SqliteStorage   (default — better-sqlite3, CJS loaded via createRequire)
 *   - MysqlStorage    (via mysql2)
 *   - PostgresStorage (via pg)
 */

import { appendFileSync, statSync, readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { SessionRecord } from './types.js';
import type { SessionStatus } from '@tired-pc/protocol';

// ─── CJS require bridge for better-sqlite3 ─────────────────────────────────────
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _sqlite: any = _require('better-sqlite3');
const Database = _sqlite.default ?? _sqlite;

// ─── Interface ────────────────────────────────────────────────────────────────

export interface Storage {
  init(): Promise<void>;
  insert(session: SessionRecord): void;
  update(partial: Partial<SessionRecord> & { id: string }): void;
  list(): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  appendOutput(id: string, data: Uint8Array): number;
  readOutput(id: string, fromOffset: number, limit?: number): {
    chunks: Array<{ offset: number; data: Uint8Array }>;
    upTo: number;
  };
  close(): Promise<void>;
}

// ─── SqliteStorage ─────────────────────────────────────────────────────────────

export function createSqliteStorage(dataDir: string): Storage {
  const dbPath = join(dataDir, 'tired-pc.db');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _db: any = null;

  function db(): import('better-sqlite3').Database {
    if (_db) return _db;
    _db = new Database(`${dbPath}.sqlite`);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        cmd         TEXT NOT NULL,
        args        TEXT NOT NULL,
        cwd         TEXT,
        env         TEXT,
        status      TEXT NOT NULL DEFAULT 'starting',
        pid         INTEGER,
        exitCode    INTEGER,
        createdAt   INTEGER NOT NULL,
        exitedAt    INTEGER,
        byteOffset  INTEGER NOT NULL DEFAULT 0,
        cols        INTEGER NOT NULL DEFAULT 80,
        rows        INTEGER NOT NULL DEFAULT 24,
        label       TEXT
      );
    `);
    return _db;
  }

  async function init() {
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    db(); // trigger schema creation
  }

  function insert(s: SessionRecord) {
    db().prepare(`
      INSERT INTO sessions (id,cmd,args,cwd,env,status,pid,exitCode,createdAt,exitedAt,byteOffset,cols,rows,label)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      s.id, s.cmd, JSON.stringify(s.args), s.cwd,
      s.env ? JSON.stringify(s.env) : null, s.status,
      s.pid, s.exitCode, s.createdAt, s.exitedAt,
      s.byteOffset, s.cols, s.rows, s.label,
    );
  }

  function update(partial: Partial<SessionRecord> & { id: string }) {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(partial)) {
      if (k === 'id') continue;
      fields.push(`${k}=?`);
      values.push(k === 'args' || k === 'env' ? JSON.stringify(v) : v);
    }
    if (!fields.length) return;
    values.push(partial.id);
    db().prepare(`UPDATE sessions SET ${fields.join(',')} WHERE id=?`).run(...values);
  }

  function list(): SessionRecord[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return db().prepare('SELECT * FROM sessions ORDER BY createdAt DESC').all().map((r: any) => deserialize(r));
  }

  function get(id: string): SessionRecord | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = db().prepare('SELECT * FROM sessions WHERE id=?').get(id);
    return r ? deserialize(r) : undefined;
  }

  function appendOutput(id: string, data: Uint8Array): number {
    const logPath = join(dataDir, 'sessions', `${id}.log`);
    appendFileSync(logPath, Buffer.from(data));
    const size = statSync(logPath).size;
    update({ id, byteOffset: size });
    return size;
  }

  function readOutput(id: string, fromOffset: number, limit?: number) {
    const logPath = join(dataDir, 'sessions', `${id}.log`);
    if (!existsSync(logPath)) return { chunks: [], upTo: 0 };
    const total = statSync(logPath).size;
    const remaining = total - fromOffset;
    if (remaining <= 0) return { chunks: [], upTo: total };
    const toRead = limit != null ? Math.min(remaining, limit) : remaining;
    const fullBuf = readFileSync(logPath);
    const slice = fullBuf.subarray(fromOffset, fromOffset + toRead);
    return { chunks: [{ offset: fromOffset, data: new Uint8Array(slice) }], upTo: total };
  }

  async function close() { _db?.close(); _db = null; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deserialize(r: any): SessionRecord {
    return {
      id: r['id'], cmd: r['cmd'],
      args: JSON.parse(r['args']),
      cwd: r['cwd'] ?? null,
      env: r['env'] ? JSON.parse(r['env']) : null,
      status: r['status'] as SessionStatus,
      pid: r['pid'] ?? null,
      exitCode: r['exitCode'] ?? null,
      createdAt: r['createdAt'],
      exitedAt: r['exitedAt'] ?? null,
      byteOffset: r['byteOffset'],
      cols: r['cols'], rows: r['rows'],
      label: r['label'] ?? null,
    };
  }

  return { init, insert, update, list, get, appendOutput, readOutput, close };
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

export type StorageKind = 'sqlite' | 'mysql' | 'postgres';
export interface StorageConfig {
  kind: StorageKind;
  dataDir: string;
  mysql?: MysqlConfig;
  postgres?: PostgresConfig;
}

export function createStorage(cfg: StorageConfig): Storage {
  switch (cfg.kind) {
    case 'sqlite': return createSqliteStorage(cfg.dataDir);
    case 'mysql':
      if (!cfg.mysql) throw new Error('mysql config required');
      return createMysqlStorage(cfg.mysql);
    case 'postgres':
      if (!cfg.postgres) throw new Error('postgres config required');
      return createPostgresStorage(cfg.postgres);
  }
}
