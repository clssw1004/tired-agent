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
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean };

// ── Renderer ───────────────────────────────────────────────────────────

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private _contents: StructuredContent[] = [];
  /** Line buffer: holds the trailing partial line if a chunk splits mid-line. */
  private _lineBuffer = '';

  /**
   * Cumulative snapshot dedup index.
   *
   * `--verbose` mode causes Claude to emit each `assistant` event with the
   * FULL message.content array, not just new blocks. We track how many
   * blocks we've already emitted per message to avoid duplicates.
   *
   * Ported from `claude-code-parser`'s Translator (MIT license):
   * https://github.com/hesreallyhim/awesome-claude-code/issues/1046
   */
  private _lastContentIndex = 0;
  /** Fingerprint of the first content block — detects context switches. */
  private _lastFirstBlockKey = '';

  processChunk(chunk: string, _ctx: RenderContext): RenderOutput | void {
    if (!chunk) return;

    // Strip ANSI escape codes and stray carriage returns. The Agent spawns
    // Claude via a non-TTY pipe (child_process.spawn) so the output is clean
    // NDJSON — no cursor positioning codes, no \r. We still strip defensively.
    const cleaned = stripAnsi(chunk).replace(/\r/g, '');
    if (!cleaned) return;

    this._lineBuffer += cleaned;
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this._parseLine(trimmed);
      } catch {
        // Silently skip malformed lines
      }
    }

    return { contents: this._contents, displayMode: 'chat' };
  }

  private _parseLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (event.type) {
      case 'assistant':
        this._handleAssistant(event as unknown as ClaudeAssistantEvent);
        break;
      case 'user':
        this._handleUser(event as unknown as ClaudeUserEvent);
        break;
      case 'result':
        this._handleResult(event as unknown as ClaudeResultEvent);
        break;
      case 'system':
        if (event.subtype === 'result') {
          this._handleSystemResult(event as Record<string, unknown>);
        }
        break;
    }
  }

  // ── Assistant ────────────────────────────────────────────────────────

  private _handleAssistant(ev: ClaudeAssistantEvent): void {
    if (!ev.message?.content || ev.message.content.length === 0) return;

    const msg = ev.message;
    const blocks = msg.content;

    // Context switch detection: fingerprint the first block
    const firstKey = _blockFingerprint(blocks[0]);
    if (firstKey !== this._lastFirstBlockKey) {
      this._lastContentIndex = 0;
      this._lastFirstBlockKey = firstKey;
    }
    if (blocks.length < this._lastContentIndex) {
      this._lastContentIndex = 0;
    }

    // Only process NEW blocks
    for (let i = this._lastContentIndex; i < blocks.length; i++) {
      this._emitBlock(blocks[i]);
    }
    this._lastContentIndex = blocks.length;

    // Track usage if available (only on first emission of this message)
    if (msg.usage && this._lastContentIndex > 0 && !this._usageAdded) {
      this._contents.push({
        type: 'usage',
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
      });
      this._usageAdded = true;
    }
  }

  /** Emit a single content block to _contents. */
  private _emitBlock(block: ClaudeContentBlock): void {
    switch (block.type) {
      case 'thinking': {
        const text = block.thinking ?? block.text ?? '';
        if (text.trim()) {
          this._contents.push({ type: 'streamEvent', text: '思考中…', append: false });
        }
        break;
      }
      case 'text': {
        const text = block.text ?? '';
        if (text) {
          // Replace any pending "思考中…" placeholders — thinking is done,
          // the actual answer is starting. Keeps the timeline from being
          // stuck on the thinking indicator.
          this._contents = this._contents.filter(
            (c) => !(c.type === 'streamEvent' && (c.text === '思考中…' || c.text.includes('思考'))),
          );
          this._contents.push({ type: 'text', text });
        }
        break;
      }
      case 'tool_use':
        this._contents.push({
          type: 'toolUse',
          name: block.name ?? '',
          input: block.input != null ? JSON.stringify(block.input, null, 2) : '',
          toolUseId: block.id ?? '',
          completed: false,
        });
        break;
      case 'tool_result':
        this._contents.push({
          type: 'toolResult',
          toolUseId: block.tool_use_id ?? '',
          content: extractToolContent(block.content),
          isError: block.is_error ?? false,
        });
        break;
    }
  }

  // ── User (tool results) ──────────────────────────────────────────────

  private _handleUser(ev: ClaudeUserEvent): void {
    if (!ev.message?.content) return;

    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id ?? '';
        // Mark matching toolUse as completed
        for (const c of this._contents) {
          if (c.type === 'toolUse' && c.toolUseId === toolUseId) {
            c.completed = true;
          }
        }
        // Don't push a separate toolResult (tool_use already handles it)
      }
    }
  }

  // ── Result ───────────────────────────────────────────────────────────

  private _handleResult(ev: ClaudeResultEvent): void {
    // Turn complete → reset dedup state for next turn
    this._resetTurn();

    if (ev.subtype === 'error' || ev.is_error) {
      this._contents.push({
        type: 'status',
        status: 'error',
        text: parseResultText(ev.result),
      });
      return;
    }

    // Usage from the result event (fallback if not in assistant message)
    if (ev.usage && !this._usageAdded) {
      this._contents.push({
        type: 'usage',
        inputTokens: ev.usage.input_tokens ?? 0,
        outputTokens: ev.usage.output_tokens ?? 0,
      });
      this._usageAdded = true;
    }
  }

  /**
   * Handle `system` events with `subtype: "result"`.
   * Claude Code emits these for hook results and other internal operations.
   */
  private _handleSystemResult(ev: Record<string, unknown>): void {
    if (ev.is_error) {
      this._contents.push({
        type: 'status',
        status: 'error',
        text: parseResultText(ev.result),
      });
    }
  }

  // ── Turn tracking ────────────────────────────────────────────────────

  private _usageAdded = false;

  private _resetTurn(): void {
    this._lastContentIndex = 0;
    this._lastFirstBlockKey = '';
    this._usageAdded = false;
  }

  // ── Public API ───────────────────────────────────────────────────────

  flush(): RenderOutput | void {
    if (this._lineBuffer.trim()) {
      try {
        this._parseLine(this._lineBuffer.trim());
      } catch { /* skip */ }
      this._lineBuffer = '';
    }
    if (this._contents.length > 0) {
      return { contents: this._contents, displayMode: 'chat' };
    }
  }

  addUserMessage(text: string): void {
    this._contents.push({ type: 'userMessage', text });
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
    this._resetTurn();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from PTY output. */
function stripAnsi(text: string): string {
  if (!text) return text;
  // Strip all ANSI escape sequences comprehensively:
  // - CSI sequences: ESC [ <param> <final>   (param may include ; ? : characters)
  // - OSC sequences: ESC ] ... (ST \x1b\\ or BEL \x07)
  // - Individual C1 controls (80-9f range, e.g. ESC followed by one byte)
  // - Broad catch: anything that starts with ESC and follows ANSI patterns
  return text
    // CSI: ESC [ [params] [intermediate] [final]
    // params: digits, ;, :, ?, bytes 0x30-0x3f
    // intermediate: bytes 0x20-0x2f
    // final: bytes 0x40-0x7e
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
    // OSC: ESC ] ... terminated by ST (\x1b\\) or BEL (\x07)
    .replace(/\x1b\].*?(?:\x1b\\|\x07)/g, '')
    // Any other ESC-start sequence (DCS, SOS, PM, APC, etc.)
    .replace(/\x1b[PX^_].*?(?:\x1b\\|$)/g, '')
    // Lone ESC + one char in range 0x40-0x5f (2-byte ansi)
    .replace(/\x1b[\x40-\x5f]/g, '')
    // Remaining stray ESC bytes
    .replace(/\x1b/g, '');
}

/**
 * Handle the polymorphic `content` field in tool_result blocks.
 * Three possible shapes:
 * 1. string — plain text
 * 2. Array<{ type: string; text: string }> — structured text blocks
 * 3. null / undefined — empty string
 */
function extractToolContent(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .filter((b): b is Record<string, unknown> => b != null && typeof b === 'object')
      .map((b) => String((b as Record<string, unknown>)['text'] ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(raw);
}

/**
 * Parse the double-encoded `result` field.
 * Claude Code's result field is sometimes a JSON-encoded string
 * (e.g., `"\"actual text\""` instead of `"actual text"`).
 */
function parseResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not double-encoded, use as-is
    }
    return result;
  }
  return String(result);
}

/**
 * Fingerprint a content block for context-switch detection.
 *
 * tool_use blocks use their unique ID, text/thinking blocks use the first
 * 64 chars of their content. When the fingerprint changes between
 * `assistant` events, it means a new turn/agent started — reset dedup.
 */
function _blockFingerprint(block: ClaudeContentBlock): string {
  const b = block as Record<string, unknown>;
  if (b['id']) return `${b['type']}:${b['id']}`;
  const text = b['thinking'] ?? b['text'] ?? '';
  return text ? `${b['type']}:${String(text).slice(0, 64)}` : String(b['type']);
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
