/**
 * Storage layer for the manager.
 *
 * Two tables:
 *   - manager_agents    — registry of agents the manager can proxy to
 *   - manager_sessions  — paired (sessionToken, refreshToken) rows with
 *                         independent TTLs. Sliding refresh on each use.
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
// the module itself (when required from CJS).
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

/**
 * A paired session issued at login. Both tokens share a row, but each
 * has an independent expiry:
 *  - `sessionToken` is short-lived; failures (or expiry) require a refresh.
 *  - `refreshToken` is long-lived; each successful refresh *slides* its
 *    expiry forward (mobile UX goal: an active user never has to log in
 *    again). The refresh is single-use so concurrent clients can't double-spend.
 */
export interface Session {
  token: string;
  refreshToken: string;
  createdAt: number;
  expiresAt: number;
  refreshExpiresAt: number;
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
  /** Look up an agent by its `baseUrl` (fallback dedup when agentKey is missing). */
  findAgentByBaseUrl(baseUrl: string): Agent | undefined;
  /**
   * Register (or re-register) an agent.
   *
   * When `agentKey` is provided and an agent with that key exists, the
   * entry is *updated* (baseUrl + name) and its existing token is reused —
   * this is the dedup / re-registration path. Reusing the token keeps the
   * agent's bearer stable so prior managers/clients keep working. If
   * agentKey is unknown but the same `baseUrl` already exists, that row is
   * updated in place (token also preserved). Without either match a fresh
   * entry with a new token is created.
   */
  registerAgent(name: string, baseUrl: string, agentKey?: string): { id: string; token: string };
  // ── sessions ──
  createSession(sessionTtlMs: number, refreshTtlMs: number): Session;
  /** Return session if `token` is the active sessionToken and not expired. */
  getSession(token: string): { expiresAt: number } | undefined;
  /** Return the full session row keyed by refreshToken if not expired. */
  findSessionByRefreshToken(token: string): Session | undefined;
  /**
   * Atomic single-use refresh:
   *  - Look up the row by `refreshToken`.
   *  - Validate `refreshExpiresAt > now`.
   *  - DELETE old row + INSERT new row (with new sessionToken + new refreshToken,
   *    with both expiries sliding forward).
   *  - Return new Session; or undefined when the token is expired/missing.
   *
   * Because the old row is deleted in the same transaction as the insert,
   * a concurrent refresh with the same token races and finds the row
   * already gone → undefined. Caller translates that to a 401.
   */
  refreshSession(refreshToken: string, sessionTtlMs: number, refreshTtlMs: number): Session | undefined;
  /** Drop the whole session row (covers both tokens at once). */
  deleteSession(token: string): void;
  /**
   * Sweep all rows with expired session OR refresh TTL.
   * Cheap sweep called on each request.
   */
  pruneExpired(): number;
  /** Close the underlying SQLite handle. */
  close(): Promise<void>;
}

// ─── SQLite-backed implementation ─────────────────────────────────────────

export function createStorage(dataDir: string): Storage {
  // `:memory:` is a sentinel that lets tests skip the filesystem. better-sqlite3
  // accepts it directly to mean an in-memory, per-connection DB; do NOT wrap it
  // in path.join (which would turn it into a regular filename).
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'manager.sqlite');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _db: any = null;

  function db(): import('better-sqlite3').Database {
    if (_db) return _db;
    _db = new Database(dbPath);
    // WAL requires a real file. In-memory databases work without it.
    if (dbPath !== ':memory:') {
      _db.pragma('journal_mode = WAL');
    }
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
      CREATE INDEX IF NOT EXISTS manager_agents_baseUrl ON manager_agents(baseUrl);

      CREATE TABLE IF NOT EXISTS manager_sessions (
        token              TEXT PRIMARY KEY,        -- sessionToken
        refresh_token      TEXT NOT NULL UNIQUE,    -- refreshToken
        createdAt          INTEGER NOT NULL,
        expiresAt          INTEGER NOT NULL,        -- sessionToken expiry
        refresh_expires_at INTEGER NOT NULL         -- refreshToken expiry
      );

      CREATE INDEX IF NOT EXISTS manager_sessions_expires
        ON manager_sessions(expiresAt);
    `);
    return _db;
  }

  async function init() {
    if (dataDir !== ':memory:') {
      await mkdir(dataDir, { recursive: true });
    }
    const handle = db(); // touch schema

    // Migration: v0.1 → dual-token schema.
    //   - manager_agents.agent_key column
    //   - manager_sessions: refresh_token + refresh_expires_at columns
    // Bare try/catch is intentional — running ALTER on an already-up-to-date
    // table throws "duplicate column name", which is the happy path.
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

    const hasRefreshToken = handle
      .prepare("SELECT 1 FROM pragma_table_info('manager_sessions') WHERE name = 'refresh_token'")
      .get();
    if (!hasRefreshToken) {
      // Pre-migration rows lacked a refresh token. We can't synthesize a
      // usable one (the session was single-shot before), so wipe legacy rows.
      // Affected users see "please log in again" once after upgrade.
      handle.exec(`DELETE FROM manager_sessions`);
      handle.exec(
        `ALTER TABLE manager_sessions ADD COLUMN refresh_token TEXT NOT NULL DEFAULT ''`,
      );
      handle.exec(
        `ALTER TABLE manager_sessions ADD COLUMN refresh_expires_at INTEGER NOT NULL DEFAULT 0`,
      );
      // MySQL/SQLite UNIQUE constraint via separate index (see CREATE TABLE).
      handle.exec(
        `CREATE INDEX IF NOT EXISTS manager_sessions_refresh_token ON manager_sessions(refresh_token)`,
      );
      handle.exec(
        `CREATE INDEX IF NOT EXISTS manager_sessions_refresh_expires ON manager_sessions(refresh_expires_at)`,
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

  /**
   * Look up an agent by `baseUrl` — fallback dedup key for cases when
   * the agent lost its `agentKey` (e.g. fresh install / wiped data dir).
   * Same machine re-registering from scratch is treated as the same row.
   */
  function findAgentByBaseUrl(baseUrl: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt FROM manager_agents WHERE baseUrl = ?')
      .get(baseUrl);
    return row ? deserializeAgent(row) : undefined;
  }

  function registerAgent(name: string, baseUrl: string, agentKey?: string): { id: string; token: string } {
    // Re-registration: prefer agentKey (stable across restarts).
    if (agentKey) {
      const existing = findAgentByKey(agentKey);
      if (existing) {
        // Reuse the existing token — the agent adopts whatever token we
        // return as its bearer, so regenerating on every re-registration
        // (e.g. an agent restart) would lock out previously-connected
        // managers/clients. Only refresh baseUrl + name.
        db().prepare(
          'UPDATE manager_agents SET baseUrl = ?, name = ? WHERE agent_key = ?',
        ).run(baseUrl, name, agentKey);
        return { id: existing.id, token: existing.token };
      }
    }

    // Fallback: same baseUrl already registered → treat as same machine
    // even when agentKey is missing (fresh install, wiped data dir).
    // Update in place: keep id + token stable, refresh name.
    const sameUrl = findAgentByBaseUrl(baseUrl);
    if (sameUrl) {
      db().prepare(
        'UPDATE manager_agents SET name = ?, agent_key = COALESCE(NULLIF(?, ""), agent_key) WHERE id = ?',
      ).run(name, agentKey ?? '', sameUrl.id);
      return { id: sameUrl.id, token: sameUrl.token };
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

  function createSession(sessionTtlMs: number, refreshTtlMs: number): Session {
    const token = randomBytes(32).toString('hex');
    const refreshToken = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + sessionTtlMs;
    const refreshExpiresAt = now + refreshTtlMs;
    db().prepare(
      'INSERT INTO manager_sessions (token, refresh_token, createdAt, expiresAt, refresh_expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(token, refreshToken, now, expiresAt, refreshExpiresAt);
    return { token, refreshToken, createdAt: now, expiresAt, refreshExpiresAt };
  }

  function getSession(token: string): { expiresAt: number } | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT expiresAt FROM manager_sessions WHERE token = ?')
      .get(token);
    if (!row) return undefined;
    const expiresAt = Number(row.expiresAt);
    if (expiresAt < Date.now()) {
      // Expired sessionToken: still possible this row is alive via
      // refreshToken (sliding). Don't delete — the row is still useful
      // for refresh until refresh_expires_at hits; `pruneExpired`
      // handles that. Just report missing here.
      return undefined;
    }
    return { expiresAt };
  }

  function findSessionByRefreshToken(token: string): Session | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT token, refresh_token, createdAt, expiresAt, refresh_expires_at FROM manager_sessions WHERE refresh_token = ?')
      .get(token);
    if (!row) return undefined;
    const refreshExpiresAt = Number(row.refresh_expires_at);
    if (refreshExpiresAt < Date.now()) {
      db().prepare('DELETE FROM manager_sessions WHERE refresh_token = ?').run(token);
      return undefined;
    }
    return {
      token: row.token,
      refreshToken: row.refresh_token,
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      refreshExpiresAt,
    };
  }

  function refreshSession(
    refreshToken: string,
    sessionTtlMs: number,
    refreshTtlMs: number,
  ): Session | undefined {
    const handle = db();
    const now = Date.now();

    // Wrap in a single transaction. better-sqlite3 transactions are
    // synchronous and serialization is per-connection — fast enough for
    // the manager's load.
    const txn = handle.transaction((token: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row: any = handle
        .prepare('SELECT expiresAt, refresh_expires_at FROM manager_sessions WHERE refresh_token = ?')
        .get(token);
      if (!row) return undefined;
      const refreshExpiresAt = Number(row.refresh_expires_at);
      if (refreshExpiresAt < now) {
        // Expired refresh: drop the row, report missing.
        handle.prepare('DELETE FROM manager_sessions WHERE refresh_token = ?').run(token);
        return undefined;
      }
      // Single-use: delete the old row.
      handle.prepare('DELETE FROM manager_sessions WHERE refresh_token = ?').run(token);
      // Insert new row with new sessionToken + new refreshToken. Sliding
      // means the user keeps the same 30-day window as long as they
      // refresh at least once before it ends.
      const newToken = randomBytes(32).toString('hex');
      const newRefreshToken = randomBytes(32).toString('hex');
      const newExpiresAt = now + sessionTtlMs;
      const newRefreshExpiresAt = now + refreshTtlMs;
      handle.prepare(
        'INSERT INTO manager_sessions (token, refresh_token, createdAt, expiresAt, refresh_expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(newToken, newRefreshToken, now, newExpiresAt, newRefreshExpiresAt);
      return {
        token: newToken,
        refreshToken: newRefreshToken,
        createdAt: now,
        expiresAt: newExpiresAt,
        refreshExpiresAt: newRefreshExpiresAt,
      };
    });
    return txn(refreshToken);
  }

  function deleteSession(token: string): void {
    // Either token identifies the row, so delete by both columns in one
    // statement to avoid a SELECT-then-DELETE round trip.
    db().prepare(
      'DELETE FROM manager_sessions WHERE token = ? OR refresh_token = ?',
    ).run(token, token);
  }

  function pruneExpired(): number {
    const now = Date.now();
    const r = db()
      .prepare('DELETE FROM manager_sessions WHERE expiresAt < ? OR refresh_expires_at < ?')
      .run(now, now);
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
    findAgentByBaseUrl,
    registerAgent,
    createSession,
    getSession,
    findSessionByRefreshToken,
    refreshSession,
    deleteSession,
    pruneExpired,
    close,
  };
}
