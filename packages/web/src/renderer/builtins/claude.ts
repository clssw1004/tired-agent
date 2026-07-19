/**
 * Claude Renderer — NDJSON stream parser for structured mode.
 *
 * When a session is launched in `mode: 'structured'`, the Claude CLI emits
 * NDJSON lines (one JSON object per line) instead of terminal escape sequences.
 * This renderer parses those lines and produces StructuredContent[] that the
 * ChatTimelineView renders as a chat timeline.
 *
 * Compared to the PTY/xterm path, this gives us:
 * - Richer UI: code blocks with syntax highlighting, collapsible tool cards, diffs
 * - Mobile-friendly: native DOM input, no xterm canvas keyboard hacks
 * - Structured data: tool calls and results are separate typed objects
 *
 * ## Stream text consolidation
 *
 * Claude emits separate `stream_event / text_delta` events for each chunk of
 * text. If we pushed one StructuredContent item per delta, the array would
 * grow unbounded (hundreds of items for a single message). Instead, we
 * consolidate: only ONE `streamEvent` item exists at a time, and its `.text`
 * is updated in-place with each delta. When a non-stream event arrives
 * (message, tool_use, etc.), the stream text is finalized (merged into the
 * assistant text) and the streamEvent item is removed.
 *
 * ## Error resilience
 *
 * Non-JSON lines (CLI banner, auth prompts, warnings) fall back to plain text.
 * Unknown event types are silently ignored for forward compatibility.
 * Partial lines across chunk boundaries are buffered and retried.
 */
import type { StructuredContent } from '@tired-agent/protocol';
import type { AgentDetector, AgentRenderer, RenderContext, RenderOutput } from '../types.js';

// ── Claude CLI stream-json NDJSON event types ──────────────────────────

interface ClaudeMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  id?: string;
  model?: string;
}

interface ClaudeToolUse {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  id: string;
}

interface ClaudeToolResult {
  type: 'tool_result';
  tool_use_id: string;
  output?: string;
  content?: string;
  is_error?: boolean;
}

interface ClaudeStreamEvent {
  type: 'stream_event';
  event: string; // e.g. "text_delta", "content_block_start"
  delta?: string;
  index?: number;
}

interface ClaudeControlRequest {
  type: 'control_request';
  kind: string;
  description?: string;
  tool_use_id?: string;
}

interface ClaudeUsage {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
}

type ClaudeEvent =
  | ClaudeMessage
  | ClaudeToolUse
  | ClaudeToolResult
  | ClaudeStreamEvent
  | ClaudeControlRequest
  | ClaudeUsage;

// ── Renderer ───────────────────────────────────────────────────────────

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  /** Accumulated structured content — grows as chunks arrive. */
  private _contents: StructuredContent[] = [];
  /** Line buffer: PTY may split a JSON line across onData calls. */
  private _lineBuffer = '';
  /** Accumulated assistant text (for stream_event append logic). */
  private _currentAssistantText = '';

  // ── Stream text consolidation ────────────────────────────────────────
  /** In-progress stream text accumulator. */
  private _streamAccumulator = '';
  /** Index in _contents of the current streamEvent item (-1 if none). */
  private _streamItemIndex = -1;

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput | void {
    if (!chunk) return;

    // Append to line buffer and split by newlines.
    this._lineBuffer += chunk;
    const lines = this._lineBuffer.split('\n');
    // Keep the last (potentially incomplete) segment in the buffer.
    this._lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this._parseLine(trimmed);
    }

    // Flush accumulated stream text into the (single) streaming item.
    this._flushStreamText();

    return {
      contents: this._contents,
      displayMode: 'chat',
    };
  }

  /** Try to parse a single line as JSON; fall back to plain text. */
  private _parseLine(line: string): void {
    if (line[0] === '{') {
      try {
        const event = JSON.parse(line) as ClaudeEvent;
        this._handleEvent(event);
        return;
      } catch {
        // Not valid JSON — fall through.
      }
    }

    // Non-JSON line: CLI startup output, warnings, etc.
    this._contents.push({ type: 'text', text: line });
  }

  private _handleEvent(event: ClaudeEvent): void {
    switch (event.type) {
      case 'message':
        // Before handling a new message, finalize any in-flight stream text.
        this._finalizeStreamText();
        this._handleMessage(event);
        break;
      case 'tool_use':
        this._finalizeStreamText();
        this._handleToolUse(event);
        break;
      case 'tool_result':
        this._finalizeStreamText();
        this._handleToolResult(event);
        break;
      case 'stream_event':
        this._handleStreamEvent(event);
        break;
      case 'control_request':
        this._finalizeStreamText();
        this._handleControlRequest(event);
        break;
      case 'usage':
        this._handleUsage(event);
        break;
      // Unknown event types are silently ignored for forward compat.
    }
  }

  private _handleMessage(msg: ClaudeMessage): void {
    const text = msg.content ?? '';
    if (msg.role === 'user') {
      this._contents.push({ type: 'userMessage', text });
    } else if (msg.role === 'assistant') {
      this._contents.push({ type: 'text', text });
      this._currentAssistantText = text;
    }
  }

  private _handleToolUse(tool: ClaudeToolUse): void {
    this._contents.push({
      type: 'toolUse',
      name: tool.name,
      input: JSON.stringify(tool.input, null, 2),
      toolUseId: tool.id,
      completed: false,
    });
  }

  private _handleToolResult(result: ClaudeToolResult): void {
    const text = result.output ?? result.content ?? '';
    this._contents.push({
      type: 'toolResult',
      toolUseId: result.tool_use_id,
      content: text,
      isError: result.is_error ?? false,
    });

    // Mark the corresponding toolUse as completed.
    for (const c of this._contents) {
      if (c.type === 'toolUse' && c.toolUseId === result.tool_use_id) {
        c.completed = true;
      }
    }
  }

  private _handleStreamEvent(ev: ClaudeStreamEvent): void {
    if (ev.event !== 'text_delta' || !ev.delta) return;
    this._streamAccumulator += ev.delta;
  }

  private _handleControlRequest(req: ClaudeControlRequest): void {
    const desc = req.description ?? req.kind;
    this._contents.push({
      type: 'status',
      status: 'thinking',
      text: `需要确认: ${desc}`,
    });
  }

  private _handleUsage(usage: ClaudeUsage): void {
    this._contents.push({
      type: 'usage',
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
  }

  // ── Stream text consolidation helpers ────────────────────────────────

  /** Push accumulated stream text into a single streaming item. */
  private _flushStreamText(): void {
    if (!this._streamAccumulator) return;
    const text = this._streamAccumulator;

    if (this._streamItemIndex >= 0 && this._streamItemIndex < this._contents.length) {
      // Update the existing streaming item in-place.
      const existing = this._contents[this._streamItemIndex];
      if (existing.type === 'streamEvent') {
        (existing as { text: string }).text = text;
      }
      this._streamAccumulator = '';
      return;
    }

    // No existing streaming item — create one, accumulate the text.
    this._streamAccumulator = '';
    this._contents.push({
      type: 'streamEvent',
      text,
      append: this._currentAssistantText.length > 0,
    });
    this._streamItemIndex = this._contents.length - 1;
  }

  /**
   * Finalize stream text: move accumulated text into the assistant text
   * buffer and remove the streaming item. Called before adding a non-stream
   * event (message, tool_use, etc.) so the timeline stays clean.
   */
  private _finalizeStreamText(): void {
    // First flush any remaining accumulator.
    this._flushStreamText();

    if (this._streamItemIndex < 0) return;
    const item = this._contents[this._streamItemIndex];
    if (item.type === 'streamEvent') {
      this._currentAssistantText += item.text;
      // Replace the ephemeral streamEvent with a permanent text item.
      this._contents[this._streamItemIndex] = {
        type: 'text',
        text: item.text,
      };
    }
    this._streamItemIndex = -1;
    this._streamAccumulator = '';
  }

  /** Flush any remaining buffered line and stream text. */
  flush(): RenderOutput | void {
    // Parse the last buffered line.
    const last = this._lineBuffer.trim();
    if (last) {
      this._parseLine(last);
      this._lineBuffer = '';
    }

    // Finalize any in-flight stream text.
    this._finalizeStreamText();

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
    this._currentAssistantText = '';
    this._streamAccumulator = '';
    this._streamItemIndex = -1;
  }
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
