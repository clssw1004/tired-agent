/**
 * SessionManager — in-memory coordinator that owns the node-pty processes
 * and delegates persistence to a Storage adapter.
 *
 * Responsibilities:
 * - Spawn / kill PTY processes
 * - Maintain the in-memory Map<id, LiveSession>
 * - Expose subscribe() for SSE subscribers
 * - Delegate all durable reads/writes to Storage
 *
 * ## Structured mode lifecycle
 *
 * Structured (chat) mode sessions have a different lifecycle from PTY sessions:
 * no PTY is kept alive between turns. Each user message spawns a short-lived
 * Claude process (with --resume for context), and the process exits when done.
 * The session record stays 'running' so the user can send the next message.
 * Only explicit `kill` removes the session.
 *
 *   create() → storage record (status='running'), no PTY
 *   write()  → spawn PTY → write stdin → PTY exits → session stays 'running'
 *   write()  → spawn PTY with --resume → write stdin → PTY exits → ...
 *   kill()   → kill any running PTY + delete session
 */
import type { IPty } from 'node-pty';
import { spawn as ptySpawn } from 'node-pty';
import { spawn as procSpawn, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionSpec } from '@tired-agent/protocol';
import type { SessionRecord } from './types.js';
import { createSessionRecord } from './types.js';
import type { Storage } from './storage.js';
import { log } from '../util/log.js';

export interface LiveSession {
  /** Snapshot from storage — always reflects the latest state. */
  record: SessionRecord;
  /** The active PTY, if currently running a turn. Null between turns. */
  pty: IPty | null;
  /** Subscribers waiting for output / state events (SSE clients). */
  subscribers: Set<(ev: SessionEvent) => void>;
  /**
   * Structured mode only: Claude's internal session_id from the NDJSON
   * init/result events. Passed as --resume on subsequent turns so Claude
   * maintains conversation context across process invocations.
   */
  claudeSessionId?: string;
}

export type SessionEvent =
  | { type: 'output'; offset: number; data: Uint8Array }
  | { type: 'state'; record: SessionRecord };

const live = new Map<string, LiveSession>();

export class SessionManager {
  constructor(private readonly storage: Storage) {}

  /** Create a new session. */
  async create(spec: SessionSpec): Promise<SessionRecord> {
    const id = randomUUID();
    const record = createSessionRecord(id, spec);
    this.storage.insert(record);

    if (record.mode === 'persistent') {
      return this._createPersistent(id, record);
    }

    // PTY mode: spawn immediately.
    try {
      return this._spawnAndAttach(id, record, []);
    } catch (err) {
      this.storage.update({ id, status: 'exited', exitCode: -1, exitedAt: Date.now() });
      const msg = (err as Error).message;
      if (/^File not found/i.test(msg)) {
        throw new Error(
          `Executable "${record.cmd}" not found on the server's PATH. ` +
          `On Windows, try "cmd.exe" or the full path (e.g. "C:\\Users\\me\\bin\\claude.exe").`,
        );
      }
      throw err;
    }
  }

  /** Send input to a session. */
  write(id: string, data: Uint8Array): void {
    const s = live.get(id);
    if (!s) throw new Error(`Session ${id} not found`);

    if (s.record.mode === 'persistent') {
      this._structuredWrite(s, id, data);
      return;
    }

    // PTY mode: write raw bytes directly.
    if (!s.pty) throw new Error(`Session ${id} is not running`);
    s.pty.write(Buffer.from(data).toString('utf8'));
  }

  /** Kill a session. On Windows we use taskkill; on Unix, SIGTERM then SIGKILL. */
  async kill(id: string): Promise<void> {
    const s = live.get(id);
    if (!s) {
      const rec = this.storage.get(id);
      if (!rec) throw new Error(`Session ${id} not found`);
      // Already cleaned up. Delete storage record for structured sessions.
      if (rec.mode === 'persistent') {
        this.storage.delete(id);
      }
      return;
    }

    log.info({ sessionId: id, pid: s.record.pid, mode: s.record.mode }, 'killing session');

    // Kill PTY if alive.
    if (s.pty) {
      this._killPty(s.pty, s.record.pid);
    }

    // For structured sessions: delete storage record entirely (no "exited" state).
    if (s.record.mode === 'persistent') {
      live.delete(id);
      this.storage.delete(id);
      log.info({ sessionId: id }, 'structured session deleted');
      return;
    }

    // PTY mode: mark as exited so subscribers learn about it.
    const finalCode = null;
    this.storage.update({ id, status: 'exited', exitCode: finalCode, exitedAt: Date.now() });
    const rec = this.storage.get(id)!;
    s.record = rec;
    this.broadcast(s, { type: 'state', record: rec });
  }

  /** Resize the PTY. */
  resize(id: string, cols: number, rows: number): void {
    const s = live.get(id);
    if (!s) throw new Error(`Session ${id} is not running`);
    if (!s.pty) throw new Error(`Session ${id} has no active PTY`);
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

  get(id: string): SessionRecord | undefined {
    return live.get(id)?.record ?? this.storage.get(id);
  }

  list(): SessionRecord[] {
    const byId = new Map<string, SessionRecord>();
    for (const rec of this.storage.list()) byId.set(rec.id, rec);
    for (const [id, s] of live) byId.set(id, s.record);
    return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── Persistent mode internals ─────────────────────────────────────────

  /** Create a persistent (chat) session: record only, no PTY yet. */
  private _createPersistent(id: string, record: SessionRecord): SessionRecord {
    const liveSession: LiveSession = {
      record,
      pty: null,
      subscribers: new Set(),
    };
    live.set(id, liveSession);
    log.info({ sessionId: id, cmd: record.cmd, mode: 'persistent' }, 'persistent session created');
    return record;
  }

  /**
   * Handle write() for persistent sessions.
   *
   * Input bytes are expected to be a JSON line (StructuredInput):
   *   {"type":"message","content":"hello","executionMode":"auto"}
   *   {"type":"interrupt"}
   */
  private _structuredWrite(s: LiveSession, id: string, data: Uint8Array): void {
    const text = Buffer.from(data).toString('utf8').trim();
    if (!text) return;

    let input: Record<string, unknown>;
    try {
      input = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error('Invalid JSON input for persistent session');
    }

    switch (input.type) {
      case 'message':
        this._handlePersistentMessage(s, id, input);
        break;
      case 'interrupt':
        this._handlePersistentInterrupt(s, id);
        break;
      default:
        throw new Error(`Unknown input type: ${input.type}`);
    }
  }

  /** Handle a user message: spawn a short-lived Claude process. */
  private _handlePersistentMessage(s: LiveSession, id: string, input: Record<string, unknown>): void {
    if (s.pty) {
      throw new Error('Session is busy processing the previous message');
    }

    const content = String(input.content ?? '');
    if (!content) throw new Error('Message content is empty');

    // Persist the user's prompt into the same append-only log so the full
    // conversation timeline (user + assistant) can be replayed on reopen.
    // Uses a namespaced type to avoid colliding with Claude's own NDJSON
    // `{"type":"user",...}` (tool_result) events.
    this._recordUserMessage(s, id, content);

    // Build args: -p with prompt, stream-json output, optional --resume.
    const args = [
      '-p', content,
      '--output-format', 'stream-json',
      '--verbose',
    ];
    if (s.claudeSessionId) {
      args.push('--resume', s.claudeSessionId);
    }

    try {
      this._spawnPersistentPty(s, id, args);
    } catch (err) {
      log.error({ err, sessionId: id }, 'failed to spawn PTY for persistent turn');
      throw new Error(`Failed to process message: ${(err as Error).message}`);
    }
  }

  /**
   * Append a user prompt to the session log as a namespaced NDJSON event and
   * broadcast it to live subscribers, so the timeline shows the user bubble
   * both live and on replay. Failures here must not abort the turn.
   */
  private _recordUserMessage(s: LiveSession, id: string, content: string): void {
    try {
      const line = JSON.stringify({ type: 'tired-agent/user', content, at: Date.now() }) + '\n';
      const bytes = new TextEncoder().encode(line);
      const newOffset = this.storage.appendOutput(id, bytes);
      const updated = this.storage.get(id);
      if (updated) s.record = updated;
      this.broadcast(s, { type: 'output', offset: newOffset - bytes.length, data: bytes });
      if (updated) this.broadcast(s, { type: 'state', record: updated });
    } catch (err) {
      log.error({ err, sessionId: id }, 'failed to record user message');
    }
  }

  /** Handle interrupt: kill the currently running PTY. */
  private _handlePersistentInterrupt(s: LiveSession, id: string): void {    if (!s.pty) return; // nothing to interrupt
    log.info({ sessionId: id }, 'interrupting persistent turn');
    this._killPty(s.pty, s.record.pid);
    s.pty = null;
    this.storage.update({ id, pid: null });

    const rec = this.storage.get(id)!;
    s.record = rec;
    this.broadcast(s, { type: 'state', record: rec });
  }

  /** Spawn a Claude PTY for one turn. On exit, session stays alive. */
  private _spawnPersistentPty(s: LiveSession, id: string, args: string[]): void {
    const file = process.platform === 'win32' ? 'cmd.exe' : 'claude';
    const spawnArgs = process.platform === 'win32' ? ['/c', 'claude', ...args] : args;

    // Use child_process.spawn (NOT node-pty) for persistent mode.
    // Claude outputs NDJSON with ANSI cursor positioning when stdout is a TTY.
    // A pipe (non-TTY) gives clean NDJSON that we can parse reliably.
    const proc = procSpawn(file, spawnArgs, {
      env: buildEnv(null),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track via a minimal interface so the rest of the manager works.
    const fakePty: IPty = {
      pid: proc.pid ?? null,
      // The TS types for IPty are extensive; the fields the manager actually
      // touches in _handlePersistentInterrupt are pid + kill(), which we
      // route to the child_process kill below.
    } as unknown as IPty;
    s.pty = fakePty;
    this.storage.update({ id, pid: proc.pid });

    let outputBuf = '';

    proc.stdout?.on('data', (buf: Buffer) => {
      try {
        const data = buf.toString('utf8');
        const bytes = new TextEncoder().encode(data);
        const newOffset = this.storage.appendOutput(id, bytes);
        const updated = this.storage.get(id)!;
        s.record = updated;
        this.broadcast(s, { type: 'output', offset: newOffset - bytes.length, data: bytes });
        this.broadcast(s, { type: 'state', record: updated });

        outputBuf += data;
        const sid = extractClaudeSessionId(outputBuf);
        if (sid && sid !== s.claudeSessionId) {
          s.claudeSessionId = sid;
          // Persist so --resume survives an agent restart.
          try { this.storage.update({ id, claudeSessionId: sid }); } catch { /* non-fatal */ }
        }
      } catch (err) {
        log.error({ err, sessionId: id }, 'error handling persistent stdout');
      }
    });

    proc.stderr?.on('data', (buf: Buffer) => {
      try {
        // Capture stderr too (in case Claude logs errors). Tag with prefix so
        // it's distinguishable from NDJSON.
        const data = '[stderr] ' + buf.toString('utf8');
        const bytes = new TextEncoder().encode(data);
        this.storage.appendOutput(id, bytes);
        this.broadcast(s, { type: 'output', offset: 0, data: bytes });
      } catch (err) {
        log.error({ err, sessionId: id }, 'error handling persistent stderr');
      }
    });

    proc.on('exit', (code) => {
      try {
        s.pty = null;
        this.storage.update({ id, pid: null });

        const rec = this.storage.get(id)!;
        s.record = rec;
        this.broadcast(s, { type: 'state', record: rec });
        log.info({ sessionId: id, claudeSessionId: s.claudeSessionId, exitCode: code }, 'persistent turn complete');
      } catch (err) {
        log.error({ err, sessionId: id }, 'error handling persistent exit');
      }
    });

    // Expose a kill() method on the fake IPty.
    (fakePty as unknown as { kill: (sig?: string) => void }).kill = (sig?: string) => {
      try { proc.kill(sig as NodeJS.Signals); } catch { /* already dead */ }
    };
  }

  // ── Common helpers ───────────────────────────────────────────────────

  /** Spawn a PTY and attach it to a new live session. */
  private _spawnAndAttach(id: string, record: SessionRecord, extraArgs: string[]): SessionRecord {
    const file = normalizeCmd(record.cmd);
    const args = [...(record.args ?? []), ...extraArgs];

    let spawnFile = file;
    let spawnArgs = args;
    if (process.platform === 'win32') {
      const lower = file.toLowerCase();
      const isBare = !lower.includes('\\') && !lower.includes('/')
        && !lower.endsWith('.exe') && !lower.endsWith('.cmd') && !lower.endsWith('.bat');
      if (isBare) {
        spawnFile = 'cmd.exe';
        spawnArgs = ['/c', file, ...args];
      }
    }

    const pty = ptySpawn(spawnFile, spawnArgs, {
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

    pty.onData((data: string) => {
      try {
        const bytes = new TextEncoder().encode(data);
        const newOffset = this.storage.appendOutput(id, bytes);
        const updated = this.storage.get(id)!;
        liveSession.record = updated;
        this.broadcast(liveSession, { type: 'output', offset: newOffset - bytes.length, data: bytes });
        this.broadcast(liveSession, { type: 'state', record: updated });
      } catch (err) {
        log.error({ err, sessionId: id }, 'error handling pty data');
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      try {
        const finalCode = exitCode ?? (signal ? 128 + signal : null);
        this.storage.update({
          id, status: 'exited', exitCode: finalCode, exitedAt: Date.now(),
        });
        const rec = this.storage.get(id)!;
        liveSession.record = rec;
        this.broadcast(liveSession, { type: 'state', record: rec });
        log.info({ sessionId: id, exitCode: finalCode }, 'session exited');
      } catch (err) {
        log.error({ err, sessionId: id }, 'error handling pty exit');
      }
    });

    this.storage.update({ id, pid: pty.pid, status: 'running' });
    const started = this.storage.get(id)!;
    liveSession.record = started;
    this.broadcast(liveSession, { type: 'state', record: started });
    log.info({ sessionId: id, pid: pty.pid, cmd: record.cmd }, 'session created');

    return started;
  }

  private _killPty(pty: IPty, pid: number | null): void {
    if (process.platform === 'win32') {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ok */ }
    } else {
      try { pty.kill('SIGTERM'); } catch { /* ok */ }
      setTimeout(() => {
        try { pty.kill('SIGKILL'); } catch { /* ok */ }
      }, 5_000);
    }
  }

  private broadcast(s: LiveSession, ev: SessionEvent) {
    for (const cb of s.subscribers) {
      try { cb(ev); } catch (err) {
        log.error({ err, sessionId: s.record.id }, 'subscriber callback error');
      }
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  private cleanupTimer: NodeJS.Timeout | null = null;
  private static readonly CLEANUP_INTERVAL_MS = 60_000;
  private static readonly CLEANUP_GRACE_MS = 60_000;

  startCleanupTimer(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.pruneStale(), SessionManager.CLEANUP_INTERVAL_MS);
  }

  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  pruneStale(): number {
    const now = Date.now();
    const grace = SessionManager.CLEANUP_GRACE_MS;
    let removed = 0;
    for (const [id, s] of live) {
      // Don't prune structured sessions (they stay until explicitly killed).
      if (s.record.mode === 'persistent') continue;
      if (s.record.status === 'exited'
          && s.subscribers.size === 0
          && (s.record.exitedAt ?? 0) + grace < now) {
        live.delete(id);
        removed++;
      }
    }
    return removed;
  }

  reconcileWithStorage(): number {
    let touched = 0;
    let rehydrated = 0;
    const stored = this.storage.list();
    for (const rec of stored) {
      if (live.has(rec.id)) continue;

      // Persistent (chat) sessions have no long-lived process — each turn
      // spawns a short-lived Claude. On restart, rehydrate them into the
      // live Map (pty: null) so subscribe()/write() work again and the next
      // message resumes context via --resume <claudeSessionId>.
      if (rec.mode === 'persistent') {
        live.set(rec.id, {
          record: rec,
          pty: null,
          subscribers: new Set(),
          claudeSessionId: rec.claudeSessionId ?? undefined,
        });
        rehydrated++;
        continue;
      }

      if (rec.status !== 'exited') {
        this.storage.update({
          id: rec.id, status: 'exited', exitCode: -1, exitedAt: Date.now(),
        });
        touched++;
        log.warn({ sessionId: rec.id }, 'orphaned session marked exited on startup');
      }
    }
    if (rehydrated > 0) log.info({ rehydrated }, 'persistent sessions rehydrated on startup');
    return touched;
  }
}

function normalizeCmd(cmd: string): string {
  return cmd;
}

function buildEnv(extra: Record<string, string> | null): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) base[k] = v;
  }
  delete base['NODE_OPTIONS'];
  if (extra) Object.assign(base, extra);
  return base;
}

/**
 * Extract Claude's session_id from NDJSON output.
 * Scans for `"subtype":"init"` or `"type":"result"` events that contain
 * `"session_id":"..."`. Cached — only scans new data.
 */
function extractClaudeSessionId(output: string): string | null {
  // Look for: ...,"session_id":"<hex>",...
  const m = output.match(/"session_id":"([a-f0-9-]+)"/);
  return m?.[1] ?? null;
}
