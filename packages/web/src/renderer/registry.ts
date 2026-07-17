/**
 * Renderer Registry — first-match-wins selector for {@link AgentRenderer}s.
 *
 * Plugins register a (detector + factory) pair. The registry sorts
 * detectors by descending priority and returns the first one whose
 * detect() returns a non-null id.
 *
 * Default fallback: the {@link GenericPtyRenderer} (priority -1).
 */

import type { AgentDetector, AgentRenderer, RendererRegistration } from './types.js';
import { GenericPtyRenderer } from './builtins/generic-pty.js';

export class RendererRegistry {
  private entries: RendererRegistration[] = [];
  private _fallback: () => AgentRenderer = () => new GenericPtyRenderer();

  /** Register a (detector, factory). Detectors are re-sorted by priority. */
  register(reg: RendererRegistration): this {
    this.entries.push(reg);
    this.entries.sort((a, b) => b.detector.priority - a.detector.priority);
    return this;
  }

  /** Set a custom fallback renderer (default = GenericPtyRenderer). */
  setFallback(factory: () => AgentRenderer): this {
    this._fallback = factory;
    return this;
  }

  /** First registered entry whose detector matches. Creates one fresh
   *  instance per call — renderers own internal state, so they must not
   *  be reused across sessions. */
  select(cmd: string, args: string[], previewOutput: string): AgentRenderer {
    for (const e of this.entries) {
      const id = e.detector.detect(cmd, args, previewOutput);
      if (id !== null) return e.factory();
    }
    return this._fallback();
  }

  /** List registered detectors (debug + status UI). */
  listDetectors(): AgentDetector[] {
    return this.entries.map((e) => e.detector);
  }
}

let _default: RendererRegistry | null = null;
/** Shared registry singleton — modules import & register against this. */
export function defaultRegistry(): RendererRegistry {
  if (!_default) _default = new RendererRegistry();
  return _default;
}
