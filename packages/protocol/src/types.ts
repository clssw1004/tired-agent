/**
 * Shared type definitions for tired-agent.
 *
 * These types describe the wire-level data exchanged between the
 * client (Expo app) and the server daemon. Both sides import them
 * from this package so the contract is enforced at compile time.
 */

/** Lifecycle state of a PTY session on the server. */
export type SessionStatus = 'starting' | 'running' | 'exited';

/**
 * Session lifecycle mode.
 *
 * - `'process'` (default): session lifecycle is tied to the underlying
 *   process. When the PTY exits, the session auto-terminates. Suitable
 *   for one-shot commands and interactive shells where the session
 *   lifespan matches a single process invocation.
 *
 * - `'persistent'`: the session is a container that outlives individual
 *   process invocations. Each user message spawns a short-lived process;
 *   when it finishes, the session stays alive for the next message.
 *   Suitable for chat/assistant sessions where conversation spans
 *   multiple turns. Only a user Kill removes the session.
 */
export type SessionMode = 'process' | 'persistent';

/**
 * Execution mode for persistent (chat) sessions — controls how Claude
 * handles tool invocations and edits.
 *
 * - `'auto'`: Claude executes tools automatically without asking.
 * - `'manual'`: Claude asks before every tool invocation.
 * - `'plan'`: Claude produces a plan first, then executes on approval.
 */
export type ExecutionMode = 'auto' | 'manual' | 'plan';

/**
 * Structured input message for persistent sessions.
 *
 * Unlike PTY mode which sends raw bytes, persistent sessions send
 * typed JSON messages that the agent interprets. This makes the
 * protocol extensible: new message types (interrupt, config, etc.)
 * can be added without breaking existing clients.
 */
export interface StructuredUserMessage {
  type: 'message';
  content: string;
  /** @default 'auto' */
  executionMode?: ExecutionMode;
}

export interface StructuredInterrupt {
  type: 'interrupt';
}

export type StructuredInput = StructuredUserMessage | StructuredInterrupt;

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
  /**
   * Session lifecycle mode.
   * `'process'` (default) — session follows process lifecycle.
   * `'persistent'` — session lives until user kill.
   * @default 'process'
   */
  mode?: SessionMode;
  /**
   * Execution mode for tool permissions (persistent sessions only).
   * @default 'auto'
   */
  executionMode?: ExecutionMode;
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
  /** @default 'process' */
  mode?: SessionMode;
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

/** A single entry (directory) returned when browsing the filesystem. */
export interface DirectoryEntry {
  name: string;
  path: string;
}

/** Response shape for browsing a directory (`GET /v1/directories`). */
export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

/** A user-saved favorite directory. */
export interface DirectoryFavorite {
  id: string;
  name: string;
  path: string;
}

/** A recently used directory (for quick reuse when creating sessions). */
export interface RecentDirectory {
  path: string;
  lastUsedAt: number;
}

/** Directory shortcuts (favorites + recents) for the session-create UI. */
export interface DirectoryShortcuts {
  favorites: DirectoryFavorite[];
  recent: RecentDirectory[];
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

// ────────────────────────────────────────────────────────────────────────
//  StructuredContent — renderer-agnostic rich output shape.
//
//  The web Agent Rendering Engine (see docs/superpowers/specs/2026-07-18-...)
//  converts raw PTY bytes into a stream of these. Every renderer outputs the
//  same union, regardless of which command was detected (claude / aider / htop
//  / bash — same contract). The UI layer never sees raw ANSI; it just maps
//  each variant to a React component (chat / code / divider / status / table).
//
//  These types live in the protocol package so server and any future client
//  share the same vocabulary, but only the web side consumes them for now.
// ────────────────────────────────────────────────────────────────────────

export interface ContentStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  faint?: boolean;
  inverse?: boolean;
  /** CSS color value (e.g. "#cd3131" or "rgb(200, 50, 50)"). undefined → inherit. */
  color?: string;
  /** CSS background-color. undefined → transparent. */
  background?: string;
  fontSize?: number;
  monospace?: boolean;
}

export interface ContentText {
  type: 'text';
  text: string;
  style?: ContentStyle;
}

export interface ContentCode {
  type: 'code';
  code: string;
  language?: string;
  display: 'inline' | 'block';
}

export interface ContentDivider {
  type: 'divider';
  label?: string;
}

export type StatusKind = 'starting' | 'thinking' | 'working' | 'done' | 'error' | 'idle';

export interface ContentStatus {
  type: 'status';
  status: StatusKind;
  text: string;
  /** Spinner / progress frames: tells the UI to replace the previous status. */
  ephemeral?: boolean;
}

export interface ContentTable {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface ContentLink {
  type: 'link';
  url: string;
  text: string;
}

export interface ContentImage {
  type: 'image';
  alt: string;
  url: string;
}

export interface ContentCommand {
  type: 'command';
  raw: string;
  parsed: string;
}

// ── Structured mode (stream-json) content types ─────────────────────────

export interface ContentUserMessage {
  type: 'userMessage';
  text: string;
}

export interface ContentToolUse {
  type: 'toolUse';
  name: string;
  /** JSON-stringified tool parameters. */
  input: string;
  /** Unique identifier for correlating with tool result. */
  toolUseId: string;
  /** Whether the tool has completed (result received). */
  completed?: boolean;
}

export interface ContentToolResult {
  type: 'toolResult';
  toolUseId: string;
  content: string;
  /** MIME hint for rendering (e.g. "text/markdown", "image/png"). */
  mimeType?: string;
  /** Whether the tool call resulted in an error. */
  isError?: boolean;
}

export interface ContentStreamEvent {
  type: 'streamEvent';
  text: string;
  /** True = append to the last assistant text, false = start new. */
  append: boolean;
}

export interface ContentUsage {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}

export type StructuredContent =
  | ContentText
  | ContentCode
  | ContentDivider
  | ContentStatus
  | ContentTable
  | ContentLink
  | ContentImage
  | ContentCommand
  | ContentUserMessage
  | ContentToolUse
  | ContentToolResult
  | ContentStreamEvent
  | ContentUsage;

/** Error response shape used by the server. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
