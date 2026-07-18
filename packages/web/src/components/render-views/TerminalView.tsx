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
  /** Get the currently selected text in the terminal (empty string if none). */
  getSelection: () => string;
  /** Clear the current selection. */
  clearSelection: () => void;
  /** True if the viewport is currently pinned to the bottom of the scrollback. */
  isAtBottom: () => boolean;
  /** Scroll the viewport to the bottom of the scrollback. */
  scrollToBottom: () => void;
}

interface Props {
  className?: string;
  /** Fires once when the underlying xterm instance is ready. */
  onReady?: () => void;
  /** Fires for every keystroke translated by xterm. The host forwards these
   *  bytes to the PTY. Fires whether or not `disableStdin` is true. */
  onUserInput?: (data: string) => void;
  /** Fires whenever the selection inside xterm changes. Receives the selected
   *  text (empty if cleared). The host uses this to show a floating copy button
   *  on mobile, where long-press selection has no native copy affordance. */
  onSelectionChange?: (text: string) => void;
  /** Fires when the user scrolls inside xterm. Receives `true` when the
   *  viewport is pinned to the bottom, `false` when they've scrolled up.
   *  The host uses this to show a "jump to latest" pill when streaming
   *  output piles up off-screen. */
  onScroll?: (atBottom: boolean) => void;
}

export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { className, onReady, onUserInput, onSelectionChange, onScroll },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeCallbacksRef = useRef<Set<() => void>>(new Set());
  const userInputCbRef = useRef<((data: string) => void) | undefined>(onUserInput);
  const selectionCbRef = useRef<((text: string) => void) | undefined>(onSelectionChange);
  const scrollCbRef = useRef<((atBottom: boolean) => void) | undefined>(onScroll);

  // Keep callback refs fresh so terminal.onData / onSelectionChange / onScroll
  // always invoke the latest host handler without re-binding the xterm sub.
  userInputCbRef.current = onUserInput;
  selectionCbRef.current = onSelectionChange;
  scrollCbRef.current = onScroll;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Responsive fontSize — narrower viewports use smaller font so more
    // columns fit. Mirrors styles.css breakpoints at 360 / 480 / 768 / 1200.
    const computeFontSize = (w: number): number => {
      if (w < 400) return 11;
      if (w < 768) return 12;
      if (w < 1200) return 13;
      return 14;
    };
    const computeLineHeight = (fs: number): number =>
      // Slightly looser at small sizes so descenders/glyphs don't crowd.
      fs <= 11 ? 1.25 : fs <= 13 ? 1.18 : 1.15;

    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: computeFontSize(container.clientWidth),
      lineHeight: computeLineHeight(computeFontSize(container.clientWidth)),
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
      try {
        // Re-evaluate fontSize when the container crosses a breakpoint
        // (e.g. phone rotation, window resize past 768px). Without this,
        // a 360px portrait phone keeps its 13px font even after the user
        // opens a tablet landscape view.
        const w = container.clientWidth;
        const fs = computeFontSize(w);
        if (fs !== term.options.fontSize) {
          term.options.fontSize = fs;
          term.options.lineHeight = computeLineHeight(fs);
        }
        fit.fit();
      } catch { /* container may be 0×0 briefly */ }
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

    // Selection change — host renders a floating copy FAB on mobile.
    const selectionSub = term.onSelectionChange(() => {
      const cb = selectionCbRef.current;
      if (!cb) return;
      try { cb(term.getSelection() ?? ''); } catch { /* ignore */ }
    });

    // Scroll — host decides whether to show a "jump to latest" pill when
    // streaming output piles up off-screen.
    const computeAtBottom = (): boolean => {
      const buf = term.buffer.active;
      // viewportY is the row at the top of the visible window; if the
      // bottom of the viewport has reached the end of the buffer, we are
      // pinned. Allow a 1-row slop for sub-pixel rounding.
      return buf.viewportY + term.rows >= buf.length - 1;
    };
    const scrollSub = term.onScroll(() => {
      const cb = scrollCbRef.current;
      if (!cb) return;
      try { cb(computeAtBottom()); } catch { /* ignore */ }
    });

    termRef.current = term;
    fitRef.current = fit;
    onReady?.();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      writeSub.dispose();
      inputSub.dispose();
      selectionSub.dispose();
      scrollSub.dispose();
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
    getSelection: () => termRef.current?.getSelection() ?? '',
    clearSelection: () => { termRef.current?.clearSelection(); },
    isAtBottom: () => {
      const term = termRef.current;
      if (!term) return true;
      const buf = term.buffer.active;
      return buf.viewportY + term.rows >= buf.length - 1;
    },
    scrollToBottom: () => { termRef.current?.scrollToBottom(); },
  }), []);

  return <div ref={containerRef} className={'terminal-view ' + (className ?? '')} />;
});