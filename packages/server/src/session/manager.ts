/**
 * SessionManager — in-memory coordinator that owns the node-pty processes
 * and delegates persistence to a Storage adapter.
 *
 * Responsibilities:
 * - Spawn / kill PTY processes
 * - Maintain the in-memory Map<id, LiveSession>
 * - Expose subscribe() for SSE subscribers
 * - Delegate all durable reads/writes to Storage
 */

import type { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { spawn } from 'node-pty';
import { randomUUID } from 'node:crypto';
import type { SessionSpec } from '@tired-pc/protocol';
import type { SessionRecord } from './types.js';
import { createSessionRecord } from './types.js';
import type { Storage } from './storage.js';
import { log } from '../util/log.js';

export interface LiveSession {
  /** Snapshot from storage — always reflects the latest state. */
  record: SessionRecord;
  pty: IPty;
  /** Subscribers waiting for output / state events (SSE clients). */
  subscribers: Set<(ev: SessionEvent) => void>;
}

export type SessionEvent =
  | { type: 'output'; offset: number; data: Uint8Array }
  | { type: 'state'; record: SessionRecord };

/**
 * Maps session id → live session. Entries are removed after the PTY exits
 * and the client has finished draining the log (client-driven, not here).
 */
const live = new Map<string, LiveSession>();

export class SessionManager {
  constructor(private readonly storage: Storage) {}

  /** Create and start a new PTY session. */
  async create(spec: SessionSpec): Promise<SessionRecord> {
    const id = randomUUID();
    const record = createSessionRecord(id, spec);
    this.storage.insert(record);

    try {
      const file = normalizeCmd(record.cmd);
      const args = record.args ?? [];
      const pty = spawn(file, args, {
        cwd: record.cwd ?? undefined,
        env: buildEnv(record.env),
        cols: record.cols,
        rows: record.rows,
        name: 'xterm-256color',
      });

      const liveSession: LiveSession = {
        record,
        pty,
        subscribers: new Set(),
      };
      live.set(id, liveSession);

      // Wire up data → storage + broadcast
      pty.onData((data: string) => {
        const bytes = new TextEncoder().encode(data);
        const newOffset = this.storage.appendOutput(id, bytes);
        const updated = this.storage.get(id)!;
        liveSession.record = updated;
        this.broadcast(liveSession, { type: 'output', offset: newOffset - bytes.length, data: bytes });
        this.broadcast(liveSession, { type: 'state', record: updated });
      });

      pty.onExit(({ exitCode, signal }) => {
        const finalCode = exitCode ?? (signal ? 128 + signal : null);
        const updated: Partial<SessionRecord> & { id: string } = {
          id,
          status: 'exited',
          exitCode: finalCode,
          exitedAt: Date.now(),
        };
        this.storage.update(updated);
        const rec = this.storage.get(id)!;
        liveSession.record = rec;
        this.broadcast(liveSession, { type: 'state', record: rec });
        log.info({ sessionId: id, exitCode: finalCode }, 'session exited');
        // Keep the entry in `live` so clients can still read output after exit.
        // Cleanup is client-driven (client stops reading and the entry is left
        // for GC — a new create() won't reuse the same id).
      });

      // Update pid (available after spawn)
      this.storage.update({ id, pid: pty.pid, status: 'running' });
      const started = this.storage.get(id)!;
      liveSession.record = started;
      this.broadcast(liveSession, { type: 'state', record: started });
      log.info({ sessionId: id, pid: pty.pid, cmd: record.cmd }, 'session created');

      return started;
    } catch (err) {
      this.storage.update({ id, status: 'exited', exitCode: -1, exitedAt: Date.now() });
      const msg = (err as Error).message;
      // node-pty throws "File not found: " (with empty file) when the
      // executable is not in PATH. Make this useful.
      if (/^File not found/i.test(msg)) {
        throw new Error(
          `Executable "${record.cmd}" not found on the server's PATH. ` +
          `On Windows, try "cmd.exe" or the full path (e.g. "C:\\Users\\me\\bin\\claude.exe").`,
        );
      }
      throw err;
    }
  }

  /** Kill a session. On Windows we use taskkill; on Unix, SIGTERM then SIGKILL. */
  async kill(id: string): Promise<void> {
    const s = live.get(id);
    if (!s) {
      const rec = this.storage.get(id);
      if (!rec) throw new Error(`Session ${id} not found`);
      return; // already dead — no-op
    }
    log.info({ sessionId: id, pid: s.record.pid }, 'killing session');
    if (process.platform === 'win32') {
      // Windows: signals not supported; use taskkill
      const { execSync } = await import('node:child_process');
      try { execSync(`taskkill /F /PID ${s.record.pid}`, { stdio: 'ignore' }); } catch { /* already dead */ }
    } else {
      s.pty.kill('SIGTERM');
      setTimeout(() => {
        try { s.pty.kill('SIGKILL'); } catch { /* already dead */ }
      }, 5_000);
    }
  }

  /** Write input bytes to the PTY. */
  write(id: string, data: Uint8Array): void {
    const s = live.get(id);
    if (!s) throw new Error(`Session ${id} is not running`);
    s.pty.write(Buffer.from(data).toString('utf8'));
  }

  /** Resize the PTY. */
  resize(id: string, cols: number, rows: number): void {
    const s = live.get(id);
    if (!s) throw new Error(`Session ${id} is not running`);
    s.pty.resize(cols, rows);
    this.storage.update({ id, cols, rows });
  }

  /** Open a subscription for SSE delivery. Returns an unsubscribe function. */
  subscribe(id: string, onEvent: (ev: SessionEvent) => void): () => void {
    const s = live.get(id);
    if (!s) throw new Error(`Session ${id} not found`);
    s.subscribers.add(onEvent);
    return () => { s.subscribers.delete(onEvent); };
  }

  /** Return live snapshot for a session (combines storage record + live pid). */
  get(id: string): SessionRecord | undefined {
    return live.get(id)?.record ?? this.storage.get(id);
  }

  /** Return all sessions (live + storage). */
  list(): SessionRecord[] {
    // Merge: live sessions override storage records
    const byId = new Map<string, SessionRecord>();
    for (const rec of this.storage.list()) byId.set(rec.id, rec);
    for (const [id, s] of live) byId.set(id, s.record);
    return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private broadcast(s: LiveSession, ev: SessionEvent) {
    for (const cb of s.subscribers) {
      try { cb(ev); } catch (err) {
        log.error({ err, sessionId: s.record.id }, 'subscriber callback error');
      }
    }
  }
}

function normalizeCmd(cmd: string): string {
  // Windows: 'cmd' → 'cmd.exe', 'python' → 'python.exe', etc.
  if (process.platform === 'win32') {
    const lower = cmd.toLowerCase();
    if (!lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat') &&
        !lower.includes('/') && !lower.includes('\\')) {
      return `${cmd}.exe`;
    }
  }
  return cmd;
}

function buildEnv(extra: Record<string, string> | null): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) base[k] = v;
  }
  // Strip NODE_OPTIONS to avoid child inheriting watch flags
  delete base['NODE_OPTIONS'];
  if (extra) Object.assign(base, extra);
  return base;
}
