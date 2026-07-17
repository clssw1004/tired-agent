/**
 * Renderer Engine — public types.
 *
 * Each session's PTY output runs through exactly one AgentRenderer. With the
 * xterm.js-based TerminalView (see docs/superpowers/specs/2026-07-18-...),
 * renderers exist primarily as **detectors** — they decide which renderer id
 * applies to a given command, and {@link TerminalView} does the actual work
 * of displaying output. Renderers still expose a minimal API so future custom
 * views (canvas dashboards, etc.) can plug in.
 *
 * Renderers do NOT parse ANSI — that's xterm.js's job. They just route bytes
 * to whatever view is registered for their id.
 */

import type { StructuredContent } from '@tired-pc/protocol';

/**
 * How the current segment's content should be combined with the previous one.
 * Kept for backwards-compat with the prior displayMode machinery; the new
 * ChatContainer ignores this and uses append-by-default.
 */
export type DisplayMode = 'chat' | 'replace-last' | 'snapshot' | 'dashboard';

export interface RenderOutput {
  contents: StructuredContent[];
  displayMode: DisplayMode;
  /** Snapshot tag — segments with the same tag replace each other. */
  snapshotTag?: string;
}

/** Per-renderer lifecycle hook + per-chunk context. */
export interface RenderContext {
  session: { cmd: string; args: string[]; label?: string };
  /** True while SSE is still pushing chunks for the current segment. */
  streaming: boolean;
  /** Accumulated contents in this segment so far (for incremental merges). */
  segmentContent: StructuredContent[];
}

/**
 * Implemented per command/agent type. Plugins register a factory; the
 * registry caches one instance per (session, registry) pair.
 *
 * Under the xterm.js architecture, renderers are passive: they don't process
 * bytes themselves. The TerminalView writes chunks directly to xterm. Future
 * renderers (e.g. a custom canvas view) can override `processChunk` to do
 * custom parsing.
 */
export interface AgentRenderer {
  readonly id: string;
  readonly name: string;

  /** Optional: process a chunk of PTY-decoded text. Default is no-op
   *  (TerminalView writes the chunk to xterm itself). */
  processChunk(chunk: string, ctx: RenderContext): RenderOutput | void;

  /** Optional: flush any residual state at end-of-segment. Default no-op. */
  flush(): RenderOutput | void;

  /** Optional: return all structured content the renderer has accumulated. */
  getContents(): StructuredContent[];

  /** Optional: indicate whether the underlying program is awaiting user input. */
  awaitingInput(): boolean;

  /** Discard internal state. Used when switching renderers or on reset. */
  reset(): void;
}

/**
 * Selects a renderer for a given session + early output preview.
 * Higher priority wins; null means "not mine".
 */
export interface AgentDetector {
  readonly id: string;
  readonly priority: number;
  detect(cmd: string, args: string[], previewOutput: string): string | null;
}

/** Single registration entry the registry stores. */
export interface RendererRegistration {
  detector: AgentDetector;
  factory: () => AgentRenderer;
}