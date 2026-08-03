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

import { log } from './util/log.js';

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
  /** 注册状态：pending | online | offline */
  status: string;
  /** Agent 软件版本，如 "0.1.20" */
  version: string;
  platformOs: string;
  platformArch: string;
  platformRelease: string;
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
  /** 通过 bearer token 查找 Agent（用于心跳认证）。 */
  findAgentByToken(token: string): Agent | undefined;
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
  registerAgent(
    name: string,
    baseUrl: string,
    agentKey?: string,
    platform?: { os: string; arch: string; release: string },
  ): { id: string; token: string; status: string };
  /** Update the agent's online/offline/pending status. */
  updateAgentStatus(id: string, status: string): void;
  /** Update the agent's platform info (OS, arch, release). */
  updateAgentPlatform(id: string, os: string, arch: string, release: string): void;
  /** Update the agent's software version. */
  updateAgentVersion(id: string, version: string): void;
  /**
   * Generic partial update for an agent's editable fields.
   * Returns `true` if the agent existed, `false` otherwise.
   */
  updateAgent(id: string, data: { name?: string; baseUrl?: string; token?: string }): boolean;
  // ── sessions ──
  createSession(sessionTtlMs: number, refreshTtlMs: number): Session;
  /** Return session if `token` is the active sessionToken and not expired. */
  getSession(token: string): { expiresAt: number } | undefined;
  /** Return the full session row keyed by refreshToken if not expired. */
  findSessionByRefreshToken(token: string): Session | undefined;
  /**
   * Confirmed Rotation — 高可靠性轮转。
   *
   * 取代原有的 DELETE+INSERT 单次使用模型。旧行不删除，标记 replaced_by；
   * 当新 sessionToken 被 auth middleware 验证通过（confirmSession）后才清理旧行。
   * 丢响应场景下客户端重试旧 refreshToken → 通过 replaced_by 返回同一对新 token。
   *
   * 流程：
   *  1. 按 refresh_token 找行，检查 refresh_expires_at
   *  2. IF replaced_by IS NOT NULL → 已轮转过的重试 → 返回已签发的 token 对
   *  3. ELSE → 首次刷新 → UPDATE 旧行 SET replaced_by, INSERT 新行
   *
   * 返回新 Session；refreshToken 已过期/不存在时返回 undefined。
   */
  refreshSession(refreshToken: string, sessionTtlMs: number, refreshTtlMs: number): Session | undefined;
  /**
   * 确认轮转完成。当 sessionToken 被真实 API 请求验证通过后调用。
   * 清除所有 replaced_by 指向该 token 的旧行——旧 refreshToken 此时真正失效。
   */
  confirmSession(token: string): void;
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
        createdAt   INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        version     TEXT NOT NULL DEFAULT '',
        platform_os     TEXT NOT NULL DEFAULT '',
        platform_arch   TEXT NOT NULL DEFAULT '',
        platform_release TEXT NOT NULL DEFAULT ''
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
    log.info({ dbPath }, 'storage: schema initialized');

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
      log.info('storage: migration 1 — added agent_key column');
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
      log.info('storage: migration 2 — added refresh_token + refresh_expires_at columns');
    }

    // Migration: add status and platform columns
    const hasStatus = handle
      .prepare("SELECT 1 FROM pragma_table_info('manager_agents') WHERE name = 'status'")
      .get();
    if (!hasStatus) {
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN version TEXT NOT NULL DEFAULT ''`);
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_os TEXT NOT NULL DEFAULT ''`);
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_arch TEXT NOT NULL DEFAULT ''`);
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_release TEXT NOT NULL DEFAULT ''`);
      log.info('storage: migration 3 — added status + platform columns');
    }

    // Migration: add version column (separate migration in case DB already has platform cols)
    const hasVersion = handle
      .prepare("SELECT 1 FROM pragma_table_info('manager_agents') WHERE name = 'version'")
      .get();
    if (!hasVersion) {
      handle.exec(`ALTER TABLE manager_agents ADD COLUMN version TEXT NOT NULL DEFAULT ''`);
      log.info('storage: migration 4 — added version column');
    }

    // Migration 5: Confirmed Rotation — replaced_by column.
    const hasReplacedBy = handle
      .prepare("SELECT 1 FROM pragma_table_info('manager_sessions') WHERE name = 'replaced_by'")
      .get();
    if (!hasReplacedBy) {
      handle.exec(
        `ALTER TABLE manager_sessions ADD COLUMN replaced_by TEXT DEFAULT NULL`,
      );
      log.info('storage: migration 5 — added replaced_by column');
    }
  }

  // ── agents ──────────────────────────────────────────────────────────────

  function listAgents(): Agent[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release FROM manager_agents ORDER BY createdAt ASC')
      .all();
    return rows.map(deserializeAgent);
  }

  function getAgent(id: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release FROM manager_agents WHERE id = ?')
      .get(id);
    return row ? deserializeAgent(row) : undefined;
  }

  function addAgent(name: string, baseUrl: string, token: string): { id: string } {
    const id = randomUUID();
    const createdAt = Date.now();
    db().prepare(
      'INSERT INTO manager_agents (id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    ).run(id, '', name, baseUrl, token, createdAt, 'pending', '', '', '', '');
    log.info({ agentId: id, name, baseUrl }, 'storage: agent added manually');
    return { id };
  }

  function deleteAgent(id: string): void {
    db().prepare('DELETE FROM manager_agents WHERE id = ?').run(id);
    log.info({ agentId: id }, 'storage: agent deleted');
  }

  // ── auto-register ───────────────────────────────────────────────────

  function findAgentByKey(agentKey: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release FROM manager_agents WHERE agent_key = ?')
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
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release FROM manager_agents WHERE baseUrl = ?')
      .get(baseUrl);
    return row ? deserializeAgent(row) : undefined;
  }

  function registerAgent(
    name: string,
    baseUrl: string,
    agentKey?: string,
    platform?: { os: string; arch: string; release: string },
  ): { id: string; token: string; status: string } {
    // Re-registration: prefer agentKey (stable across restarts).
    if (agentKey) {
      const existing = findAgentByKey(agentKey);
      if (existing) {
        // Reuse the existing token — the agent adopts whatever token we
        // return as its bearer, so regenerating on every re-registration
        // (e.g. an agent restart) would lock out previously-connected
        // managers/clients. Only refresh baseUrl + name.
        db().prepare(
          'UPDATE manager_agents SET baseUrl = ?, name = ?, platform_os = ?, platform_arch = ?, platform_release = ? WHERE agent_key = ?',
        ).run(baseUrl, name, platform?.os ?? '', platform?.arch ?? '', platform?.release ?? '', agentKey);
        log.info({ agentId: existing.id, name, baseUrl, status: existing.status }, 'storage: agent re-registered (by agentKey)');
        return { id: existing.id, token: existing.token, status: existing.status };
      }
    }

    // Fallback: same baseUrl already registered → treat as same machine
    // even when agentKey is missing (fresh install, wiped data dir).
    // Update in place: keep id + token stable, refresh name.
    const sameUrl = findAgentByBaseUrl(baseUrl);
    if (sameUrl) {
      db().prepare(
        'UPDATE manager_agents SET name = ?, agent_key = COALESCE(NULLIF(?, ""), agent_key), platform_os = ?, platform_arch = ?, platform_release = ? WHERE id = ?',
      ).run(name, agentKey ?? '', platform?.os ?? '', platform?.arch ?? '', platform?.release ?? '', sameUrl.id);
      log.info({ agentId: sameUrl.id, name, baseUrl, status: sameUrl.status }, 'storage: agent re-registered (by baseUrl)');
      return { id: sameUrl.id, token: sameUrl.token, status: sameUrl.status };
    }

    // First registration: create fresh.
    const newId = randomUUID();
    const token = randomBytes(32).toString('hex');
    const agentKeyFinal = agentKey ?? '';
    const createdAt = Date.now();
    db().prepare(
      'INSERT INTO manager_agents (id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
    ).run(newId, agentKeyFinal, name, baseUrl, token, createdAt, 'pending', '', platform?.os ?? '', platform?.arch ?? '', platform?.release ?? '');
    log.info({ agentId: newId, name, baseUrl }, 'storage: agent first-registered');
    return { id: newId, token, status: 'pending' };
  }

  function updateAgentStatus(id: string, status: string): void {
    db().prepare('UPDATE manager_agents SET status = ? WHERE id = ?').run(status, id);
    log.info({ agentId: id, status }, 'storage: agent status updated');
  }

  function updateAgentPlatform(id: string, os: string, arch: string, release: string): void {
    db().prepare(
      'UPDATE manager_agents SET platform_os = ?, platform_arch = ?, platform_release = ? WHERE id = ?',
    ).run(os, arch, release, id);
    log.info({ agentId: id, os, arch }, 'storage: agent platform updated');
  }

  function updateAgentVersion(id: string, version: string): void {
    db().prepare(
      'UPDATE manager_agents SET version = ? WHERE id = ?',
    ).run(version, id);
    log.info({ agentId: id, version }, 'storage: agent version updated');
  }

  function updateAgent(
    id: string,
    data: { name?: string; baseUrl?: string; token?: string },
  ): boolean {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (data.name !== undefined) { fields.push('name=?'); values.push(data.name); }
    if (data.baseUrl !== undefined) { fields.push('baseUrl=?'); values.push(data.baseUrl); }
    if (data.token !== undefined) { fields.push('token=?'); values.push(data.token); }
    if (!fields.length) return false;

    values.push(id);
    const r = db().prepare(
      `UPDATE manager_agents SET ${fields.join(',')} WHERE id=?`,
    ).run(...values);
    if (r.changes === 0) {
      log.warn({ agentId: id }, 'storage: updateAgent — not found');
      return false;
    }
    log.info({ agentId: id, fields: fields.map((f) => f.replace('=?', '')) }, 'storage: agent updated');
    return true;
  }

  /** 通过 bearer token 查找 Agent（用于心跳认证）。 */
  function findAgentByToken(token: string): Agent | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt, status, version, platform_os, platform_arch, platform_release FROM manager_agents WHERE token = ?')
      .get(token);
    return row ? deserializeAgent(row) : undefined;
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
    log.info('storage: session created');
    return { token, refreshToken, createdAt: now, expiresAt, refreshExpiresAt };
  }

  function getSession(token: string): { expiresAt: number } | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = db()
      .prepare('SELECT expiresAt, replaced_by FROM manager_sessions WHERE token = ?')
      .get(token);
    if (!row) return undefined;
    // If this sessionToken has been replaced by a newer one (confirmed rotation),
    // it is no longer valid as an auth credential.
    if (row.replaced_by != null) return undefined;
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
      .prepare('SELECT token, refresh_token, replaced_by, createdAt, expiresAt, refresh_expires_at FROM manager_sessions WHERE refresh_token = ?')
      .get(token);
    if (!row) return undefined;
    const refreshExpiresAt = Number(row.refresh_expires_at);
    if (refreshExpiresAt < Date.now()) {
      db().prepare('DELETE FROM manager_sessions WHERE refresh_token = ?').run(token);
      log.warn('storage: findSessionByRefreshToken — refresh token expired, deleted');
      return undefined;
    }

    // If this refresh token has already been rotated, follow the link to
    // the current row and return those tokens instead.
    if (row.replaced_by != null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newRow: any = db()
        .prepare('SELECT token, refresh_token, createdAt, expiresAt, refresh_expires_at FROM manager_sessions WHERE token = ?')
        .get(String(row.replaced_by));
      if (newRow) {
        return {
          token: newRow.token,
          refreshToken: newRow.refresh_token,
          createdAt: Number(newRow.createdAt),
          expiresAt: Number(newRow.expiresAt),
          refreshExpiresAt: Number(newRow.refresh_expires_at),
        };
      }
      // New row was pruned — fall through to return the old row (best-effort).
    }

    return {
      token: row.token,
      refreshToken: row.refresh_token,
      createdAt: Number(row.createdAt),
      expiresAt: Number(row.expiresAt),
      refreshExpiresAt,
    };
  }

  function confirmSession(token: string): void {
    const r = db()
      .prepare('DELETE FROM manager_sessions WHERE replaced_by = ?')
      .run(token);
    if (r.changes > 0) {
      log.info({ token: token.substring(0, 8) + '…' }, 'storage: confirmSession — old row cleaned up');
    }
  }

  function refreshSession(
    refreshToken: string,
    sessionTtlMs: number,
    refreshTtlMs: number,
  ): Session | undefined {
    const handle = db();
    const now = Date.now();

    const txn = handle.transaction((token: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row: any = handle
        .prepare('SELECT replaced_by, refresh_expires_at FROM manager_sessions WHERE refresh_token = ?')
        .get(token);
      if (!row) return undefined;
      const refreshExpiresAt = Number(row.refresh_expires_at);
      if (refreshExpiresAt < now) {
        // Expired refresh: drop the row, report missing.
        handle.prepare('DELETE FROM manager_sessions WHERE refresh_token = ?').run(token);
        log.warn('storage: refreshSession — token expired');
        return undefined;
      }

      // ── Retry path: this refreshToken has already been rotated ───────
      // Client didn't receive the previous response. Return the same
      // new token pair we already issued instead of doing another rotation.
      if (row.replaced_by != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newRow: any = handle
          .prepare('SELECT token, refresh_token, createdAt, expiresAt, refresh_expires_at FROM manager_sessions WHERE token = ?')
          .get(String(row.replaced_by));
        if (newRow) {
          log.info('storage: refreshSession — retry, returning existing tokens');
          return {
            token: newRow.token,
            refreshToken: newRow.refresh_token,
            createdAt: Number(newRow.createdAt),
            expiresAt: Number(newRow.expiresAt),
            refreshExpiresAt: Number(newRow.refresh_expires_at),
          };
        }
        // New row was pruned (e.g. expired sessionToken + prune hit it).
        // Fall through to generate fresh tokens — better than returning
        // undefined which forces the client to re-auth.
        log.warn('storage: refreshSession — retry but new row gone, generating fresh');
      }

      // ── First use of this refreshToken ───────────────────────────────
      // UPDATE old row to mark it as replaced; INSERT new row.
      const newToken = randomBytes(32).toString('hex');
      const newRefreshToken = randomBytes(32).toString('hex');
      const newExpiresAt = now + sessionTtlMs;
      const newRefreshExpiresAt = now + refreshTtlMs;

      handle.prepare(
        'UPDATE manager_sessions SET replaced_by = ? WHERE refresh_token = ?',
      ).run(newToken, token);

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
    const result = txn(refreshToken);
    if (result) {
      log.info('storage: session refreshed (sliding, confirmed rotation)');
    } else {
      log.warn('storage: refreshSession — no row');
    }
    return result;
  }

  function deleteSession(token: string): void {
    // Either token identifies the row, so delete by both columns in one
    // statement to avoid a SELECT-then-DELETE round trip.
    db().prepare(
      'DELETE FROM manager_sessions WHERE token = ? OR refresh_token = ?',
    ).run(token, token);
    log.info('storage: session deleted');
  }

  function pruneExpired(): number {
    const now = Date.now();
    const r = db()
      .prepare('DELETE FROM manager_sessions WHERE expiresAt < ? OR refresh_expires_at < ?')
      .run(now, now);
    if (r.changes > 0) {
      log.info({ count: r.changes }, 'storage: pruned expired sessions');
    }
    // Also clean up dangling replaced_by references: rows whose target
    // sessionToken no longer exists (confirmSession should have cleaned
    // these up, but this is a safety net).
    const dangling = db()
      .prepare(`DELETE FROM manager_sessions WHERE replaced_by IS NOT NULL AND replaced_by NOT IN (SELECT token FROM manager_sessions)`)
      .run();
    if (dangling.changes > 0) {
      log.info({ count: dangling.changes }, 'storage: pruned dangling replaced_by rows');
    }
    return r.changes + dangling.changes;
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
      status: r.status ?? 'pending',
      version: r.version ?? '',
      platformOs: r.platform_os ?? '',
      platformArch: r.platform_arch ?? '',
      platformRelease: r.platform_release ?? '',
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
    findAgentByToken,
    registerAgent,
    updateAgentStatus,
    updateAgentPlatform,
    updateAgentVersion,
    updateAgent,
    createSession,
    getSession,
    findSessionByRefreshToken,
    refreshSession,
    confirmSession,
    deleteSession,
    pruneExpired,
    close,
  };
}
