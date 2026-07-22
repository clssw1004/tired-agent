/**
 * PtyInputBar — mobile keyboard passthrough (PTY mode only).
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
 *
 * Modifier integration: when {@link modifiers} has Ctrl and/or Shift in a
 * non-'off' mode (toggled via the SpecialKeysBar button), the next
 * non-modifier keystroke consumes that state and emits the
 * corresponding bytes (Ctrl+letter → control byte, Shift+letter →
 * uppercase, Ctrl+Shift+Tab → back-tab, etc.). `oneShot` modifiers are
 * auto-reverted to 'off' on consumption; `sticky` ones persist until
 * the user taps the modifier button again. See
 * docs/superpowers/specs/2026-07-20-pty-modifier-keys-design.md.
 */

import { useRef, useEffect, useState } from 'react';
import {
  SPECIAL_KEY_MODIFIER_SPECS,
  resolveBytes,
  type ModifierKey,
  type ModifierState,
} from './SpecialKeysBar';

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
  /** Modifier key state lifted from PtySessionView. When any modifier is
   *  non-'off', the next keystroke is intercepted and routed through
   *  {@link resolveBytes} / control-byte logic instead of the native
   *  `<input>` flow. */
  modifiers?: ModifierState;
  /** Auto-revert a modifier from 'oneShot' → 'off' after it's been
   *  consumed. Called once per keystroke that used the modifier. */
  onConsumeModifier?: (key: ModifierKey) => void;
  /** Session ID — changes when navigating to a different session. Used to
   *  reset the input value on re-entry so stale half-typed text doesn't
   *  persist across sessions (sync issue between input bar and xterm buffer). */
  sessionId?: string;
}

export function PtyInputBar({ disabled, sending, placeholder, onChange, onEnter, modifiers, onConsumeModifier, sessionId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  // Reset input value when entering a new session so the text field doesn't
  // carry stale half-typed content from a previous session. The component
  // may remount in some navigation patterns, but a route re-entry that
  // React preserves (same key) would keep the old value without this guard.
  const prevSessionRef = useRef(sessionId);
  useEffect(() => {
    if (sessionId && sessionId !== prevSessionRef.current) {
      setValue('');
      prevSessionRef.current = sessionId;
    }
  }, [sessionId]);

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
    preCompositionValueRef.current = e.currentTarget.value;
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    const next = e.currentTarget.value;
    // Emit the entire committed delta from where composition started.
    // This is the only path that fires for IME users — intermediate
    // onChange events are skipped while composing.
    flushDelta(preCompositionValueRef.current, next);
    setValue(next);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value;
    // Skip while IME is composing — the intermediate text isn't final.
    // Also skip if the browser already flagged this event as composing
    // (covers browsers that don't fire compositionstart for autocorrect).
    const native = e.nativeEvent as InputEvent;
    if (composingRef.current || native.isComposing) {
      setValue(next);
      return;
    }
    flushDelta(value, next);
    setValue(next);
  };

  const handleSendEnter = () => {
    onChange('\r');
    setValue('');
    onEnter?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // While composing, do NOT forward special keys — Tab/arrows during
    // IME input would be sent to the underlying program and corrupt the
    // composition state.
    const native = e.nativeEvent as unknown as InputEvent;
    if (composingRef.current || native.isComposing) return;

    // Physical modifier keys (held by the user) act like a one-shot modifier:
    // the browser manages key-up on its own, so we don't consume them, but we
    // DO route them through the same resolveBytes path so Shift+Tab emits
    // \x1b[Z (back-tab), Shift+Arrow emits \x1b[1;2X, Ctrl+letter emits a
    // control byte, etc. Cmd on macOS maps to Ctrl for terminal purposes.
    const physicalCtrl = e.ctrlKey || e.metaKey;
    const physicalShift = e.shiftKey;
    const physicalAlt = e.altKey;
    const effective: ModifierState = {
      ctrl: physicalCtrl ? 'oneShot' : (modifiers?.ctrl ?? 'off'),
      shift: physicalShift ? 'oneShot' : (modifiers?.shift ?? 'off'),
    };
    const anyModifier = effective.ctrl !== 'off' || effective.shift !== 'off';

    // ── Special keys with modifier variants (Tab + arrows) ─────────
    // Always resolve through SPECIAL_KEY_MODIFIER_SPECS so physical
    // Shift+Tab / Shift+Arrow / Ctrl+Arrow all produce the correct bytes.
    const spec = SPECIAL_KEY_MODIFIER_SPECS[e.key];
    if (spec && (anyModifier || !physicalAlt)) {
      e.preventDefault();
      onChange(resolveBytes(spec, effective));
      // Only consume toggle modifier state — physical modifiers release
      // themselves when the user lifts the key.
      onConsumeModifier?.('ctrl');
      onConsumeModifier?.('shift');
      return;
    }

    // ── Printable letter with any modifier ────────────────────────
    // Ctrl→control byte, Shift→uppercase, both→control byte (shift has
    // no visible effect on control codes but is consumed either way).
    if (e.key.length === 1 && !physicalAlt && anyModifier) {
      e.preventDefault();
      let bytes: string;
      if (effective.ctrl !== 'off') {
        const code = e.key.toUpperCase().charCodeAt(0);
        bytes = (code >= 0x40 && code <= 0x5f)
          ? String.fromCharCode(code - 0x40)
          : e.key;
      } else {
        bytes = e.key;
      }
      if (effective.shift !== 'off') bytes = bytes.toUpperCase();
      onChange(bytes);
      onConsumeModifier?.('ctrl');
      onConsumeModifier?.('shift');
      return;
    }

    // ── Plain special keys (no modifier variants) ────────────────
    // Tab/arrows already handled above via SPECIAL_KEY_MODIFIER_SPECS.
    // Enter and Escape have no modifier variants in this app.
    const map: Record<string, string> = {
      Enter: '\r',
      Escape: '\x1b',
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
    // Physical Ctrl+<key> fallback for keys not in spec map (shouldn't
    // normally fire because the letter branch above already handled it,
    // but kept as a safety net for unusual keys like F1-F12).
    if (physicalCtrl && e.key.length === 1) {
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
      <button
        type="button"
        className="inputbar-send"
        disabled={disabled || sending}
        onClick={handleSendEnter}
        aria-label="Send Enter"
        title="Send Enter"
      >
        ⏎
      </button>
    </form>
  );
}