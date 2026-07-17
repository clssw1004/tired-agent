import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ServerRef } from '@tired-pc/protocol';
import { createHttpSseTransport } from '@tired-pc/protocol';

interface Props {
  serverRef: ServerRef;
  sessionId: string;
  sessionStatus: 'starting' | 'running' | 'exited' | string;
  sessionLabel: string;
  onBack?: () => void;
}

type Message =
  | { kind: 'user'; id: number; text: string; ts: number }
  | { kind: 'output'; id: number; text: string; ts: number };

const DECODER = new TextDecoder('utf-8', { fatal: false });
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});
const TYPING_TIMEOUT_MS = 500;
const TICK_INTERVAL_MS = 250;

// ── ANSI / VT renderer ────────────────────────────────────────────────────
// Claude Code's PTY output is dominated by SGR (colours + bold/italic),
// cursor-movement CSI, OSC window-title, and lone \r overwrites. In a chat
// bubble we render SGR as styled <span>s and drop everything that doesn't
// have a chat meaning: OSC, DCS/PM/APC, mode toggles, cursor positioning,
// and lone \r (redraws). \r\n collapses to \n.

const ESC_BYTE = String.fromCharCode(0x1B);
const BEL_BYTE = String.fromCharCode(0x07);

// OSC ESC ] ... (BEL | ESC \) — drop.
const ANSI_OSC_RE = new RegExp(ESC_BYTE + '\\][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)', 'g');
// DCS / PM / APC ESC (P|X|^) ... (BEL | ESC \) — drop.
const ANSI_DCS_RE = new RegExp(ESC_BYTE + '[PX^][^' + BEL_BYTE + ']*(?:' + BEL_BYTE + '|' + ESC_BYTE + '\\\\)', 'g');
// One-char ESC sequences (FE/F/SI/SO etc.) — drop.
const ANSI_ESC_SHORT_RE = new RegExp(ESC_BYTE + '[\\x40-\\x5A\\\\\\-_]', 'g');
// CSI for parsing: walks the stream and only matches SGR (final === 'm').
const CSI_PARSE_RE = new RegExp(ESC_BYTE + '\\[([\\d;]*)([A-HJKSTfsulh]?)', 'g');

/** 16-colour palette used by SGR 30–37 / 40–47 / 90–97 / 100–107. */
const ANSI_16: readonly string[] = [
  '#1c1c1c', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

function ansi256(i: number): string {
  if (i < 16) return ANSI_16[i];
  if (i < 232) {
    const v = i - 16;
    const r = Math.floor(v / 36);
    const g = Math.floor((v % 36) / 6);
    const b = v % 6;
    const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return 'rgb(' + channel(r) + ',' + channel(g) + ',' + channel(b) + ')';
  }
  const v = 8 + (i - 232) * 10;
  return 'rgb(' + v + ',' + v + ',' + v + ')';
}

interface StyleState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  faint?: boolean;
  inverse?: boolean;
}

function applySgr(state: StyleState, params: number[]): StyleState {
  const next: StyleState = { ...state };
  let i = 0;
  while (i < params.length) {
    const p = params[i] || 0;
    switch (p) {
      case 0:
        next.fg = undefined; next.bg = undefined;
        next.bold = false; next.italic = false; next.underline = false;
        next.strike = false; next.faint = false; next.inverse = false;
        break;
      case 1: next.bold = true; break;
      case 2: next.faint = true; break;
      case 3: next.italic = true; break;
      case 4: next.underline = true; break;
      case 7: next.inverse = !next.inverse; break;
      case 9: next.strike = true; break;
      case 22: next.bold = false; break;
      case 23: next.italic = false; break;
      case 24: next.underline = false; break;
      case 27: next.inverse = false; break;
      case 29: next.strike = false; break;
      case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
        next.fg = ANSI_16[p - 30]; break;
      case 38:
        if (params[i + 1] === 5) { next.fg = ansi256(params[i + 2]); i += 2; }
        else if (params[i + 1] === 2) { next.fg = 'rgb(' + params[i + 2] + ',' + params[i + 3] + ',' + params[i + 4] + ')'; i += 4; }
        break;
      case 39: next.fg = undefined; break;
      case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
        next.bg = ANSI_16[p - 40]; break;
      case 48:
        if (params[i + 1] === 5) { next.bg = ansi256(params[i + 2]); i += 2; }
        else if (params[i + 1] === 2) { next.bg = 'rgb(' + params[i + 2] + ',' + params[i + 3] + ',' + params[i + 4] + ')'; i += 4; }
        break;
      case 49: next.bg = undefined; break;
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
        next.fg = ANSI_16[p - 90 + 8]; break;
      case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
        next.bg = ANSI_16[p - 100 + 8]; break;
      default: break;
    }
    i++;
  }
  return next;
}

function styleToCss(st: StyleState): CSSProperties {
  let fg = st.fg;
  let bg = st.bg;
  if (st.inverse && (fg || bg)) {
    const a = fg;
    fg = bg;
    bg = a;
  }
  const css: Record<string, unknown> = {};
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (st.bold) css.fontWeight = 600;
  if (st.italic) css.fontStyle = 'italic';
  const decor: string[] = [];
  if (st.underline) decor.push('underline');
  if (st.strike) decor.push('line-through');
  if (decor.length) css.textDecoration = decor.join(' ');
  if (st.faint) css.opacity = 0.65;
  return css as CSSProperties;
}

interface Segment { css: CSSProperties; text: string }

/**
 * Parse the PTY stream into React-renderable styled segments.
 *
 *   Drops: OSC / DCS / PM / APC, cursor-positioning CSI (H/A/B/C/D), erase
 *          CSI (J/K), mode toggles (CSI ? ... h/l), and lone \r.
 *   Keeps: SGR colours (16 / 256 / true colour), bold, italic, underline,
 *          strike-through, faint, inverse — rendered as a per-segment style.
 */
function renderAnsi(raw: string): Segment[] {
  let text = raw;
  text = text.replace(ANSI_OSC_RE, '');
  text = text.replace(ANSI_DCS_RE, '');
  text = text.replace(ANSI_ESC_SHORT_RE, '');

  const segments: Segment[] = [];
  let state: StyleState = {};
  let plainStart = 0;
  CSI_PARSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSI_PARSE_RE.exec(text)) !== null) {
    const final = m[2] || 'm';
    if (final === 'm') {
      // Flush the plain text run before this SGR.
      if (m.index > plainStart) {
        const segText = text.slice(plainStart, m.index);
        if (segText) segments.push({ css: styleToCss(state), text: segText });
      }
      const raw = m[1];
      const params = raw.length === 0 ? [0] : raw.split(';').map((s) => Number(s));
      state = applySgr(state, params);
      plainStart = CSI_PARSE_RE.lastIndex;
    } else {
      // Non-SGR CSI: cursor move / erase / mode toggle / etc.
      // Drop the entire CSI (including any params & intermediates).
      const seqLen = m[0].length;
      // Splice the matched sequence out of `text`, then continue from there.
      text = text.slice(0, m.index) + text.slice(m.index + seqLen);
      CSI_PARSE_RE.lastIndex = m.index;
      plainStart = m.index;
    }
  }
  if (plainStart < text.length) {
    const segText = text.slice(plainStart);
    if (segText) segments.push({ css: styleToCss(state), text: segText });
  }
  for (const s of segments) {
    s.text = s.text.replace(/\r(?!\n)/g, '').replace(/\r\n/g, '\n');
  }
  return segments.filter((s) => s.text.length > 0);
}

function formatTime(ts: number): string {
  const now = Date.now();
  const sameDay =
    new Date(ts).toDateString() === new Date(now).toDateString();
  return sameDay ? TIME_FORMATTER.format(ts) : TIME_FORMATTER.format(ts) + ' ·';
}

function relativeSince(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000) return 'just now';
  if (d < 60_000) return Math.floor(d / 1000) + 's ago';
  if (d < 3_600_000) return Math.floor(d / 60_000) + 'm ago';
  return TIME_FORMATTER.format(ts);
}

/**
 * Chat-style session panel (mobile-first).
 *
 *   - Header: back · status dot · label · host
 *   - Status strip: live / typing / connecting / offline (animated)
 *   - Scrollable bubble list with avatar pills, time labels, scroll-to-end FAB
 *   - Sticky composer: input + circular send, safe-area aware
 *
 * Output accumulates into the *open* assistant bubble until the next user
 * send. SGR colours / bold / italic / underline / inverse are rendered as
 * styled spans; non-rendering sequences (OSC, cursor positioning, mode
 * toggles) are stripped at render time.
 */
export function ChatView({ serverRef, sessionId, sessionStatus, sessionLabel, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [connected, setConnected] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [composerCopiedAt, setComposerCopiedAt] = useState(0);
  const [showJumpToEnd, setShowJumpToEnd] = useState(false);

  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckToBottomRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastChunkAtRef = useRef(0);
  const [, force] = useState(0); // forces re-render for the typing tick
  const disabled = sessionStatus === 'exited';

  useEffect(() => {
    if (disabled) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [disabled, sessionId]);

  // ── SSE subscription + initial replay ───────────────────────────────────
  useEffect(() => {
    const transport = createHttpSseTransport();
    let cancelled = false;
    let subscription: { close: () => void } | null = null;

    function appendOutput(chunk: Uint8Array) {
      if (chunk.byteLength === 0) return;
      lastChunkAtRef.current = Date.now();
      // Keep raw text (with SGR still in it); the render path turns it into
      // styled segments. No stripping here.
      const text = DECODER.decode(chunk);
      if (!text) return;
      const list = messagesRef.current;
      const last = list[list.length - 1];
      if (last && last.kind === 'output') {
        const updated: Message = { ...last, text: last.text + text };
        const next = list.slice(0, -1).concat(updated);
        messagesRef.current = next;
        setMessages(next);
      } else {
        const m: Message = { kind: 'output', id: ++idRef.current, text, ts: Date.now() };
        const next = list.concat(m);
        messagesRef.current = next;
        setMessages(next);
      }
    }

    (async () => {
      try {
        const replay = await transport.fetchOutput(serverRef, sessionId, 0);
        if (cancelled) return;
        let seeded = '';
        for (const chunk of replay.chunks) {
          seeded += DECODER.decode(base64ToBytes(chunk.data));
        }
        if (seeded) {
          const first: Message = { kind: 'output', id: ++idRef.current, text: seeded, ts: Date.now() };
          messagesRef.current = [first];
          setMessages([first]);
          lastChunkAtRef.current = Date.now();
        }
        setConnected(true);

        subscription = transport.subscribe(serverRef, sessionId, {
          onChunk: (c) => appendOutput(c.data),
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
    };
  }, [sessionId, serverRef.id]);

  // Tick: drives the "typing…" indicator and the scroll-to-end FAB visibility.
  useEffect(() => {
    const t = window.setInterval(() => {
      force((n) => (n + 1) & 0xffff);
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(t);
  }, []);

  // Auto-scroll only when the user is already near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stuckToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

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

  // ── Send a line ────────────────────────────────────────────────────────
  const submit = async () => {
    const input = inputRef.current;
    if (!input || sending || disabled) return;
    const text = input.value;
    if (!text) return;
    setSending(true);

    const nextId = (messagesRef.current.reduce((m, msg) => Math.max(m, msg.id), 0) || 0) + 1;
    const updated = messagesRef.current.concat(
      { kind: 'user',   id: nextId,     text, ts: Date.now() },
      { kind: 'output', id: nextId + 1, text: '', ts: Date.now() },
    );
    messagesRef.current = updated;
    setMessages(updated);
    input.value = '';
    input.focus();

    try {
      const transport = createHttpSseTransport();
      await transport.sendInput(serverRef, sessionId, new TextEncoder().encode(text + '\r'));
    } catch (err) {
      setTransportError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setComposerCopiedAt(Date.now());
      window.setTimeout(() => setComposerCopiedAt(0), 1500);
    } catch {
      /* clipboard permission denied — ignore */
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };

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
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">⏳</div>
            <div className="chat-empty-title">Waiting for the terminal…</div>
            <div className="chat-empty-sub">Type a command and press ↵</div>
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.kind === 'user';
          const avatar = mine ? '我' : 'PC';
          const showTime =
            i === 0 ||
            messages[i - 1].kind !== m.kind ||
            Math.abs(m.ts - messages[i - 1].ts) > 60_000;
          return (
            <div key={m.id} className={'chat-row chat-row-' + (mine ? 'user' : 'pc')}>
              {showTime && (
                <div className="chat-time-pill">
                  <span>{avatar}</span>
                  <span className="chat-time-pill-ts">{formatTime(m.ts)}</span>
                </div>
              )}
              <div className={'chat-bubble chat-bubble-' + (mine ? 'user' : 'pc')}>
                <span className="chat-bubble-avatar" aria-hidden>{avatar}</span>
                <pre
                  className="chat-bubble-body"
                  onDoubleClick={() => void copyText(stripForCopy(m.text))}
                  title="Double-tap to copy"
                >
                  {mine
                    ? <span>{m.text || ' '}</span>
                    : <AnsiBody text={m.text || ' '} />}
                </pre>
              </div>
            </div>
          );
        })}
        {composerCopiedAt > 0 && (
          <div className="chat-toast">Copied</div>
        )}
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

/**
 * Renders an ANSI-coloured PTY output body as styled <span>s.
 * memo()'d on the raw text so re-renders during the typing tick don't
 * re-parse unchanged bytes.
 */
const AnsiBody = (() => {
  const cache = new Map<string, Segment[]>();
  function parse(text: string): Segment[] {
    const hit = cache.get(text);
    if (hit) return hit;
    const out = renderAnsi(text);
    cache.set(text, out);
    if (cache.size > 64) {
      // simple LRU-ish: drop the oldest insertion.
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return out;
  }
  function Component({ text }: { text: string }) {
    const segs = parse(text);
    return (
      <>
        {segs.map((s, i) => (
          <span key={i} style={s.css}>{s.text}</span>
        ))}
      </>
    );
  }
  return Component;
})();

/** Plain-text version for the clipboard (no ANSI escapes in the user's copied text). */
function stripForCopy(text: string): string {
  return renderAnsi(text).map((s) => s.text).join('');
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
