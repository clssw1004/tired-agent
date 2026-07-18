/**
 * ChatContainer — top-level shell for a single session's UI.
 *
 * Layout (top to bottom):
 *   1. Header           — title + status dot.
 *   2. Status strip     — live / typing / connecting / error / offline indicator.
 *   3. RenderArea       — TerminalView (xterm.js) for every CLI session.
 *   4. InterventionBar  — appears above the input when the terminal is waiting
 *                         on a [y/N] prompt (Claude's permission dialogs, etc.).
 *   5. InputBar         — mobile soft-keyboard passthrough. Each keystroke is
 *                         shipped verbatim to the PTY; Enter is just `\r`,
 *                         same as any other character.
 *
 * Keyboard model: xterm.js owns the full TUI surface. The InputBar exists
 * ONLY to summon the mobile soft keyboard (xterm's canvas does not). On
 * desktop users click the terminal; on mobile they tap the input field.
 * Both paths converge on the same `writeBytes(data)` that ships bytes to
 * the PTY.
 *
 * History replay: on mount, fetchOutput(0) replays all bytes into xterm so
 * the user lands on a fully-rendered screen before live SSE chunks arrive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerRef, SessionStatus } from '@tired-agent/protocol';
import { createHttpSseTransport } from '@tired-agent/protocol';
import { defaultRegistry, initRenderers, GenericPtyRenderer } from '../renderer';
import type { AgentRenderer } from '../renderer';
import { TerminalView, type TerminalHandle } from './render-views';
import { InterventionBar } from './InterventionBar';
import { InputBar } from './InputBar';
import { SpecialKeysBar } from './SpecialKeysBar';

interface Props {
  serverRef: ServerRef;
  /** Id of the Agent this session belongs to; used to route through the Manager proxy. */
  agentId: string;
  sessionId: string;
  sessionStatus: SessionStatus | string;
  sessionLabel: string;
  sessionCmd: string;
  sessionArgs: string[];
  onBack?: () => void;
}

const TYPING_TIMEOUT_MS = 500;
const TICK_INTERVAL_MS = 250;
const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

/** TextDecoder.decode wrapper — newer TS lib types prefer BufferSource overloads. */
function decodeText(input: Uint8Array): string {
  return DECODER.decode(input);
}

initRenderers();

export function ChatContainer({
  serverRef,
  agentId,
  sessionId,
  sessionStatus,
  sessionLabel,
  sessionCmd,
  sessionArgs,
  onBack,
}: Props) {
  const [connected, setConnected] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [termReady, setTermReady] = useState(false);
  const [selection, setSelection] = useState('');
  const [copyFlash, setCopyFlash] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [busy, setBusy] = useState(false);

  const termRef = useRef<TerminalHandle>(null);
  const rendererRef = useRef<AgentRenderer>(new GenericPtyRenderer());
  const lastChunkAtRef = useRef(0);
  const [, force] = useState(0);
  const sessionRef = useRef({ cmd: '', args: [] as string[] });

  const disabled = sessionStatus === 'exited';

  // Heartbeat tick — drives the typing indicator + status pill updates.
  useEffect(() => {
    const t = window.setInterval(() => {
      force((n) => (n + 1) & 0xffff);
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  // ── PTY writer: shared by xterm.onUserInput, InputBar.onChange, and
  //    InterventionBar.onResponse. Everything funnels through one path so
  //    there is exactly one place to log / debounce / handle backpressure.
  const writeBytes = useCallback(async (data: string) => {
    if (disabled || !data) return;
    try {
      const transport = createHttpSseTransport();
      await transport.sendInput(serverRef, sessionId, ENCODER.encode(data), agentId);
    } catch (err) {
      setTransportError((err as Error).message);
    }
  }, [disabled, serverRef, sessionId, agentId]);

  // ── Copy selected text from xterm to clipboard. Mobile Safari doesn't
  //    surface a copy button on long-press selection by default, so we
  //    show our own floating action button whenever a non-empty selection
  //    exists in the terminal.
  const copySelection = useCallback(async () => {
    const text = termRef.current?.getSelection() ?? '';
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for older WebViews: textarea + execCommand
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyFlash(true);
      try { navigator.vibrate?.(10); } catch { /* iOS no-op */ }
      window.setTimeout(() => setCopyFlash(false), 900);
    } catch { /* ignore — user can still long-press to copy manually */ }
    termRef.current?.clearSelection();
    setSelection('');
  }, []);

  // Connect, replay history, subscribe to live chunks.
  useEffect(() => {
    const transport = createHttpSseTransport();
    let cancelled = false;
    let subscription: { close: () => void } | null = null;

    (async () => {
      try {
        const replay = await transport.fetchOutput(serverRef, sessionId, 0, undefined, agentId);
        if (cancelled) return;

        const preview = replay.chunks
          .slice(0, 4)
          .map((c) => decodeText(base64ToBytes(c.data)))
          .join('');

        const renderer = defaultRegistry().select(sessionCmd, sessionArgs, preview);
        renderer.reset();
        rendererRef.current = renderer;
        sessionRef.current = { cmd: sessionCmd, args: sessionArgs };

        let seeded = '';
        for (const chunk of replay.chunks) {
          seeded += decodeText(base64ToBytes(chunk.data));
        }
        if (seeded) {
          termRef.current?.write(seeded);
          lastChunkAtRef.current = Date.now();
        }

        setConnected(true);

        subscription = transport.subscribe(serverRef, sessionId, {
          onChunk: (c) => {
            const text = decodeText(c.data);
            if (!text) return;
            lastChunkAtRef.current = Date.now();
            // Respect manual scroll: if the user has scrolled up to read
            // history, don't yank them back to the bottom on each chunk —
            // the "jump to latest" pill lets them return when ready.
            const wasAtBottom = termRef.current?.isAtBottom() ?? true;
            termRef.current?.write(text);
            if (wasAtBottom) termRef.current?.scrollToBottom();
            renderer.processChunk(text, {
              session: sessionRef.current,
              streaming: true,
              segmentContent: [],
            });
          },
          onState: () => { /* status pill driven by sessionStatus prop */ },
          onError: (e) => setTransportError(e.message),
        }, agentId);
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

  // If session metadata loads asynchronously (TerminalPage fetches Session),
  // re-select the renderer with the actual cmd/args.
  useEffect(() => {
    if (!connected) return;
    const selected = defaultRegistry().select(sessionCmd, sessionArgs, '');
    if (selected.id !== rendererRef.current.id) {
      rendererRef.current = selected;
      rendererRef.current.reset();
    }
    sessionRef.current = { cmd: sessionCmd, args: sessionArgs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCmd, sessionArgs.join('|'), connected]);

  // Busy detection — the underlying CLI is actively working (spinner frames,
  // Claude "esc to interrupt" hint, etc.). We dim the InputBar in this state
  // so the user understands they can't type yet, and we keep SpecialKeysBar
  // fully active so Ctrl+C remains a one-tap interrupt.
  useEffect(() => {
    if (!termReady) return;
    const handle = termRef.current;
    if (!handle) return;
    const SPINNER = /[●✻✽✶✢⠂⠐⠈⠘⠸⠰⠠⠄·*]/;
    const INTERRUPT = /esc to interrupt|press esc to interrupt/i;
    const check = () => {
      const lines = handle.getLastLines(6).map((l) => l.trim()).filter(Boolean);
      let next = false;
      for (const line of lines) {
        if (SPINNER.test(line[0] ?? '') || INTERRUPT.test(line)) { next = true; break; }
      }
      setBusy((prev) => prev === next ? prev : next);
    };
    check();
    return handle.onWrite(check);
  }, [termReady]);

  // ── Status derivation ──────────────────────────────────────────────────
  const typing = lastChunkAtRef.current > 0
    && Date.now() - lastChunkAtRef.current < TYPING_TIMEOUT_MS;
  const status: 'typing' | 'live' | 'connecting' | 'error' | 'offline' = transportError
    ? 'error'
    : !connected
    ? 'connecting'
    : typing
    ? 'typing'
    : sessionStatus === 'exited'
    ? 'offline'
    : 'live';

  return (
    <div className={'chat-panel' + (busy ? ' is-busy' : '')}>
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

      <div
        className="render-area"
        onClick={() => termRef.current?.focus()}
      >
        <TerminalView
          ref={termRef}
          onReady={() => setTermReady(true)}
          onUserInput={(data) => void writeBytes(data)}
          onSelectionChange={(text) => setSelection(text)}
          onScroll={(ab) => setAtBottom(ab)}
        />
        {selection && (
          <button
            type="button"
            className={'xterm-copy-fab' + (copyFlash ? ' is-flash' : '')}
            onClick={(e) => { e.stopPropagation(); void copySelection(); }}
            aria-label="Copy selection"
          >
            <span aria-hidden>📋</span>
            <span>{copyFlash ? '已复制' : '复制'}</span>
          </button>
        )}
        {!atBottom && (
          <button
            type="button"
            className="jump-to-bottom"
            onClick={(e) => {
              e.stopPropagation();
              termRef.current?.scrollToBottom();
              setAtBottom(true);
            }}
            aria-label="Jump to latest output"
          >
            ↓ 跳到最新
          </button>
        )}
      </div>

      <InterventionBar
        key={termReady ? 'ready' : 'pending'}
        terminal={termReady ? termRef.current : null}
        onResponse={(text) => void writeBytes(text)}
      />

      <InputBar
        disabled={disabled}
        sending={false}
        placeholder={
          disabled
            ? 'Session has exited'
            : busy
              ? 'Claude 处理中…'
              : '输入框 — 手机键盘直通'
        }
        onChange={(data) => void writeBytes(data)}
      />
    </div>
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}