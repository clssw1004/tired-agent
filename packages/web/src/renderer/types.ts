/**
 * Renderer Engine — public types.
 *
 * Each session's PTY output runs through exactly one AgentRenderer. Renderers
 * convert raw UTF-8 chunks (already decoded from the SSE wire by the
 * transport) into a stream of {@link StructuredContent} and a {@link DisplayMode}
 * hint. The UI layer is renderer-agnostic: it just plays back structured
 * content blocks.
 *
 * See docs/superpowers/specs/2026-07-18-agent-renderer-design.md for the
 * design contract and the list of built-in renderers.
 */

import type { StructuredContent } from '@tired-pc/protocol';

/**
 * How the current segment's content should be combined with the previous one.
 *
 *   chat         → Append content to the open assistant segment (default).
 *   replace-last → Replace the most-recent status/divider block (spinner).
 *   snapshot     → Replace the previous segment wholesale (htop refresh).
 *   dashboard    → Reserved; renders the segment as a panel, not a bubble.
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
 */
export interface AgentRenderer {
  readonly id: string;
  readonly name: string;

  /** Process a chunk of PTY-decoded text. Streaming=false in final pass. */
  processChunk(chunk: string, ctx: RenderContext): RenderOutput;

  /** User just sent a new input. Flush pending state, return residual. */
  flush(): RenderOutput;

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
