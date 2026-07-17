/**
 * Transport interface — abstracts how the client talks to a server daemon.
 *
 * The MVP implementation is `HttpSseTransport` (HTTP REST + Server-Sent Events).
 * A future `WebSocketTransport` can implement the same interface so the UI
 * code does not need to change.
 */

import type {
  FetchOutputResult,
  OutputChunk,
  Session,
  ServerRef,
  SessionSpec,
} from './types.js';

/** Handlers called by a live subscription (one per session). */
export interface SubscribeHandlers {
  onChunk: (chunk: OutputChunk) => void;
  onState: (session: Session) => void;
  onError: (err: Error) => void;
}

/**
 * A live subscription. Calling `close()` stops receiving events
 * and releases any underlying resources (EventSource, WebSocket, etc.).
 */
export interface Subscription {
  close(): void;
}

/**
 * Transport — the contract every implementation must satisfy.
 *
 * The client UI code only ever depends on this interface, never on a
 * concrete implementation, so swapping HTTP+SSE for WebSocket later
 * is a drop-in change.
 */
export interface Transport {
  /**
   * List all sessions known to the server daemon (any status,
   * including 'exited'). The server persists sessions across restarts.
   */
  listSessions(ref: ServerRef): Promise<Session[]>;

  /**
   * Create a new session. The server spawns the requested process
   * inside a PTY and returns the initial metadata (status='starting'
   * or 'running' depending on how fast spawn returns).
   */
  createSession(ref: ServerRef, spec: SessionSpec): Promise<Session>;

  /**
   * Fetch metadata for a single session. Throws if not found.
   */
  getSession(ref: ServerRef, id: string): Promise<Session>;

  /**
   * Kill a session (SIGTERM, then SIGKILL after a grace period).
   * If the session is already exited, the row + its append-only log are
   * removed from storage instead.
   */
  killSession(ref: ServerRef, id: string): Promise<void>;

  /**
   * Permanently delete an already-exited session (row + log file).
   * For running sessions the server will return an error.
   */
  deleteSession(ref: ServerRef, id: string): Promise<void>;

  /**
   * Bulk-delete all sessions whose last activity is older than
   * `olderThanHours` hours. Returns the count removed so the UI can
   * surface a "X zombies cleaned" toast.
   */
  pruneSessions(ref: ServerRef, olderThanHours?: number): Promise<{ removed: number }>;

  /**
   * Resize the underlying PTY. Clients should call this when the
   * terminal view is resized (orientation change on mobile, etc.).
   */
  resizeSession(
    ref: ServerRef,
    id: string,
    cols: number,
    rows: number,
  ): Promise<void>;

  /**
   * Fetch historical output from a session's log file.
   *
   * @param fromOffset  Byte offset the client last consumed.
   * @param limit       Optional cap on bytes returned (server may round up to chunk boundaries).
   */
  fetchOutput(
    ref: ServerRef,
    id: string,
    fromOffset: number,
    limit?: number,
  ): Promise<FetchOutputResult>;

  /**
   * Open a live subscription. New output is delivered via `handlers.onChunk`,
   * state changes via `onState`, transport errors via `onError`.
   *
   * Implementations should auto-reconnect transparently (so the UI does
   * not have to deal with network blips), but surface persistent failures
   * via `onError` after exhausting retries.
   */
  subscribe(
    ref: ServerRef,
    id: string,
    handlers: SubscribeHandlers,
  ): Subscription;

  /**
   * Send input bytes to the session's PTY. Typically the user-typed
   * text plus a carriage return.
   */
  sendInput(ref: ServerRef, id: string, data: Uint8Array): Promise<void>;
}
