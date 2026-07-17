import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ServerRef, Session, OutputChunk } from '@tired-pc/protocol';
import { createHttpSseTransport } from '@tired-pc/protocol';

interface Props {
  server: ServerRef;
  sessionId: string;
  initialOffset?: number;
  onOffsetUpdate?: (offset: number) => void;
  onStateChange?: (session: Session) => void;
  onTransportError?: (err: Error) => void;
}

export function TerminalView({
  server,
  sessionId,
  initialOffset = 0,
  onOffsetUpdate,
  onStateChange,
  onTransportError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const offsetRef = useRef(initialOffset);

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      theme: {
        background: '#0d0d1a',
        foreground: '#e0e0e0',
        cursor: '#a0a0a0',
        black: '#1a1a2e',
        red: '#ff6b6b',
        green: '#51cf66',
        yellow: '#fcc419',
        blue: '#339af0',
        magenta: '#cc5de8',
        cyan: '#22b8cf',
        white: '#e0e0e0',
        brightBlack: '#444',
        brightRed: '#ff8787',
        brightGreen: '#69db7c',
        brightYellow: '#ffe066',
        brightBlue: '#74c0fc',
        brightMagenta: '#da77f2',
        brightCyan: '#66d9e8',
        brightWhite: '#fff',
      },
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Subscribe to SSE + initial replay
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const transport = createHttpSseTransport();
    let subscription: { close: () => void } | null = null;
    let cancelled = false;

    (async () => {
      try {
        const replay = await transport.fetchOutput(
          { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
          sessionId,
          offsetRef.current,
        );
        if (cancelled) return;
        for (const chunk of replay.chunks) {
          const bytes = base64ToBytes(chunk.data);
          term.write(bytes);
          offsetRef.current = chunk.offset + bytes.byteLength;
          onOffsetUpdate?.(offsetRef.current);
        }

        subscription = transport.subscribe(
          { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
          sessionId,
          {
            onChunk: (chunk: OutputChunk) => {
              term.write(chunk.data);
              offsetRef.current = chunk.offset + chunk.data.byteLength;
              onOffsetUpdate?.(offsetRef.current);
            },
            onState: (s) => onStateChange?.(s),
            onError: (err) => onTransportError?.(err),
          },
        );
      } catch (err) {
        if (!cancelled) onTransportError?.(err as Error);
      }
    })();

    return () => {
      cancelled = true;
      subscription?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, server.id]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }} />;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
