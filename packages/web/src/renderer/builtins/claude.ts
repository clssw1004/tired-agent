/**
 * Claude Renderer — structured mode text renderer.
 *
 * Currently, structured mode is a rendering enhancement on the web side:
 * the agent spawns Claude in normal PTY mode, and this renderer accumulates
 * the text output into simple text StructuredContent items for timeline
 * display (instead of xterm canvas).
 *
 * Future phases will add NDJSON stream-json parsing when Claude's -p/--print
 * mode is properly integrated.
 */
import type { StructuredContent } from '@tired-agent/protocol';
import type { AgentDetector, AgentRenderer, RenderContext, RenderOutput } from '../types.js';

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private _contents: StructuredContent[] = [];
  /** Buffer incomplete lines across chunk boundaries. */
  private _lineBuffer = '';

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput | void {
    if (!chunk) return;

    // Accumulate into the last text item, or create a new one.
    const last = this._contents[this._contents.length - 1];
    if (last?.type === 'text') {
      (last as { text: string }).text += chunk;
    } else {
      this._contents.push({ type: 'text', text: chunk });
    }

    return {
      contents: this._contents,
      displayMode: 'chat',
    };
  }

  flush(): RenderOutput | void {
    if (this._contents.length > 0) {
      return { contents: this._contents, displayMode: 'chat' };
    }
  }

  getContents(): StructuredContent[] {
    return this._contents;
  }

  awaitingInput(): boolean {
    return false;
  }

  reset(): void {
    this._contents = [];
    this._lineBuffer = '';
  }
}

export function claudeDetector(): AgentDetector {
  return {
    id: 'claude',
    priority: 10,
    detect(cmd, _args, _preview) {
      const base = cmd.toLowerCase();
      if (base.includes('claude')) return 'claude';
      return null;
    },
  };
}
