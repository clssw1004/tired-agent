/**
 * InterventionBar — surfaces "do you want to do X?" prompts from the terminal.
 *
 * Subscribes to the TerminalView's onWrite hook and re-scans the last few
 * rows each time xterm finishes writing. When it finds a confirmation-style
 * prompt (`[y/N]`, `(Y/n)`, or any line ending in `?` after a non-spinner
 * line), it shows [确认] [拒绝] buttons. Tapping a button sends the matching
 * response to the PTY via the supplied callback.
 *
 * Deliberately conservative — false positives (e.g. a `?` in a docstring)
 * are preferable to silently swallowing prompts that need attention.
 */

import { useEffect, useState } from 'react';
import type { TerminalHandle } from './render-views';

interface Props {
  terminal: TerminalHandle | null;
  onResponse: (text: string) => void | Promise<void>;
}

interface PendingPrompt {
  text: string;
  positive: string;  // default 'y'
  negative: string;  // default 'n'
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
        positive: /\[Y\/n\]|\(Y\/N\)/.test(line) ? 'y' : 'y',
        negative: 'n',
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
      return { text: line, positive: 'y', negative: 'n' };
    }
    // Hit a non-question line without finding a prompt first → no prompt.
    return null;
  }
  return null;
}

export function InterventionBar({ terminal, onResponse }: Props) {
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);

  useEffect(() => {
    if (!terminal) return;
    const check = () => {
      const lines = terminal.getLastLines(8);
      setPrompt(detectPrompt(lines));
    };
    check();
    const unsub = terminal.onWrite(check);
    return unsub;
  }, [terminal]);

  if (!prompt) return null;

  const respond = async (text: string) => {
    setPrompt(null);
    await onResponse(text + '\n');
  };

  return (
    <div className="intervention-bar" role="alertdialog" aria-live="polite">
      <span className="intervention-text">{prompt.text}</span>
      <div className="intervention-actions">
        <button
          type="button"
          className="intervention-btn intervention-yes"
          onClick={() => void respond(prompt.positive)}
        >
          确认
        </button>
        <button
          type="button"
          className="intervention-btn intervention-no"
          onClick={() => void respond(prompt.negative)}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}