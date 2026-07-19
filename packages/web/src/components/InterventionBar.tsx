/**
 * InterventionSheet — surfaces "do you want to do X?" prompts from the
 * terminal as a mobile-native bottom action sheet.
 *
 * Subscribes to the TerminalView's onWrite hook and re-scans the last few
 * rows each time xterm finishes writing. When it finds a confirmation-style
 * prompt (`[y/N]`, `(Y/n)`, or any line ending in `?` after a non-spinner
 * line), it slides up from the bottom with [是] / [否] buttons. Tapping a
 * button sends the matching response to the PTY via the supplied callback.
 *
 * For free-text `?` prompts (Claude's "what should X be?" style), the user
 * can type a custom response in the inline input.
 *
 * Deliberately conservative — false positives (e.g. a `?` in a docstring)
 * are preferable to silently swallowing prompts that need attention.
 */

import { useEffect, useRef, useState } from 'react';
import type { TerminalHandle } from './render-views';

interface Props {
  terminal: TerminalHandle | null;
  onResponse: (text: string) => void | Promise<void>;
}

interface PendingPrompt {
  text: string;
  positive: string;  // default 'y'
  negative: string;  // default 'n'
  /** True for free-text `?` prompts — show custom input field. */
  freeText: boolean;
}

const CONFIRM_RE = /\[y\/[nN]\]|\[Y\/n\]|\(y\/n\)|\(Y\/N\)|\[yes\/no\]/;
const SPINNER_CHARS = /[⠂⠐⠈⠘⠸⠰⠠⠄✳✻✽✶✢·*]/;

function detectPrompt(lines: string[]): PendingPrompt | null {
  // Walk from the bottom up, but stop once we hit a non-empty line that
  // isn't a prompt. The Claude TUI redraws its status bar (with the model
  // name, context %, mode chip) in the last 1–2 rows, so we look at the
  // bottom four rows but tolerate status-bar noise above the actual prompt.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line) continue;
    if (CONFIRM_RE.test(line)) {
      return {
        text: line,
        positive: 'y',
        negative: 'n',
        freeText: false,
      };
    }
  }
  // Free-text question mark on the last non-empty line — but only if it
  // isn't a spinner glyph or a CLI command echo (those are not questions).
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line) continue;
    if (SPINNER_CHARS.test(line[0] ?? '')) continue;
    if (line.startsWith('$') || line.startsWith('❯')) continue;
    if (line.endsWith('?')) {
      return { text: line, positive: 'y', negative: 'n', freeText: true };
    }
    // Hit a non-question line without finding a prompt first → no prompt.
    return null;
  }
  return null;
}

export function InterventionBar({ terminal, onResponse }: Props) {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [customReply, setCustomReply] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!terminal) return;
    const check = () => {
      const lines = terminal.getLastLines(8);
      setPrompt((prev) => {
        const next = detectPrompt(lines);
        if (!next && prev) setCustomReply('');
        return next;
      });
    };
    check();
    const unsub = terminal.onWrite(check);
    return unsub;
  }, [terminal]);

  // Focus the custom-reply input when a free-text prompt appears.
  useEffect(() => {
    if (prompt?.freeText) {
      // Small delay so the slide-up animation finishes.
      const t = window.setTimeout(() => inputRef.current?.focus(), 120);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [prompt?.freeText]);

  if (!prompt) return null;

  const respond = async (text: string) => {
    setPrompt(null);
    setCustomReply('');
    try { navigator.vibrate?.(12); } catch { /* iOS no-op */ }
    await onResponse(text + '\n');
  };

  const dismiss = () => {
    setPrompt(null);
    setCustomReply('');
  };

  return (
    <>
      <div className="intervention-backdrop" onClick={dismiss} aria-hidden />
      <div className="intervention-sheet" role="alertdialog" aria-live="polite">
        <div className="intervention-handle" aria-hidden />
        <div className="intervention-prompt">{prompt.text}</div>
        {prompt.freeText ? (
          <form
            className="intervention-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (customReply.trim()) void respond(customReply.trim());
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="intervention-input"
              value={customReply}
              onChange={(e) => setCustomReply(e.target.value)}
              placeholder="输入回复…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="intervention-btn intervention-yes"
              disabled={!customReply.trim()}
            >
              发送
            </button>
            <button
              type="button"
              className="intervention-btn intervention-no"
              onClick={dismiss}
            >
              取消
            </button>
          </form>
        ) : (
          <div className="intervention-actions">
            <button
              type="button"
              className="intervention-btn intervention-yes"
              onClick={() => void respond(prompt.positive)}
            >
              是
            </button>
            <button
              type="button"
              className="intervention-btn intervention-no"
              onClick={() => void respond(prompt.negative)}
            >
              否
            </button>
          </div>
        )}
      </div>
    </>
  );
}