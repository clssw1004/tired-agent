/**
 * ClaudeChatView — independent chat component for persistent mode sessions.
 *
 * This is a **self-contained** component for Claude chat sessions. It does NOT
 * share state, effects, or rendering logic with PtySessionView/TerminalView.
 *
 * History replay uses the full log (no `tail` parameter): the NDJSON parser
 * feeds messages into the renderer as complete JSON objects, so any byte-level
 * truncation in the middle of a line would corrupt the JSON boundary and
 * silently drop events. PtySessionView is the only place that opts into the
 * tail fast-load.
 *   1. Header           — back button, session label, status dot.
 *   2. ChatTimeline     — message timeline.
 *   3. ControlBar       — interrupt button, execution mode badge.
 *   4. ChatInput        — multi-line textarea + send + mode/command selectors.
 *
 * Data flow:
 *   sendMessage(text)
 *     → JSON.stringify({type:"message", content:text, executionMode})
 *     → transport.sendInput() → Agent spawns non-TTY child_process
 *     → clean NDJSON via SSE → ClaudeRenderer parses → setContents()
 *
 *   interrupt()
 *     → JSON.stringify({type:"interrupt"})
 *     → transport.sendInput() → Agent kills child process
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerRef, ExecutionMode } from '@tired-agent/protocol';
import { createHttpSseTransport } from '@tired-agent/protocol';
import type { StructuredContent } from '@tired-agent/protocol';
import { ClaudeRenderer } from '../renderer/builtins/claude';
import { ChatTimeline } from './ChatTimeline';

interface Props {
  serverRef: ServerRef;
  agentId: string;
  sessionId: string;
  sessionLabel?: string;
  onBack?: () => void;
}

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

function decodeText(input: Uint8Array): string {
  return DECODER.decode(input);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const EXECUTION_MODES: { value: ExecutionMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
  { value: 'plan', label: 'Plan' },
];

export function ClaudeChatView({
  serverRef,
  agentId,
  sessionId,
  sessionLabel,
  onBack,
}: Props) {
  const [connected, setConnected] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [contents, setContents] = useState<StructuredContent[]>([]);
  const [inputText, setInputText] = useState('');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('auto');
  const [inputMode, setInputMode] = useState(false); // true=typing, false=command select

  const rendererRef = useRef(new ClaudeRenderer());
  const lastChunkAtRef = useRef(0);

  // ── SSE connection ──────────────────────────────────────────────────
  useEffect(() => {
    const transport = createHttpSseTransport();
    let cancelled = false;
    let subscription: { close: () => void } | null = null;

    (async () => {
      try {
        // Fetch historical output for replay.
        const replay = await transport.fetchOutput(serverRef, sessionId, 0, undefined, agentId);
        if (cancelled) return;

        const renderer = rendererRef.current;
        renderer.reset();

        // Replay through renderer.
        let allText = '';
        for (const chunk of replay.chunks) {
          allText += decodeText(base64ToBytes(chunk.data));
        }
        if (allText) {
          renderer.processChunk(allText, {
            session: { cmd: 'claude', args: [] },
            streaming: false,
            segmentContent: [],
          });
          setContents([...renderer.getContents()]);
          lastChunkAtRef.current = Date.now();
        }

        setConnected(true);

        // Live SSE subscription — resume from the offset we already replayed
        // so history is not delivered twice.
        subscription = transport.subscribe(serverRef, sessionId, {
          onChunk: (c) => {
            const text = decodeText(c.data);
            if (!text) return;
            lastChunkAtRef.current = Date.now();
            setStreaming(true);
            renderer.processChunk(text, {
              session: { cmd: 'claude', args: [] },
              streaming: true,
              segmentContent: [],
            });
            setContents([...renderer.getContents()]);
          },
          onState: () => {
            // Status is conveyed via connected/streaming state.
          },
          onError: (e) => setTransportError(e.message),
        }, agentId, replay.upTo);
        if (cancelled) subscription.close();
      } catch (err) {
        if (!cancelled) setTransportError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.close();
      rendererRef.current.reset();
    };
  }, [sessionId, serverRef.id, agentId]);

  // ── Typing timeout — mark streaming as done if no data for 2s ──────
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      if (Date.now() - lastChunkAtRef.current > 2000) {
        setStreaming(false);
      }
    }, 500);
    return () => clearInterval(t);
  }, [streaming]);

  // ── Send message ────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || !connected) return;
    const content = text.trim();

    // The agent records the user prompt into the session log and echoes it
    // back over SSE, so the renderer creates the user bubble from that single
    // source of truth (consistent between live and replay). We only clear the
    // input and show the streaming indicator here.
    setInputText('');
    setStreaming(true);

    try {
      const transport = createHttpSseTransport();
      const msg = JSON.stringify({ type: 'message', content, executionMode }) + '\n';
      await transport.sendInput(serverRef, sessionId, ENCODER.encode(msg), agentId);
    } catch (err) {
      setTransportError((err as Error).message);
    }
  }, [connected, serverRef, sessionId, agentId, executionMode]);

  // ── Interrupt ───────────────────────────────────────────────────────
  const interrupt = useCallback(async () => {
    try {
      const transport = createHttpSseTransport();
      const msg = JSON.stringify({ type: 'interrupt' }) + '\n';
      await transport.sendInput(serverRef, sessionId, ENCODER.encode(msg), agentId);
    } catch (err) {
      setTransportError((err as Error).message);
    }
  }, [serverRef, sessionId, agentId]);

  // ── Input handlers ──────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(inputText);
    }
  };

  // ── Status derivation ──────────────────────────────────────────────
  const status: 'connecting' | 'live' | 'error' | 'offline' = transportError
    ? 'error'
    : !connected
    ? 'connecting'
    : 'live';

  return (
    <div className="chat-panel">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="chat-header">
        {onBack && (
          <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="chat-avatar chat-avatar-pc" aria-hidden>PC</span>
        <div className="chat-titles">
          <span className="chat-title-name">{sessionLabel || 'Claude'}</span>
          <span className="chat-title-host">{serverRef.name} · {serverRef.baseUrl}</span>
        </div>
        <span className={'chat-status-dot dot-' + (connected ? 'running' : 'exited')} aria-label={status} />
      </header>

      {/* ── Status strip ────────────────────────────────────────────── */}
      <div className={'chat-status chat-status-' + status} role="status">
        <span className="chat-status-bar" />
        <span className="chat-status-text">
          {status === 'connecting' && 'connecting…'}
          {status === 'error' && 'disconnected: ' + transportError}
          {status === 'live' && (streaming ? 'generating…' : 'ready')}
        </span>
      </div>

      {/* ── Message timeline ────────────────────────────────────────── */}
      <div className="render-area render-area-structured">
        <ChatTimeline
          contents={contents}
          streaming={streaming}
        />
      </div>

      {/* ── Control bar ─────────────────────────────────────────────── */}
      <div className="claude-control-bar">
        <button
          type="button"
          className="claude-interrupt-btn"
          disabled={!streaming}
          onClick={() => void interrupt()}
        >
          ⏹ 中断
        </button>
        <div className="claude-mode-indicator">
          <span className="claude-mode-dot" data-mode={executionMode} />
          {executionMode}
        </div>
      </div>

      {/* ── Input area ──────────────────────────────────────────────── */}
      <div className="claude-input-area">
        <div className="claude-input-toolbar">
          <div className="claude-input-select-group">
            <button
              type="button"
              className="claude-input-select-btn"
              onClick={() => setInputMode(!inputMode)}
            >
              /<span className="claude-input-cmd">claude</span>
            </button>
            <div className="claude-input-select-sep" />
            <div className="claude-mode-select">
              {EXECUTION_MODES.map(m => (
                <button
                  key={m.value}
                  type="button"
                  className={'claude-mode-opt' + (executionMode === m.value ? ' is-active' : '')}
                  onClick={() => setExecutionMode(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="claude-input-row">
          <textarea
            className="claude-textarea"
            placeholder="输入消息…"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!connected}
            autoFocus
          />
          <button
            type="button"
            className="claude-send-btn"
            disabled={!inputText.trim() || !connected}
            onClick={() => void sendMessage(inputText)}
            aria-label="Send"
          >
            ➤
          </button>
        </div>
      </div>
    </div>
  );
}