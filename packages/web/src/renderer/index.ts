/**
 * Renderer entry — public API for the Agent Renderer Registry.
 *
 * Apps wire this in once at module load:
 *
 *   import { initRenderers } from './renderer';
 *   initRenderers();   // registers GenericPtyRenderer + ClaudeRenderer detectors
 *
 * Under the xterm.js-based TerminalView (see docs/superpowers/specs/
 * 2026-07-18-chat-container-redesign.md), the registry is used only for
 * detection: it picks a renderer id based on the command name. The actual
 * rendering of every CLI session happens inside xterm.js. The registry is
 * preserved so future custom views (canvas dashboards, etc.) can be routed
 * by id.
 */

import type { StructuredContent } from '@tired-agent/protocol';

export type {
  AgentRenderer,
  AgentDetector,
  RendererRegistration,
  RenderContext,
  RenderOutput,
  DisplayMode,
} from './types.js';

import { RendererRegistry, defaultRegistry } from './registry.js';
import { GenericPtyRenderer, genericPtyDetector } from './builtins/generic-pty.js';
import { ClaudeRenderer, claudeDetector } from './builtins/claude.js';

export { RendererRegistry, defaultRegistry } from './registry.js';
export { GenericPtyRenderer, genericPtyDetector } from './builtins/generic-pty.js';
export { ClaudeRenderer, claudeDetector } from './builtins/claude.js';
export type { StructuredContent };

let _initialized = false;

/** Auto-register the default renderers (idempotent). */
export function initRenderers(): void {
  if (_initialized) return;
  _initialized = true;

  const reg = defaultRegistry();
  // Claude first (priority 10) — wins for `claude` cmd and Claude TUI markers.
  reg.register({
    detector: claudeDetector(),
    factory: () => new ClaudeRenderer(),
  });
  reg.register({
    detector: genericPtyDetector(),
    factory: () => new GenericPtyRenderer(),
  });
}