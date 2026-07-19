/**
 * Claude Renderer — NDJSON stream parser for structured mode.
 *
 * In structured mode, the Agent spawns `claude -p --output-format stream-json
 * --verbose` for each user message. Claude outputs NDJSON lines like:
 *
 *   {"type":"system","subtype":"init","session_id":"...",...}
 *   {"type":"assistant","message":{"id":"...","role":"assistant",
 *     "content":[{"type":"text","text":"..."},{"type":"tool_use",...}]}}
 *   {"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}
 *   {"type":"result","subtype":"success","session_id":"...",...}
 *
 * This renderer parses those lines into StructuredContent[] for the
 * ChatTimelineView.
 *
 * ## Stream text consolidation
 *
 * Claude's `message.content[]` may contain multiple blocks (thinking, text,
 * tool_use). We flatten them into individual timeline items. Stream events
 * (partial text) are not emitted in this mode since output is delivered as
 * complete blocks rather than per-token deltas.
 */
import type { StructuredContent } from '@tired-agent/protocol';
import type { AgentDetector, AgentRenderer, RenderContext, RenderOutput } from '../types.js';

// ── Claude CLI stream-json event types ────────────────────────────────

interface ClaudeSystemEvent {
  type: 'system';
  subtype: string;
  session_id?: string;
}

interface ClaudeAssistantEvent {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: ClaudeContentBlock[];
    model?: string;
    stop_reason?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
  session_id?: string;
}

interface ClaudeUserEvent {
  type: 'user';
  message: {
    role: 'user';
    content: ClaudeContentBlock[];
  };
  session_id?: string;
}

interface ClaudeResultEvent {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type ClaudeEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent;

// ── Renderer ───────────────────────────────────────────────────────────

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private _contents: StructuredContent[] = [];
  /** Line buffer: PTY may split a JSON line across onData calls. */
  private _lineBuffer = '';

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput | void {
    if (!chunk) return;

    this._lineBuffer += chunk;
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._parseLine(trimmed);
    }

    return { contents: this._contents, displayMode: 'chat' };
  }

  private _parseLine(line: string): void {
    if (line[0] !== '{') {
      // Non-JSON: CLI banner or stray text.
      this._contents.push({ type: 'text', text: line });
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this._contents.push({ type: 'text', text: line });
      return;
    }

    switch (event.type) {
      case 'assistant':
        this._handleAssistant(event as unknown as ClaudeAssistantEvent);
        break;
      case 'user':
        // User events contain tool results — skip (we already have the toolUse).
        break;
      case 'result':
        this._handleResult(event as unknown as ClaudeResultEvent);
        break;
      case 'system':
        // System events (init, hooks, etc.) — silently ignore.
        break;
      default:
        // Unknown — ignore (forward compat).
        break;
    }
  }

  private _handleAssistant(ev: ClaudeAssistantEvent): void {
    if (!ev.message?.content) return;

    const blocks = ev.message.content;

    // Split content into thinking blocks and visible content.
    const thinkingBlocks: string[] = [];
    const visibleBlocks: ClaudeContentBlock[] = [];

    for (const block of blocks) {
      if (block.type === 'thinking') {
        thinkingBlocks.push(block.thinking);
      } else {
        visibleBlocks.push(block);
      }
    }

    // Render thinking as a status indicator (only if there's content).
    for (const t of thinkingBlocks) {
      if (t.trim()) {
        this._contents.push({
          type: 'streamEvent',
          text: '思考中…',
          append: false,
        });
      }
    }

    // Render visible content blocks.
    for (const block of visibleBlocks) {
      switch (block.type) {
        case 'text':
          this._contents.push({ type: 'text', text: block.text });
          break;
        case 'tool_use':
          this._contents.push({
            type: 'toolUse',
            name: block.name,
            input: JSON.stringify(block.input, null, 2),
            toolUseId: block.id,
            completed: false,
          });
          break;
        case 'tool_result':
          this._contents.push({
            type: 'toolResult',
            toolUseId: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: block.is_error ?? false,
          });
          break;
      }
    }

    // Track usage if available.
    if (ev.message.usage) {
      this._contents.push({
        type: 'usage',
        inputTokens: ev.message.usage.input_tokens ?? 0,
        outputTokens: ev.message.usage.output_tokens ?? 0,
      });
    }
  }

  private _handleResult(ev: ClaudeResultEvent): void {
    // Token usage from the final result event.
    if (ev.usage) {
      this._contents.push({
        type: 'usage',
        inputTokens: ev.usage.input_tokens ?? 0,
        outputTokens: ev.usage.output_tokens ?? 0,
      });
    }
  }

  flush(): RenderOutput | void {
    const last = this._lineBuffer.trim();
    if (last) {
      this._parseLine(last);
      this._lineBuffer = '';
    }
    if (this._contents.length > 0) {
      return { contents: this._contents, displayMode: 'chat' };
    }
  }

  getContents(): StructuredContent[] { return this._contents; }
  awaitingInput(): boolean { return false; }
  reset(): void { this._contents = []; this._lineBuffer = ''; }
}

// ── Detector ───────────────────────────────────────────────────────────

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
