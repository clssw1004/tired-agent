import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type { StructuredContent } from '@tired-pc/protocol';
import type { ServerRef } from '@tired-pc/protocol';
import { createHttpSseTransport } from '@tired-pc/protocol';
import {
  AgentRenderer,
  DisplayMode,
  RenderOutput,
  defaultRegistry,
  initRenderers,
  GenericPtyRenderer,
} from '../renderer';
import { StructuredBlock } from './StructuredBlock';

interface Props {
  serverRef: ServerRef;
  sessionId: string;
  sessionStatus: 'starting' | 'running' | 'exited' | string;
  sessionLabel: string;
  sessionCmd: string;
  sessionArgs: string[];
  onBack?: () => void;
}

interface Segment {
  id: number;
  kind: 'user' | 'assistant';
  text?: string;
  blocks?: StructuredContent[];
  ts: number;
  /** Snapshot tag — segments with the same tag replace each other. */
  snapshotTag?: string;
}

const DECODER = new TextDecoder('utf-8', { fatal: false });
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const TYPING_TIMEOUT_MS = 500;
const TICK_INTERVAL_MS = 250;

initRenderers();

function formatTime(ts: number): string {
  const now = Date.now();
  return new Date(ts).toDateString() === new Date(now).toDateString()
    ? TIME_FORMATTER.format(ts)
    : TIME_FORMATTER.format(ts) + ' ·';
}

export function ChatView({
  serverRef,
  sessionId,
  sessionStatus,
  sessionLabel,
  sessionCmd,
  sessionArgs,
  onBack,
}: Props) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [connected, setConnected] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showJumpToEnd, setShowJumpToEnd] = useState(false);

  // Renderer state — one renderer instance per session.
  const rendererRef = useRef<AgentRenderer>(new GenericPtyRenderer());
  const sessionRef = useRef({ cmd: '', args: [] as string[] });
  const idRef = useRef(0);
  const lastChunkAtRef = useRef(0);
  const [, force] = useState(0);

  const segmentsRef = useRef<Segment[]>([]);
  segmentsRef.current = segments;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckToBottomRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const disabled = sessionStatus === 'exited';

  // ── Auto-scroll only when the user is already near the bottom ──────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stuckToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [segments]);

  // Focus input on mount + when session changes
  useEffect(() => {
    if (disabled) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [disabled, sessionId]);

  // Tick — drives typing indicator and snap-to-bottom decisions
  useEffect(() => {
    const t = window.setInterval(() => {
      force((n) => (n + 1) & 0xffff);
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  /** Apply a RenderOutput to the segment list, respecting displayMode. */
  const applyRender = useCallback((out: RenderOutput) => {
    if (!out.contents.length) return;
    setSegments((prev) => {
      const list = prev.slice();
      const last = list[list.length - 1];

      switch (out.displayMode as DisplayMode) {
        case 'replace-last': {
          if (last && last.kind === 'assistant') {
            // Replace the last block(s) in the last assistant segment.
            // If the new output is a single ContentStatus with ephemeral,
            // we patch the *last* status block in place; otherwise we
            // append.
            const seg = { ...last, blocks: (last.blocks ?? []).slice() };
            const firstNew = out.contents[0]!;
            if (out.contents.length === 1 && firstNew.type === 'status' && firstNew.ephemeral) {
              const blocks = seg.blocks!;
              for (let i = blocks.length - 1; i >= 0; i--) {
                if (blocks[i]!.type === 'status') {
                  blocks[i] = firstNew;
                  seg.blocks = blocks;
                  list[list.length - 1] = seg;
                  return list;
                }
              }
            }
            seg.blocks = (seg.blocks ?? []).concat(out.contents);
            list[list.length - 1] = seg;
          } else {
            list.push({
              id: ++idRef.current,
              kind: 'assistant',
              blocks: out.contents,
              ts: Date.now(),
            });
          }
          return list;
        }
        case 'snapshot': {
          // Find the last segment with the same snapshotTag (or the last
          // assistant segment if no tag) and replace it.
          const tag = out.snapshotTag;
          let replaceIdx = -1;
          for (let i = list.length - 1; i >= 0; i--) {
            const s = list[i]!;
            if (s.kind !== 'assistant') break;
            if (tag && s.snapshotTag === tag) { replaceIdx = i; break; }
            if (!tag && (s.snapshotTag || s.snapshotTag === undefined)) {
              replaceIdx = i;
            }
          }
          const seg: Segment = {
            id: ++idRef.current,
            kind: 'assistant',
            blocks: out.contents,
            ts: Date.now(),
            snapshotTag: tag,
          };
          if (replaceIdx >= 0) list[replaceIdx] = seg;
          else list.push(seg);
          return list;
        }
        case 'chat':
        default: {
          if (last && last.kind === 'assistant') {
            const seg = { ...last, blocks: (last.blocks ?? []).slice().concat(out.contents) };
            list[list.length - 1] = seg;
          } else {
            list.push({
              id: ++idRef.current,
              kind: 'assistant',
              blocks: out.contents,
              ts: Date.now(),
            });
          }
          return list;
        }
      }
    });
  }, []);

  // ── SSE subscribe + replay ─────────────────────────────────────────────
  useEffect(() => {
    const transport = createHttpSseTransport();
    let cancelled = false;
    let subscription: { close: () => void } | null = null;

    function selectRenderer(cmd: string, args: string[], preview: string): AgentRenderer {
      const r = defaultRegistry().select(cmd, args, preview);
      return r;
    }

    function appendRawText(text: string) {
      if (!text) return;
      lastChunkAtRef.current = Date.now();
      const out = rendererRef.current.processChunk(text, {
        session: { cmd: sessionRef.current.cmd, args: sessionRef.current.args },
        streaming: true,
        segmentContent: [],
      });
      applyRender(out);
    }

    (async () => {
      try {
        // Fetch initial replay — also lets us pick the right renderer
        // based on the first few bytes of output if cmd-based detection
        // isn't enough.
        const replay = await transport.fetchOutput(serverRef, sessionId, 0);
        if (cancelled) return;

        // Pick a renderer using cmd first, then output preview as fallback.
        const preview = replay.chunks
          .slice(0, 4)
          .map((c) => DECODER.decode(base64ToBytes(c.data)))
          .join('');
        rendererRef.current = selectRenderer(sessionCmd, sessionArgs, preview);
        rendererRef.current.reset();

        let seeded = '';
        for (const chunk of replay.chunks) {
          seeded += DECODER.decode(base64ToBytes(chunk.data));
        }
        if (seeded) {
          const out = rendererRef.current.processChunk(seeded, {
            session: { cmd: sessionCmd, args: sessionArgs },
            streaming: false,
            segmentContent: [],
          });
          applyRender(out);
          lastChunkAtRef.current = Date.now();
        }
        setConnected(true);

        subscription = transport.subscribe(serverRef, sessionId, {
          onChunk: (c) => appendRawText(DECODER.decode(c.data)),
          onState: () => {/* status pill already shown elsewhere */},
          onError: (e) => setTransportError(e.message),
        });
        if (cancelled) subscription.close();
      } catch (err) {
        if (!cancelled) setTransportError((err as Error).message);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.close();
      // Drop internal renderer state on unmount.
      rendererRef.current.reset();
    };
  }, [sessionId, serverRef.id]);

  /** Refresh renderer when sessionCmd / sessionArgs change (after initial
   *  replay — TerminalPage fetches the Session asynchronously). */
  useEffect(() => {
    if (!connected) return;
    const selected = defaultRegistry().select(sessionCmd, sessionArgs, '');
    if (selected.id !== rendererRef.current.id) {
      rendererRef.current = selected;
      rendererRef.current.reset();
      force((n) => (n + 1) & 0xffff);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCmd, sessionArgs.join('|'), connected]);

  // ── Status derivation ──────────────────────────────────────────────────
  const typing = lastChunkAtRef.current > 0 && Date.now() - lastChunkAtRef.current < TYPING_TIMEOUT_MS;
  const status: 'typing' | 'live' | 'connecting' | 'error' | 'offline' = transportError
    ? 'error'
    : !connected
    ? 'connecting'
    : typing
    ? 'typing'
    : sessionStatus === 'exited'
    ? 'offline'
    : 'live';

  // ── Send a line ────────────────────────────────────────────────────────
  const submit = async () => {
    const input = inputRef.current;
    if (!input || sending || disabled) return;
    const text = input.value;
    if (!text) return;
    setSending(true);

    // Flush renderer before user send.
    const flushed = rendererRef.current.flush();
    if (flushed.contents.length > 0) applyRender(flushed);

    const nextId = (segmentsRef.current.reduce((m, s) => Math.max(m, s.id), 0) || 0) + 1;
    setSegments((prev) => [
      ...prev,
      { id: nextId, kind: 'user', text, ts: Date.now() },
      { id: nextId + 1, kind: 'assistant', blocks: [], ts: Date.now() },
    ]);
    input.value = '';
    input.focus();

    try {
      const transport = createHttpSseTransport();
      await transport.sendInput(
        serverRef,
        sessionId,
        new TextEncoder().encode(text + '\r'),
      );
    } catch (err) {
      setTransportError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stuckToBottomRef.current = distance < 40;
    setShowJumpToEnd(distance > 200);
  };

  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stuckToBottomRef.current = true;
    setShowJumpToEnd(false);
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* ignore */ }
  };

  return (
    <div className="chat-panel">
      <header className="chat-header">
        {onBack && (
          <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="chat-avatar chat-avatar-pc" aria-hidden>PC</span>
        <div className="chat-titles">
          <span className="chat-title-name">{sessionLabel || '…'}</span>
          <span className="chat-title-host">{serverRef.name} · {serverRef.baseUrl}</span>
        </div>
        <span className={'chat-status-dot dot-' + sessionStatus} aria-label={'session ' + sessionStatus} />
      </header>

      <div className={'chat-status chat-status-' + status} role="status">
        <span className="chat-status-bar" />
        <span className="chat-status-text">
          {status === 'typing' && 'typing…'}
          {status === 'live' && 'live'}
          {status === 'connecting' && 'connecting…'}
          {status === 'error' && 'disconnected: ' + transportError}
          {status === 'offline' && 'session has exited'}
        </span>
      </div>

      <div className="chat-list" ref={scrollRef} onScroll={onScroll}>
        {segments.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">⏳</div>
            <div className="chat-empty-title">Waiting for the terminal…</div>
            <div className="chat-empty-sub">Type a command and press ↵</div>
          </div>
        )}
        {segments.map((s, i) => {
          const mine = s.kind === 'user';
          const prev = segments[i - 1];
          const showTime = !prev || prev.kind !== s.kind || Math.abs(s.ts - prev.ts) > 60_000;
          return (
            <div key={s.id} className={'chat-row chat-row-' + (mine ? 'user' : 'pc')}>
              {showTime && (
                <div className="chat-time-pill">
                  <span>{mine ? '我' : 'PC'}</span>
                  <span className="chat-time-pill-ts">{formatTime(s.ts)}</span>
                </div>
              )}
              <div className={'chat-bubble chat-bubble-' + (mine ? 'user' : 'pc')}>
                {mine ? (
                  <pre
                    className="chat-bubble-body"
                    onDoubleClick={() => void copyText(s.text ?? '')}
                    title="Double-tap to copy"
                  >
                    <span>{s.text || ' '}</span>
                  </pre>
                ) : s.blocks && s.blocks.length > 0 ? (
                  <div className="chat-bubble-body ct-stack">
                    {s.blocks.map((b, j) => (
                      <StructuredBlock key={j} content={b} />
                    ))}
                  </div>
                ) : (
                  <pre className="chat-bubble-body"><span> </span></pre>
                )}
              </div>
            </div>
          );
        })}
        <button
          type="button"
          className={'chat-jump ' + (showJumpToEnd ? 'visible' : '')}
          onClick={jumpToEnd}
          aria-label="Jump to latest"
        >
          ↓
        </button>
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          disabled={disabled || sending}
          placeholder={
            disabled
              ? 'Session has exited'
              : sending
              ? 'sending…'
              : 'Type a command and press Enter…'
          }
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          className="chat-send"
          disabled={disabled || sending}
          aria-label="Send"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" fill="currentColor" />
          </svg>
        </button>
      </form>
    </div>
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
