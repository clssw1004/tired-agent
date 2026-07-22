/**
 * PtySessionView — top-level shell for a single PTY session's UI.
 *
 * This is the **process** (PTY) mode component. Persistent/chat mode uses
 * ClaudeChatView instead.
 *
 * Architecture (2026-07-22 split):
 *   PtySessionView.tsx          — host: state, refs, effects, callbacks.
 *   pty/PtySessionViewDesktop   — desktop header (with ⌨ 控制条 toggle),
 *                                 PtyInputBar (system keyboard) +
 *                                 optional SpecialKeysBar.
 *   pty/PtySessionViewMobile    — mobile header (no toggle), PtyMobileKeyboard.
 *   pty/useDeviceType           — viewport classifier with resize listener.
 *   pty/shared                  — shared types + constants + utilities.
 *
 * Why split:
 *   Mobile and desktop layouts diverge fast (mobile keyboard, no toggle,
 *   compact header, etc.). Keeping them in one file led to scattered
 *   `isDesktop` checks and growing CSS media queries. Each variant now
 *   owns its own JSX so future mobile-only polish does not leak into the
 *   desktop path.
 *
 * Keyboard model: xterm.js owns the full TUI surface. PtyInputBar exists
 * ONLY to summon the desktop system keyboard (xterm's canvas does not).
 * On mobile, PtyMobileKeyboard is a custom on-screen QWERTY that ships
 * bytes verbatim to the PTY — same downstream path as the desktop one.
 *
 * History replay: on mount, fetchOutput(0, …, tail) replays the last
 * 64 KB into xterm so the user lands on a fully-rendered screen before
 * live SSE chunks arrive. The full history is one banner-click away.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServerRef, Session, SessionStatus, SessionMode } from '@tired-agent/protocol';
import { createHttpSseTransport } from '@tired-agent/protocol';
import type { StructuredContent } from '@tired-agent/protocol';
import { defaultRegistry, initRenderers, GenericPtyRenderer } from '../renderer';
import type { AgentRenderer } from '../renderer';
import type { TerminalHandle } from './render-views';
import {
  TYPING_TIMEOUT_MS,
  TICK_INTERVAL_MS,
  RESIZE_DEBOUNCE_MS,
  OUTPUT_FLUSH_TIMEOUT_MS,
  PTY_OUTPUT_TAIL_BYTES,
  TAIL_BANNER_DISMISS_MS,
  INITIAL_MODIFIER_STATE,
  base64ToBytes,
  type PtySessionViewSharedProps,
  type OutputTailState,
} from './pty/shared';
import { useDeviceType } from './pty/useDeviceType';
import { PtySessionViewDesktop } from './pty/PtySessionViewDesktop';
import { PtySessionViewMobile } from './pty/PtySessionViewMobile';

interface Props {
  serverRef: ServerRef;
  /** Id of the Agent this session belongs to; used to route through the Manager proxy. */
  agentId: string;
  sessionId: string;
  sessionStatus: SessionStatus | string;
  sessionLabel: string;
  sessionCmd: string;
  sessionArgs: string[];
  /** Session lifecycle mode. 'process' → follows process; 'persistent' → user-managed. */
  sessionMode?: SessionMode;
  onBack?: () => void;
}

const DECODER = new TextDecoder('utf-8', { fatal: false });
const ENCODER = new TextEncoder();

/** TextDecoder.decode wrapper — newer TS lib types prefer BufferSource overloads. */
function decodeText(input: Uint8Array): string {
  return DECODER.decode(input);
}

initRenderers();

export function PtySessionView({
  serverRef,
  agentId,
  sessionId,
  sessionStatus,
  sessionLabel,
  sessionCmd,
  sessionArgs,
  sessionMode,
  onBack,
}: Props) {
  const device = useDeviceType();
  const [connected, setConnected] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [termReady, setTermReady] = useState(false);
  const [selection, setSelection] = useState('');
  const [copyFlash, setCopyFlash] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Truncation state for the fast-load tail. null = unknown (still loading
   *  or full read). When `truncated` is true we render a banner offering to
   *  pull the rest of the history on demand. */
  const [outputTail, setOutputTail] = useState<OutputTailState | null>(null);
  /** When the user clicks ✕ on the truncation banner, dismiss it so it
   *  doesn't take up space. The session stays in tail mode; the banner
   *  won't show again unless the session re-mounts. */
  const [tailBannerDismissed, setTailBannerDismissed] = useState(false);

  // Structured mode state
  const [mode, setMode] = useState<SessionMode>(sessionMode ?? 'process');
  const [structuredContents, setStructuredContents] = useState<StructuredContent[]>([]);
  const [streaming, setStreaming] = useState(false);

  // ── Modifier key state (PTY mode). Lifted to this host so both
  //    SpecialKeysBar (button bar) and PtyInputBar (system keyboard via
  //    <input>) see the same toggle state.
  const [modifiers, setModifiers] = useState(INITIAL_MODIFIER_STATE);

  /** Set the modifier explicitly to {@link mode}. Used by SpecialKeysBar
   *  after the user taps a modifier button (short or long press). */
  const setModifier = useCallback((key: 'ctrl' | 'shift', mode: 'off' | 'oneShot' | 'sticky') => {
    setModifiers((prev) => (prev[key] === mode ? prev : { ...prev, [key]: mode }));
  }, []);

  /** Drop a modifier from 'oneShot' back to 'off'. Called by PtyInputBar
   *  after the modifier has been applied to a real keystroke. No-op for
   *  'sticky' (must be cleared explicitly by tapping the button again). */
  const consumeModifier = useCallback((key: 'ctrl' | 'shift') => {
    setModifiers((prev) => {
      if (prev[key] !== 'oneShot') return prev;
      return { ...prev, [key]: 'off' };
    });
  }, []);

  // Sync mode from prop when session loads asynchronously (TerminalPage
  // fetches the Session object after mount, so sessionMode starts undefined).
  useEffect(() => {
    if (sessionMode) setMode(sessionMode);
  }, [sessionMode]);

  const termRef = useRef<TerminalHandle>(null);
  const rendererRef = useRef<AgentRenderer>(new GenericPtyRenderer());
  const lastChunkAtRef = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [, force] = useState(0);
  const sessionRef = useRef({ cmd: '', args: [] as string[] });

  // ── PTY resize tracking. TerminalView reports new cols/rows via the
  //    onResize callback; we debounce and forward to the backend.
  const lastSentResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<number | null>(null);

  // ── RAF output batching. The SSE onChunk handler appends incoming PTY
  //    bytes to `pendingBytesRef`; a single rAF callback flushes them into
  //    xterm so a torrent of small chunks becomes one render frame.
  //    A parallel timeout (`OUTPUT_FLUSH_TIMEOUT_MS`) forces a flush if RAF
  //    is starved (background tab, slow frame) so we never visibly lag.
  const pendingBytesRef = useRef('');
  const flushFrameRef = useRef<number | null>(null);
  const flushTimeoutRef = useRef<number | null>(null);

  const disabled = sessionStatus === 'exited';

  // Heartbeat tick — drives the typing indicator + status pill updates.
  useEffect(() => {
    const t = window.setInterval(() => {
      force((n) => (n + 1) & 0xffff);
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  // Cancel pending resize + flush remaining output on unmount so we don't
  // leave a setTimeout firing into a stale session, and so the very last
  // bytes from the SSE close aren't lost when the component goes away.
  useEffect(() => {
    return () => {
      if (resizeTimerRef.current !== null) {
        window.clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
        flushFrameRef.current = null;
      }
      // Best-effort: flush any bytes still pending. We can't await — this
      // is a synchronous unmount path. Drop on the floor if xterm is gone.
      const pending = pendingBytesRef.current;
      if (pending) {
        pendingBytesRef.current = '';
        termRef.current?.write(pending);
      }
      if (flushTimeoutRef.current !== null) {
        window.clearTimeout(flushTimeoutRef.current);
        flushTimeoutRef.current = null;
      }
    };
  }, []);

  // Auto-dismiss the truncation banner after TAIL_BANNER_DISMISS_MS so it
  // doesn't permanently occupy screen real estate. The user can always tap
  // ✕ to dismiss sooner, or tap "加载完整历史" to load the full log. Timer
  // resets on re-mount.
  useEffect(() => {
    if (!outputTail?.truncated || tailBannerDismissed) return;
    const t = window.setTimeout(() => setTailBannerDismissed(true), TAIL_BANNER_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [outputTail?.truncated, tailBannerDismissed]);

  // ── PTY writer: shared by xterm.onUserInput, PtyInputBar.onChange, and
  //    PtyInterventionBar.onResponse. Everything funnels through one path so
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

  // ── PTY resize handler. Fires from TerminalView's onResize whenever the
  //    xterm grid settles to new cols/rows. Debounced so a continuous window
  //    drag produces one POST every RESIZE_DEBOUNCE_MS, not one per RAF tick.
  //    Only meaningful in PTY (process) mode — structured sessions have no
  //    backend PTY to resize.
  const handleTermResize = useCallback((cols: number, rows: number) => {
    if (modeRef.current !== 'process') return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    const last = lastSentResizeRef.current;
    if (last && last.cols === cols && last.rows === rows) return;
    if (resizeTimerRef.current !== null) {
      window.clearTimeout(resizeTimerRef.current);
    }
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      // Re-check after debounce — session might have exited in the meantime.
      if (modeRef.current !== 'process') return;
      const transport = createHttpSseTransport();
      transport
        .resizeSession(serverRef, sessionId, cols, rows, agentId)
        .then(() => {
          lastSentResizeRef.current = { cols, rows };
        })
        .catch((err) => setTransportError((err as Error).message));
    }, RESIZE_DEBOUNCE_MS);
  }, [serverRef, sessionId, agentId]);

  // ── Output batching: append + schedule. RAF coalesces a burst of small
  //    SSE chunks into a single xterm write per frame; the safety timeout
  //    forces a flush if RAF is starved so we never silently lose output.
  //    flushPendingBytes is declared first because scheduleFlush captures it.
  const flushPendingBytes = useCallback(() => {
    if (flushTimeoutRef.current !== null) {
      window.clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
    const pending = pendingBytesRef.current;
    if (!pending) return;
    pendingBytesRef.current = '';
    const wasAtBottom = termRef.current?.isAtBottom() ?? true;
    termRef.current?.write(pending);
    if (wasAtBottom) termRef.current?.scrollToBottom();
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushFrameRef.current === null) {
      flushFrameRef.current = window.requestAnimationFrame(() => {
        flushFrameRef.current = null;
        flushPendingBytes();
      });
    }
    if (flushTimeoutRef.current === null) {
      flushTimeoutRef.current = window.setTimeout(() => {
        flushTimeoutRef.current = null;
        if (flushFrameRef.current !== null) {
          window.cancelAnimationFrame(flushFrameRef.current);
          flushFrameRef.current = null;
        }
        flushPendingBytes();
      }, OUTPUT_FLUSH_TIMEOUT_MS);
    }
  }, [flushPendingBytes]);

  // ── Pull the complete history on demand. Called from the truncation
  //    banner when the user realizes the 64KB tail isn't enough context.
  //    Wipes xterm first so the tail slice doesn't get re-rendered on top
  //    of the full replay.
  const loadFullHistory = useCallback(async () => {
    const transport = createHttpSseTransport();
    try {
      termRef.current?.clear();
      const full = await transport.fetchOutput(serverRef, sessionId, 0, undefined, agentId);
      let seeded = '';
      for (const chunk of full.chunks) {
        seeded += decodeText(base64ToBytes(chunk.data));
      }
      if (seeded) termRef.current?.write(seeded);
      termRef.current?.scrollToBottom();
      const totalBytes = full.totalBytes ?? full.upTo;
      setOutputTail({ truncated: false, totalBytes, loadedBytes: 0 });
    } catch (err) {
      setTransportError((err as Error).message);
    }
  }, [serverRef, sessionId, agentId]);

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

  // Select the renderer based on session command (independent of connection).
  useEffect(() => {
    if (!sessionCmd) return;
    const selected = defaultRegistry().select(sessionCmd, sessionArgs, '');
    selected.reset();
    rendererRef.current = selected;
    sessionRef.current = { cmd: sessionCmd, args: sessionArgs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCmd, sessionArgs.join('|')]);

  // Connect, replay history, subscribe to live chunks.
  useEffect(() => {
    const transport = createHttpSseTransport();
    let cancelled = false;
    let subscription: { close: () => void } | null = null;

    (async () => {
      try {
        // Fast-load: ask the server for only the last 64KB of the log via a
        // backwards seek. The full history is still available on demand via
        // {@link loadFullHistory}. Persistent (chat) sessions skip this —
        // they feed the bytes through a structured NDJSON parser that needs
        // complete messages, so a tail would corrupt the JSON boundary.
        const isPersistent = modeRef.current === 'persistent';
        const replay = await transport.fetchOutput(
          serverRef,
          sessionId,
          0,
          undefined,
          agentId,
          isPersistent ? undefined : PTY_OUTPUT_TAIL_BYTES,
        );
        if (cancelled) return;

        // Track truncation so the banner can offer "load full history".
        const loadedBytes = replay.chunks.reduce(
          (s, c) => s + base64ToBytes(c.data).byteLength,
          0,
        );
        const totalBytes = replay.totalBytes ?? replay.upTo;
        const truncated = replay.truncated === true && !isPersistent;
        setOutputTail({ truncated, totalBytes, loadedBytes });

        // Use the renderer from the sessionCmd effect, or fallback.
        const currentMode = modeRef.current;

        // Replay logic differs by mode.
        if (currentMode === 'persistent') {
          let accumulated = '';
          for (const chunk of replay.chunks) {
            accumulated += decodeText(base64ToBytes(chunk.data));
          }
          if (accumulated) {
            const output = rendererRef.current.processChunk(accumulated, {
              session: sessionRef.current,
              streaming: false,
              segmentContent: [],
            });
            if (output && output.contents.length > 0) {
              setStructuredContents([...output.contents]);
            }
            lastChunkAtRef.current = Date.now();
          }
        } else {
          // PTY mode: write replay bytes to xterm.js.
          let seeded = '';
          for (const chunk of replay.chunks) {
            seeded += decodeText(base64ToBytes(chunk.data));
          }
          if (seeded) {
            termRef.current?.write(seeded);
            lastChunkAtRef.current = Date.now();
          }
        }

        setConnected(true);

        subscription = transport.subscribe(serverRef, sessionId, {
          onChunk: (c) => {
            const text = decodeText(c.data);
            if (!text) return;
            lastChunkAtRef.current = Date.now();

            if (modeRef.current === 'persistent') {
              setStreaming(true);
              const output = rendererRef.current.processChunk(text, {
                session: sessionRef.current,
                streaming: true,
                segmentContent: [],
              });
              if (output && output.contents.length > 0) {
                setStructuredContents([...output.contents]);
              }
            } else {
              // PTY mode: buffer the bytes and let scheduleFlush coalesce a
              // burst of small chunks into one xterm write per RAF frame.
              // We still call the renderer eagerly so any future Claude
              // detection logic sees the raw text stream (no behavioral
              // change for GenericPtyRenderer's no-op processChunk).
              pendingBytesRef.current += text;
              scheduleFlush();
              rendererRef.current.processChunk(text, {
                session: sessionRef.current,
                streaming: true,
                segmentContent: [],
              });
            }
          },
          onState: (session: Session) => {
            if (session.mode) setMode(session.mode);
            if (session.status === 'running') setStreaming(true);
            if (session.status === 'exited') setStreaming(false);
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

  // Busy detection — are we waiting for Claude to finish generating?
  // PTY mode: detect spinner frames / "esc to interrupt" in xterm buffer.
  // Structured mode: track streaming state from SSE events.
  useEffect(() => {
    if (mode === 'persistent') {
      // In structured mode, streaming state is set by the SSE onChunk/onState handlers.
      setBusy(streaming);
      return;
    }
    // PTY mode: scan xterm buffer for spinner / interrupt hints.
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
  }, [termReady, mode, streaming]);

  // ── Status derivation ──────────────────────────────────────────────────
  const typing = lastChunkAtRef.current > 0
    && Date.now() - lastChunkAtRef.current < TYPING_TIMEOUT_MS;

  const sharedProps: PtySessionViewSharedProps = {
    serverRef, agentId, sessionId,
    sessionLabel, sessionCmd, sessionArgs, sessionStatus, sessionMode,
    onBack,
    connected, transportError, termReady, typing, atBottom, busy, outputTail,
    tailBannerDismissed, mode, structuredContents, streaming, modifiers,
    selection, copyFlash, termRef,
    writeBytes, handleTermResize, copySelection, loadFullHistory,
    dismissTailBanner: () => setTailBannerDismissed(true),
    setModifier, consumeModifier,
    setAtBottom,
  };

  return (
    <div className={'chat-panel' + (busy ? ' is-busy' : '')}>
      {device === 'desktop'
        ? <PtySessionViewDesktop {...sharedProps} />
        : <PtySessionViewMobile {...sharedProps} />}
    </div>
  );
}
