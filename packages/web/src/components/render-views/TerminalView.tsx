/**
 * TerminalView — xterm.js-backed terminal display.
 *
 * xterm.js handles every CSI sequence Claude emits (cursor moves, spinner
 * redraws, SGR colors, OSC, DEC private modes) and renders them correctly
 * inside the grid. We never parse ANSI ourselves.
 *
 * Keyboard model:
 *   - `disableStdin: false` — the xterm canvas accepts focus and translates
 *     browser KeyboardEvents into terminal keystrokes. Even with the canvas
 *     focused, `disableStdin` is NOT true: we want `onData` to fire for every
 *     key the user types. The host is responsible for forwarding those bytes
 *     to the PTY via `onUserInput`.
 *   - On mobile, the canvas does not bring up the soft keyboard, so the host
 *     keeps a separate {@link InputBar} that mirrors each keystroke directly
 *     into {@link TerminalHandle.sendInput}. Both paths converge on the same
 *     PTY write so behaviour is consistent.
 *   - To avoid double-rendering of typed characters (xterm echoes locally via
 *     `disableStdin: false` AND the PTY echoes back through SSE), we set
 *     `disableStdin: true` and let ONLY the PTY-driven SSE echo be visible.
 *     `onData` still fires while `disableStdin` is true (it gates local echo,
 *     not event emission).
 *
 * History replay: the caller feeds all replay chunks into xterm before
 * subscribing to the live stream. xterm accumulates them in its scrollback
 * buffer, so the user can scroll back through past output.
 */

import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalHandle {
  /** Write a chunk of PTY-decoded text to the terminal. */
  write: (text: string) => void;
  /** Read the last N rows of the terminal as plain text (for prompt detection). */
  getLastLines: (n: number) => string[];
  /** Notify the host that the terminal wrote new bytes (for intervention detection). */
  onWrite: (cb: () => void) => () => void;
  /** Forward raw PTY input bytes to the underlying program. */
  sendInput: (text: string) => void;
  /** Move focus to the xterm canvas so the host's keyboard routes here. */
  focus: () => void;
}

interface Props {
  className?: string;
  /** Fires once when the underlying xterm instance is ready. */
  onReady?: () => void;
  /** Fires for every keystroke translated by xterm. The host forwards these
   *  bytes to the PTY. Fires whether or not `disableStdin` is true. */
  onUserInput?: (data: string) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { className, onReady, onUserInput },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeCallbacksRef = useRef<Set<() => void>>(new Set());
  const userInputCbRef = useRef<((data: string) => void) | undefined>(onUserInput);

  // Keep callback ref fresh so terminal.onData always invokes the latest one
  // without needing to detach/re-attach the subscription.
  userInputCbRef.current = onUserInput;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 13,
      fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      theme: {
        background: 'transparent',
        foreground: '#e0e0e0',
        cursor: 'transparent',
      },
      cursorBlink: false,
      // We deliberately disable xterm's local echo so the screen only shows
      // what the PTY itself echoes back through SSE. onData still fires —
      // it gates the on-screen echo, not the event stream.
      disableStdin: true,
      allowProposedApi: true,
      scrollback: 5000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Make the canvas focusable so a click places keyboard focus here.
    container.setAttribute('tabindex', '0');

    const tryFit = () => {
      try { fit.fit(); } catch { /* container may be 0×0 briefly */ }
    };

    const raf = requestAnimationFrame(() => {
      tryFit();
      requestAnimationFrame(tryFit);
    });

    const ro = new ResizeObserver(() => tryFit());
    ro.observe(container);

    // Notify subscribers after each parsed write (for intervention detection).
    const writeSub = term.onWriteParsed(() => {
      for (const cb of writeCallbacksRef.current) {
        try { cb(); } catch { /* ignore */ }
      }
    });

    // Forward keystrokes (translated by xterm into terminal bytes) to the host.
    const inputSub = term.onData((data) => {
      const cb = userInputCbRef.current;
      if (cb) {
        try { cb(data); } catch { /* ignore */ }
      }
    });

    termRef.current = term;
    fitRef.current = fit;
    onReady?.();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      writeSub.dispose();
      inputSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useImperativeHandle(ref, () => ({
    write: (text: string) => {
      termRef.current?.write(text);
    },
    getLastLines: (n: number) => {
      const term = termRef.current;
      if (!term) return [];
      const buf = term.buffer.active;
      const lines: string[] = [];
      const start = Math.max(0, buf.length - n);
      for (let y = start; y < buf.length; y++) {
        const line = buf.getLine(y);
        if (line) lines.push(line.translateToString(true));
      }
      return lines;
    },
    onWrite: (cb: () => void) => {
      writeCallbacksRef.current.add(cb);
      return () => { writeCallbacksRef.current.delete(cb); };
    },
    sendInput: (text: string) => {
      termRef.current?.write(text);
    },
    focus: () => {
      // xterm's underlying textarea is what receives keystrokes; focus it
      // directly so the host keyboard routes to the terminal.
      const term = termRef.current;
      if (!term) return;
      const textarea = (term as unknown as { _core?: { textarea?: HTMLTextAreaElement } })._core?.textarea;
      if (textarea) textarea.focus();
    },
  }), []);

  return <div ref={containerRef} className={'terminal-view ' + (className ?? '')} />;
});