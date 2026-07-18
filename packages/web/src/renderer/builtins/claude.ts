/**
 * Claude Renderer — stub.
 *
 * With the xterm.js-based TerminalView, this renderer no longer parses the
 * Claude CLI's TUI output (spinner frames, divider lines, ❯ prompt, [y/N]
 * confirmations). All of that is rendered directly by xterm.js inside
 * TerminalView. Intervention detection ([y/N] prompts) is handled by
 * InterventionBar by reading the xterm buffer.
 *
 * This file is kept only for the renderer registry's detector, which
 * identifies sessions whose cmd is "claude" so the UI can pick a different
 * default view in the future if desired.
 */

import type { StructuredContent } from '@tired-agent/protocol';
import type { AgentDetector, AgentRenderer, RenderContext, RenderOutput } from '../types.js';

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private _contents: StructuredContent[] = [];

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
    return false;
  }

  reset(): void {
    this._contents = [];
  }
}

export function claudeDetector(): AgentDetector {
  return {
    id: 'claude',
    priority: 10,
    detect(cmd, args, preview) {
      const base = (cmd + ' ' + args.join(' ')).toLowerCase();
      if (base.includes('claude')) return 'claude';
      if (preview.includes('●') || preview.includes('✻') || preview.includes('⏸')) return 'claude';
      return null;
    },
  };
}