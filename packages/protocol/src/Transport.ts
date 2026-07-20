/**
 * Transport interface — abstracts how the client talks to a server daemon.
 *
 * The MVP implementation is `HttpSseTransport` (HTTP REST + Server-Sent Events).
 * A future `WebSocketTransport` can implement the same interface so the UI
 * code does not need to change.
 *
 * Each method accepts an optional `agentId`. When set, the call is routed
 * through a Manager's proxy (`/v1/agents/:aid/...`) to a specific Agent.
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
  /** List all sessions on a daemon (direct or via manager proxy). */
  listSessions(ref: ServerRef, agentId?: string): Promise<Session[]>;

  /** Create a new session on a daemon. */
  createSession(ref: ServerRef, spec: SessionSpec, agentId?: string): Promise<Session>;

  /** Fetch metadata for a single session. */
  getSession(ref: ServerRef, id: string, agentId?: string): Promise<Session>;

  /**
   * Kill a session (SIGTERM, then SIGKILL after a grace period).
   * If the session is already exited, the row + its append-only log are
   * removed from storage instead.
   */
  killSession(ref: ServerRef, id: string, agentId?: string): Promise<void>;

  /**
   * Permanently delete an already-exited session (row + log file).
   * For running sessions the server will return an error.
   */
  deleteSession(ref: ServerRef, id: string, agentId?: string): Promise<void>;

  /**
   * Bulk-delete all sessions whose last activity is older than
   * `olderThanHours` hours. Returns the count removed so the UI can
   * surface a "X zombies cleaned" toast.
   */
  pruneSessions(ref: ServerRef, olderThanHours?: number, agentId?: string): Promise<{ removed: number }>;

  /** Resize the underlying PTY. */
  resizeSession(
    ref: ServerRef,
    id: string,
    cols: number,
    rows: number,
    agentId?: string,
  ): Promise<void>;

  /** Fetch historical output from a session's log file. */
  fetchOutput(
    ref: ServerRef,
    id: string,
    fromOffset: number,
    limit?: number,
    agentId?: string,
  ): Promise<FetchOutputResult>;

  /**
   * Open a live subscription (SSE).
   *
   * `fromOffset` is the byte offset the client already has (e.g. after an
   * initial `fetchOutput`). The stream replays from there and then follows
   * live, so history is not delivered twice. Defaults to 0 (full replay).
   */
  subscribe(
    ref: ServerRef,
    id: string,
    handlers: SubscribeHandlers,
    agentId?: string,
    fromOffset?: number,
  ): Subscription;

  /** Send input bytes to the session's PTY. */
  sendInput(ref: ServerRef, id: string, data: Uint8Array, agentId?: string): Promise<void>;

  // ── Manager-specific operations ────────────────────────────────────────
  // These are only valid when the ref points to a Manager. They are
  // declared on Transport (not a separate interface) so the SPA can call
  // them through the same factory without switching clients.

  /** Log in to a Manager with its admin token. Returns a session token. */
  login(ref: ServerRef, token: string): Promise<{ sessionToken: string }>;

  /** Verify the current session token is still valid. */
  checkSession(ref: ServerRef): Promise<boolean>;

  /** List agents registered with this Manager. */
  listAgents(ref: ServerRef): Promise<{ id: string; name: string; baseUrl: string }[]>;

  /** Register a new Agent with this Manager. */
  addAgent(ref: ServerRef, agent: { name: string; baseUrl: string; token: string }): Promise<{ id: string }>;

  /** Remove an Agent from this Manager. */
  deleteAgent(ref: ServerRef, agentId: string): Promise<void>;
}
