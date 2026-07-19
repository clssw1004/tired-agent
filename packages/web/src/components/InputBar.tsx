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
 * IME handling: while the user is composing (Chinese pinyin, Japanese
 * kana, autocorrect, etc.) intermediate onChange events fire with
 * partial text. Forwarding each intermediate string to the PTY makes the
 * terminal show "n", "ni", "nih", "niha", "nihao", "你好" — a mess. We
 * track composition via `compositionstart`/`compositionend` and `isComposing`,
 * buffer the diff, and only emit the final committed string on
 * `compositionend`. Special keys (Tab/Arrows/Esc/Ctrl+?) are also held
 * while composing — they never make sense mid-IME.
 *
 * The internal `value` state mirrors what the user has typed so the
 * input visually updates — required to keep mobile keyboards happy
 * (composition events, autocorrect, etc.).
 */

import { useRef, useEffect, useState } from 'react';

interface Props {
  disabled: boolean;
  sending: boolean;
  placeholder?: string;
  /** Called for every character (or backspace, arrow, etc.) the user types.
   *  `data` is the raw text — host is responsible for encoding to bytes.
   *  During IME composition this is NOT called until composition ends. */
  onChange: (data: string) => void;
  /** Called when Enter is pressed (so the host can flush its own buffers). */
  onEnter?: () => void;
}

export function InputBar({ disabled, sending, placeholder, onChange, onEnter }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  // IME state. `composingRef` is true between compositionstart and
  // compositionend (or while nativeEvent.isComposing on the latest event).
  // `preCompositionValueRef` snapshots the input value when composition
  // starts so we can compute the committed delta on compositionend.
  const composingRef = useRef(false);
  const preCompositionValueRef = useRef('');

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

  const flushDelta = (prev: string, next: string) => {
    if (prev === next) return;
    if (next.length > prev.length && next.startsWith(prev)) {
      // Pure append — most common case for normal typing.
      onChange(next.slice(prev.length));
    } else if (next.length < prev.length) {
      // Deletion — send backspace per removed char.
      const removed = prev.length - next.length;
      onChange('\x7f'.repeat(removed));
      if (next.length > 0 && !next.startsWith(prev.slice(0, next.length))) {
        // Autocorrect rewrite: prefix diverged after a shorter common prefix.
        // Send the full replacement text so the PTY ends up correct.
        onChange(next);
      }
    } else {
      // Same length but diverged (autocorrect at the cursor end). Send the
      // full new value to overwrite.
      onChange(next);
    }
  };

  const handleCompositionStart = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = true;
    preCompositionValueRef.current = e.target.value;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    const next = e.target.value;
    // Emit the entire committed delta from where composition started.
    // This is the only path that fires for IME users — intermediate
    // onChange events are skipped while composing.
    flushDelta(preCompositionValueRef.current, next);
    setValue(next);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    // Skip while IME is composing — the intermediate text isn't final.
    // Also skip if the browser already flagged this event as composing
    // (covers browsers that don't fire compositionstart for autocorrect).
    if (composingRef.current || e.nativeEvent.isComposing) {
      setValue(next);
      return;
    }
    flushDelta(value, next);
    setValue(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // While composing, do NOT forward special keys — Tab/arrows during
    // IME input would be sent to the underlying program and corrupt the
    // composition state.
    if (composingRef.current || e.nativeEvent.isComposing) return;

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
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
      />
    </form>
  );
}