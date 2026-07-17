/**
 * Shared type definitions for tired-pc.
 *
 * These types describe the wire-level data exchanged between the
 * client (Expo app) and the server daemon. Both sides import them
 * from this package so the contract is enforced at compile time.
 */

/** Lifecycle state of a PTY session on the server. */
export type SessionStatus = 'starting' | 'running' | 'exited';

/**
 * Specification for creating a new session.
 * Mirrors the request body of `POST /v1/sessions`.
 */
export interface SessionSpec {
  /** Executable to spawn, e.g. "claude", "bash", "cat". */
  cmd: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Working directory of the child process. */
  cwd?: string;
  /** Extra environment variables merged on top of the daemon's env. */
  env?: Record<string, string>;
  /** PTY columns. Default 80. */
  cols?: number;
  /** PTY rows. Default 24. */
  rows?: number;
  /** Human-friendly label shown in the client UI. */
  label?: string;
}

/**
 * Server-side metadata for a session.
 *
 * `byteOffset` is the running total of PTY output bytes written to the
 * session's append-only log file. Clients use this as the resume cursor:
 * they remember the last offset they have seen, and on reconnect fetch
 * everything from that offset onward via `GET /v1/sessions/:id/output`.
 */
export interface Session {
  id: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  status: SessionStatus;
  pid?: number;
  exitCode?: number | null;
  createdAt: number;
  exitedAt?: number;
  byteOffset: number;
  cols: number;
  rows: number;
  label?: string;
}

/**
 * A chunk of PTY output bytes.
 * `offset` is the absolute position in the session's log file where
 * this chunk starts, and `data` are the raw bytes (typically ANSI text).
 */
export interface OutputChunk {
  offset: number;
  data: Uint8Array;
}

/**
 * A reference to a server daemon, stored locally on the client.
 * `baseUrl` is the HTTPS root, `token` is the bearer token to authenticate
 * every request against that daemon.
 */
export interface ServerRef {
  /** Client-local UUID (generated when the user adds the server). */
  id: string;
  /** Human-friendly name, e.g. "Home Desktop". */
  name: string;
  /** HTTPS root, e.g. "https://192.168.1.10:8443". */
  baseUrl: string;
  /** Bearer token configured on the server. */
  token: string;
}

/** Response shape for `GET /v1/sessions/:id/output`. */
export interface FetchOutputResult {
  chunks: Array<{
    offset: number;
    /** Base64-encoded bytes (JSON-safe). */
    data: string;
  }>;
  /** Total bytes currently in the log file (for offset bookkeeping). */
  upTo: number;
}

/** Body of `POST /v1/sessions/:id/input`. */
export interface InputRequest {
  /** Base64-encoded bytes to write to the PTY. */
  data: string;
}

/** Body of `POST /v1/sessions/:id/resize`. */
export interface ResizeRequest {
  cols: number;
  rows: number;
}

/** SSE event types emitted on `/v1/sessions/:id/stream`. */
export type StreamEvent =
  | { type: 'output'; offset: number; data: string }
  | { type: 'state'; session: Session }
  | { type: 'heartbeat'; ts: number };

/** Error response shape used by the server. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
