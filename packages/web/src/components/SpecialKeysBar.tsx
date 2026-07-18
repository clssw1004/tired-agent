/**
 * SpecialKeysBar — mobile-only row of terminal shortcuts.
 *
 * Sits just above the InputBar on phones/tablets. Hidden on desktop via the
 * `min-width: 768px` breakpoint in styles.css so it never crowds the xterm
 * view when a physical keyboard is available.
 *
 * Each key emits raw terminal escape bytes (Esc/Tab/arrows/Ctrl+C/D/Break).
 * `onPointerDown` with `preventDefault()` keeps focus on the InputBar below
 * so the soft keyboard stays up — tapping a special key must not collapse it.
 *
 * Long-press (500ms) on Ctrl+C / Ctrl+D fires a double-byte sequence to force
 * a hard interrupt for stubborn TUIs (Claude's spinner occasionally swallows
 * a single SIGINT). Long-press triggers a short haptic on Android.
 */

import { useRef } from 'react';

interface SpecialKey {
  label: string;
  bytes: string;
  longPressBytes?: string;
}

const KEYS: SpecialKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: '↑',  bytes: '\x1b[A' },
  { label: '↓',  bytes: '\x1b[B' },
  { label: '←',  bytes: '\x1b[D' },
  { label: '→',  bytes: '\x1b[C' },
  { label: 'C-c', bytes: '\x03', longPressBytes: '\x03\x03' },
  { label: 'C-d', bytes: '\x04', longPressBytes: '\x04\x04' },
  { label: 'Brk', bytes: '\x1c' },
];

const LONG_PRESS_MS = 500;

/** Best-effort haptic. Silently no-ops on iOS Safari (no vibrate API). */
function haptic(ms = 15): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { (navigator as Navigator & { vibrate: (n: number) => boolean }).vibrate(ms); } catch { /* ignore */ }
  }
}

interface Props {
  disabled?: boolean;
  onKey: (bytes: string) => void;
}

export function SpecialKeysBar({ disabled, onKey }: Props) {
  const timerRef = useRef<number | null>(null);
  const firedLongRef = useRef(false);

  const cancel = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const press = (key: SpecialKey) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    firedLongRef.current = false;
    if (key.longPressBytes) {
      timerRef.current = window.setTimeout(() => {
        firedLongRef.current = true;
        haptic(25);
        onKey(key.longPressBytes!);
        timerRef.current = null;
      }, LONG_PRESS_MS);
    }
  };

  const release = (key: SpecialKey) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    if (timerRef.current !== null) {
      // Short tap — fire the single-byte version.
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!firedLongRef.current) {
        haptic(8);
        onKey(key.bytes);
      }
    }
  };

  const leave = () => cancel();

  return (
    <div className="special-keys" role="toolbar" aria-label="Terminal special keys">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          className="special-key"
          disabled={disabled}
          title={k.label}
          aria-label={k.label}
          onPointerDown={press(k)}
          onPointerUp={release(k)}
          onPointerLeave={leave}
          onPointerCancel={leave}
          onClick={(e) => e.preventDefault()}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}