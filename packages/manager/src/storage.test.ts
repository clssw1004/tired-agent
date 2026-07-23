/**
 * Storage regression tests for the dual-token session model.
 *
 * Coverage:
 *  - createSession stores paired sessionToken + refreshToken with independent TTLs
 *  - getSession(sessionToken) returns expiry; ignores rows whose session expired but
 *    refresh is still alive (we don't wipe them — refresh might still save the user)
 *  - findSessionByRefreshToken returns full row when refresh is alive
 *  - refreshSession: single-use (concurrent call with same old token gets `undefined`)
 *  - refreshSession: slides both TTLs forward
 *  - deleteSession: by either token, wipes the whole row (both tokens die)
 *  - pruneExpired: cleans up rows whose session OR refresh has expired
 *
 * Uses `:memory:` SQLite so each test is hermetic.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createStorage, type Storage } from './storage.js';

let storage: Storage;

beforeEach(async () => {
  // Use `:memory:` SQLite — no filesystem artifacts, hermetic per test.
  // (We can't reuse one shared handle because better-sqlite3 in-memory
  //  databases are scoped to the connection; `createStorage` opens its
  //  own, so the temporary file path is irrelevant.)
  storage = createStorage(':memory:');
  await storage.init();
});

describe('dual-token session', () => {
  it('createSession stores paired tokens with both TTLs', () => {
    const session = storage.createSession(60_000, 2_592_000_000); // 1m / 30d
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    expect(session.token).not.toEqual(session.refreshToken);

    const now = Date.now();
    expect(session.expiresAt - now).toBeGreaterThan(50_000);          // ≈ 1m
    expect(session.refreshExpiresAt - now).toBeGreaterThan(2.5e9);    // ≈ 30d
  });

  it('getSession returns the sessionToken expiry when alive', () => {
    const s = storage.createSession(60_000, 2_592_000_000);
    expect(storage.getSession(s.token)).toEqual({ expiresAt: s.expiresAt });
  });

  it('getSession returns undefined for the refreshToken alone', () => {
    // Only sessionToken is keyed by `getSession`; refreshToken lives in
    // its own column. We must use findSessionByRefreshToken for it.
    const s = storage.createSession(60_000, 2_592_000_000);
    expect(storage.getSession(s.refreshToken)).toBeUndefined();
  });

  it('findSessionByRefreshToken returns the full row when alive', () => {
    const s = storage.createSession(60_000, 2_592_000_000);
    expect(storage.findSessionByRefreshToken(s.refreshToken)).toEqual(s);
  });
});

describe('refreshSession — single-use + sliding', () => {
  it('returns new paired tokens and slides both TTLs forward', () => {
    const original = storage.createSession(60_000, 2_592_000_000);
    const before = Date.now();

    // Sleep 5ms so the new TTL is measurably later than the original's.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    const next = storage.refreshSession(original.refreshToken, 60_000, 2_592_000_000);
    expect(next).toBeDefined();

    // Old tokens must NOT find anything now — single-use invariant.
    expect(storage.findSessionByRefreshToken(original.refreshToken)).toBeUndefined();
    expect(storage.getSession(original.token)).toBeUndefined();

    // New tokens have new values.
    expect(next!.token).not.toEqual(original.token);
    expect(next!.refreshToken).not.toEqual(original.refreshToken);

    // Both TTLs slid forward from `before`.
    expect(next!.expiresAt - before).toBeGreaterThan(60_000 - 1000);     // ≈ 1m
    expect(next!.refreshExpiresAt - before).toBeGreaterThan(2.5e9);     // ≈ 30d
  });

  it('returns undefined on second refresh with the same old token', () => {
    const original = storage.createSession(60_000, 2_592_000_000);
    const first = storage.refreshSession(original.refreshToken, 60_000, 2_592_000_000);
    expect(first).toBeDefined();
    // Original refreshToken was deleted after first refresh.
    const second = storage.refreshSession(original.refreshToken, 60_000, 2_592_000_000);
    expect(second).toBeUndefined();
    // The new refreshToken we got back IS still valid (one full use left).
    expect(storage.findSessionByRefreshToken(first!.refreshToken)).toBeDefined();
  });

  it('returns undefined for an unknown refresh token', () => {
    expect(storage.refreshSession('not-a-real-token', 60_000, 2_592_000_000)).toBeUndefined();
  });

  it('returns undefined + drops the row when the refresh has expired', () => {
    const original = storage.createSession(60_000, 50); // refresh TTL = 50ms
    // Wait past refresh expiry but keep session alive.
    const wait = new Promise((r) => setTimeout(r, 80));
    return wait.then(() => {
      const out = storage.refreshSession(original.refreshToken, 60_000, 50);
      expect(out).toBeUndefined();
      // Row was deleted by refreshSession as a side effect.
      expect(storage.findSessionByRefreshToken(original.refreshToken)).toBeUndefined();
    });
  });
});

describe('deleteSession — covers both tokens', () => {
  it('deleteSession(sessionToken) wipes the row', () => {
    const s = storage.createSession(60_000, 2_592_000_000);
    storage.deleteSession(s.token);
    expect(storage.findSessionByRefreshToken(s.refreshToken)).toBeUndefined();
  });

  it('deleteSession(refreshToken) wipes the row', () => {
    const s = storage.createSession(60_000, 2_592_000_000);
    storage.deleteSession(s.refreshToken);
    expect(storage.getSession(s.token)).toBeUndefined();
  });
});

describe('pruneExpired', () => {
  it('drops rows whose session or refresh has expired', () => {
    const aliveSession = storage.createSession(60_000, 2_592_000_000);
    const refreshShortSession = storage.createSession(60_000, 50);
    const wait = new Promise((r) => setTimeout(r, 80));
    return wait.then(() => {
      const removed = storage.pruneExpired();
      expect(removed).toBeGreaterThanOrEqual(1);
      // The alive row must remain.
      expect(storage.findSessionByRefreshToken(aliveSession.refreshToken)).toBeDefined();
      // The short-refresh row must have been dropped.
      expect(storage.findSessionByRefreshToken(refreshShortSession.refreshToken)).toBeUndefined();
    });
  });
});
