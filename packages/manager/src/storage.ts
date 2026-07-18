/**
 * Storage layer for the manager.
 *
 * Two tables:
 *   - manager_agents   — registry of agents the manager can proxy to
 *   - manager_sessions — opaque session tokens issued after login
 *
 * Uses better-sqlite3 directly (no kysely yet — the surface is tiny and
 * staying close to SQL makes the schema migration story obvious).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// ─── CJS require bridge for better-sqlite3 (mirrors packages/server) ─────
// better-sqlite3 ships as CJS; under Node ESM we need createRequire.
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _sqlite: any = _require('better-sqlite3');
// The CJS export may be `.default` (when required from ESM bundlers) or
// the module itself (when required directly).
const Database = _sqlite.default ?? _sqlite;

// ─── Public types ──────────────────────────────────────────────────────────

/**
 * Row stored in the manager_agents table. `token` is the agent's own
 * admin token — kept server-side and never returned to the browser.
 */
export interface Agent {
  id: string;
  /** Agent's own persistent identity — used for dedup on re-registration. */
  agentKey: string;
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  createdAt: number;
}

/** A pending browser session after a successful login. */
export interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

export interface Storage {
  /** Provision the SQLite file + tables. Idempotent. */
  init(): Promise<void>;
  // ── agents ──
  listAgents(): Agent[];
  getAgent(id: string): Agent | undefined;
  addAgent(name: string, baseUrl: string, token: string): { id: string };
  deleteAgent(id: string): void;
  // ── auto-register ──
  /** Look up an agent by its persistent `agentKey` (for dedup). */
  findAgentByKey(agentKey: string): Agent | undefined;
  /**
   * Register (or re-register) an agent.
   *
   * When `agentKey` is provided and an agent with that key exists, the
   * entry is *updated* (baseUrl + token regenerated) — this is the
   * dedup / re-registration path.  Without `agentKey` a fresh entry
   * is created.
   */
  registerAgent(name: string, baseUrl: string, agentKey?: string): { id: string; token: string };
  // ── sessions ──
  createSession(): { token: string; expiresAt: number };
  getSession(token: string): { expiresAt: number } | undefined;
  deleteSession(token: string): void;
  /** Drop sessions that have expired. Cheap sweep called on each request. */
  pruneExpired(): number;
  /** Close the underlying SQLite handle. */
  close(): Promise<void>;
}

// ─── SQLite-backed implementation ─────────────────────────────────────────

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function createStorage(dataDir: string): Storage {
  const dbPath = join(dataDir, 'manager.sqlite');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _db: any = null;

  function db(): import('better-sqlite3').Database {
    if (_db) return _db;
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS manager_agents (
        id          TEXT PRIMARY KEY,
        agent_key   TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL,
        baseUrl     TEXT NOT NULL,
        token       TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        createdAt   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS manager_agents_agent_key ON manager_agents(agent_key);

      CREATE TABLE IF NOT EXISTS manager_sessions (
        token       TEXT PRIMARY KEY,
        createdAt   INTEGER NOT NULL,
        expiresAt   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS manager_sessions_expires
        ON manager_sessions(expiresAt);
    `);
    return _db;
  }

  async function init() {
    await mkdir(dataDir, { recursive: true });
    const handle = db(); // touch schema

    // Migration: add agent_key column for databases from v0.1.
    // The bare `try { ... } catch` is intentional — running ALTER on a
    // table that already has the column throws "duplicate column name",
    // which is the happy path for an idempotent migration.
    const hasAgentKey = handle
      .prepare("SELECT 1 FROM pragma_table_info('manager_agents') WHERE name = 'agent_key'")
      .get();
    if (!hasAgentKey) {
      handle.exec(
        `ALTER TABLE manager_agents ADD COLUMN agent_key TEXT NOT NULL DEFAULT ''`,
      );
      handle.exec(
        `CREATE INDEX IF NOT EXISTS manager_agents_agent_key ON manager_agents(agent_key)`,
      );
    }
  }

  // ── agents ──────────────────────────────────────────────────────────────

  function listAgents(): Agent[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt FROM manager_agents ORDER BY createdAt ASC')
      .all();
    return rows.map(deserializeAgent);
  }

  function getAgent(id: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt FROM manager_agents WHERE id = ?')
      .get(id);
    return row ? deserializeAgent(row) : undefined;
  }

  function addAgent(name: string, baseUrl: string, token: string): { id: string } {
    const id = randomUUID();
    const createdAt = Date.now();
    db().prepare(
      'INSERT INTO manager_agents (id, agent_key, name, baseUrl, token, enabled, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(id, '', name, baseUrl, token, createdAt);
    return { id };
  }

  function deleteAgent(id: string): void {
    db().prepare('DELETE FROM manager_agents WHERE id = ?').run(id);
  }

  // ── auto-register ───────────────────────────────────────────────────

  function findAgentByKey(agentKey: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt FROM manager_agents WHERE agent_key = ?')
      .get(agentKey);
    return row ? deserializeAgent(row) : undefined;
  }

  function registerAgent(name: string, baseUrl: string, agentKey?: string): { id: string; token: string } {
    // Re-registration: agent already has a key → update existing entry.
    if (agentKey) {
      const existing = findAgentByKey(agentKey);
      if (existing) {
        const token = randomBytes(32).toString('hex');
        db().prepare('UPDATE manager_agents SET baseUrl = ?, token = ? WHERE agent_key = ?')
          .run(baseUrl, token, agentKey);
        return { id: existing.id, token };
      }
    }

    // First registration: create fresh.
    const newId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const agentKeyFinal = agentKey ?? '';
    const createdAt = Date.now();
    db().prepare(
      'INSERT INTO manager_agents (id, agent_key, name, baseUrl, token, enabled, createdAt) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).run(newId, agentKeyFinal, name, baseUrl, token, createdAt);
    return { id: newId, token };
  }

  // ── sessions ────────────────────────────────────────────────────────────

  function createSession(): { token: string; expiresAt: number } {
    // 32 bytes → 64 hex chars. URL-safe enough for a Bearer header.
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    db().prepare(
      'INSERT INTO manager_sessions (token, createdAt, expiresAt) VALUES (?, ?, ?)',
    ).run(token, now, expiresAt);
    return { token, expiresAt };
  }

  function getSession(token: string): { expiresAt: number } | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT expiresAt FROM manager_sessions WHERE token = ?')
      .get(token);
    if (!row) return undefined;
    const expiresAt = Number(row.expiresAt);
    if (expiresAt < Date.now()) {
      // Expired: clean up opportunistically and report as missing.
      db().prepare('DELETE FROM manager_sessions WHERE token = ?').run(token);
      return undefined;
    }
    return { expiresAt };
  }

  function deleteSession(token: string): void {
    db().prepare('DELETE FROM manager_sessions WHERE token = ?').run(token);
  }

  function pruneExpired(): number {
    const r = db()
      .prepare('DELETE FROM manager_sessions WHERE expiresAt < ?')
      .run(Date.now());
    return r.changes;
  }

  async function close() {
    _db?.close();
    _db = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function deserializeAgent(r: any): Agent {
    return {
      id: r.id,
      agentKey: r.agent_key ?? '',
      name: r.name,
      baseUrl: r.baseUrl,
      token: r.token,
      enabled: Boolean(r.enabled),
      createdAt: Number(r.createdAt),
    };
  }

  return {
    init,
    listAgents,
    getAgent,
    addAgent,
    deleteAgent,
    findAgentByKey,
    registerAgent,
    createSession,
    getSession,
    deleteSession,
    pruneExpired,
    close,
  };
}