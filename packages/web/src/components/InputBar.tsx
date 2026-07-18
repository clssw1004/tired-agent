/**
 * InputBar — mobile keyboard passthrough.
 *
 * Why this exists: on phones, xterm.js's canvas does NOT pop the soft
 * keyboard. The user has no way to type into the terminal. We solve this
 * by rendering a native <input> that the OS focuses — every keystroke
 * is forwarded verbatim to {@link onChange} so the host can ship each
 * character (or backspace, arrow, etc.) to the PTY immediately.
 *
 * The "submit" behaviour is intentionally absent. In a TUI the Enter key
 * is just `\r` — the same as any other character. The host treats all
 * input identically: forward to the PTY, let the PTY echo back.
 *
 * The internal `value` state is intentionally ephemeral — we don't need
 * to remember typed text (the PTY owns the line buffer); we only mirror
 * what the user types so the input visually updates, which keeps mobile
 * keyboards happy (composition events, autocorrect, etc.).
 */

import { useRef, useEffect, useState } from 'react';

interface Props {
  disabled: boolean;
  sending: boolean;
  placeholder?: string;
  /** Called for every character (or backspace, arrow, etc.) the user types.
   *  `data` is the raw text — host is responsible for encoding to bytes. */
  onChange: (data: string) => void;
  /** Called when Enter is pressed (so the host can flush its own buffers). */
  onEnter?: () => void;
}

export function InputBar({ disabled, sending, placeholder, onChange, onEnter }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  // Refocus after each send resolves so the keyboard stays open on mobile.
  useEffect(() => {
    if (!sending) inputRef.current?.focus();
  }, [sending]);

  // Auto-focus on mount so the mobile keyboard pops up immediately.
  useEffect(() => {
    if (disabled) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [disabled]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // Diff: anything in `next` that wasn't in `value` is newly typed text.
    // For deletion, the simplest correct behaviour is to send a backspace
    // per character removed. (Autocorrect can rewrite multiple chars in
    // one event; we approximate by sending the delta.)
    if (next.length > value.length) {
      const added = next.slice(value.length);
      onChange(added);
    } else if (next.length < value.length) {
      const removed = value.length - next.length;
      onChange('\x7f'.repeat(removed));
    }
    setValue(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Special keys that <input> doesn't reflect in `value`: arrows, escape,
    // tab, ctrl+*, function keys. Translate to terminal bytes.
    const map: Record<string, string> = {
      Enter: '\r',
      Tab: '\t',
      Escape: '\x1b',
      ArrowUp: '\x1b[A',
      ArrowDown: '\x1b[B',
      ArrowRight: '\x1b[C',
      ArrowLeft: '\x1b[D',
    };
    const mapped = map[e.key];
    if (mapped) {
      e.preventDefault();
      onChange(mapped);
      if (e.key === 'Enter') {
        setValue('');
        onEnter?.();
      }
      return;
    }
    // Ctrl+<key> → control byte.
    if (e.ctrlKey && e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0);
      if (code >= 0x40 && code <= 0x5f) {
        e.preventDefault();
        onChange(String.fromCharCode(code - 0x40));
        return;
      }
    }
  };

  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onEnter?.();
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
        placeholder={placeholder ?? 'Type a command and press Enter…'}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
    </form>
  );
}