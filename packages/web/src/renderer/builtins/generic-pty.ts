/**
 * Generic PTY Renderer — stub for fallback.
 *
 * With the xterm.js-based TerminalView, this renderer is now only used as
 * a detection fallback. The actual ANSI parsing, color rendering, and
 * cursor positioning are all handled by xterm.js. This class is kept for
 * the renderer registry to satisfy the AgentRenderer interface.
 */

import type { StructuredContent } from '@tired-pc/protocol';
import type { AgentDetector, AgentRenderer, RenderContext, RenderOutput } from '../types.js';

export class GenericPtyRenderer implements AgentRenderer {
  readonly id = 'generic-pty';
  readonly name = 'Generic PTY';

  private _contents: StructuredContent[] = [];
  private _awaiting = false;

  processChunk(_chunk: string, _ctx: RenderContext): RenderOutput | void {
    // No-op: TerminalView writes chunks directly to xterm.js.
  }

  flush(): RenderOutput | void {
    // No-op.
  }

  getContents(): StructuredContent[] {
    return this._contents;
  }

  awaitingInput(): boolean {
    return this._awaiting;
  }

  reset(): void {
    this._contents = [];
    this._awaiting = false;
  }
}

export function genericPtyDetector(): AgentDetector {
  return {
    id: 'generic-pty',
    priority: -1,
    detect() {
      return 'generic-pty';
    },
  };
}