/**
 * SpecialKeysBar — mobile-only row of terminal special keys.
 *
 * Phones don't have physical Tab/Arrow/Esc/Ctrl+C keys. Without this
 * bar, users typing into a Claude/Codex TUI can't navigate prompts,
 * accept dialogs, or interrupt runaway commands. Each button sends a
 * single terminal escape sequence to the host via {@link onKey}.
 *
 * Long-press = strong action: tapping a key sends its normal bytes;
 * holding the button for ~500ms sends the `longPressBytes` (twice the
 * signal for Ctrl+C = `\x03\x03`, etc). This matches how a real user
 * hammers Ctrl+C when a process is wedged — one tap is polite, hold
 * is "I mean it".
 *
 * Focus preservation: each button uses `onPointerDown` with
 * `preventDefault()` so tapping the button does NOT move focus away
 * from the underlying <input>. The soft keyboard stays open and the
 * user can keep typing immediately after a Tab or arrow press.
 *
 * Haptic feedback: short tap = 8ms vibration, long-press = 25ms.
 * Silently no-ops on iOS Safari (no vibrate API). Best-effort UX cue,
 * not load-bearing.
 *
 * Layout: button row scrolls horizontally on narrow screens — typical
 * portrait phones can't fit all 9 buttons in 360 CSS px. See CSS.
 *
 * Desktop hidden via CSS (`@media (min-width: 768px) { display: none }`).
 */

import { useRef } from 'react';

interface Props {
  /** Called with the raw terminal bytes for the tapped key. */
  onKey: (bytes: string) => void;
  disabled?: boolean;
}

interface KeyDef {
  label: string;
  bytes: string;
  /** Bytes sent on long-press (~500ms hold). Defaults to bytes×2. */
  longPressBytes?: string;
  title?: string;
}

const LONG_PRESS_MS = 500;

const KEYS: KeyDef[] = [
  { label: 'Esc',  bytes: '\x1b',    title: 'Escape' },
  { label: 'Tab',  bytes: '\t',      title: 'Tab' },
  { label: '↑',    bytes: '\x1b[A',  title: 'Arrow up' },
  { label: '↓',    bytes: '\x1b[B',  title: 'Arrow down' },
  { label: '←',    bytes: '\x1b[D',  title: 'Arrow left' },
  { label: '→',    bytes: '\x1b[C',  title: 'Arrow right' },
  // Ctrl+C: tap = polite interrupt, long-press = hard interrupt (\x03\x03).
  { label: 'C-c',  bytes: '\x03', longPressBytes: '\x03\x03', title: 'Ctrl+C — interrupt (hold: hard kill)' },
  // Ctrl+D: tap = EOF, hold = \x04\x04.
  { label: 'C-d',  bytes: '\x04', longPressBytes: '\x04\x04', title: 'Ctrl+D — EOF (hold: double EOF)' },
  // BREAK (\x1c, FS): pauses debugger / some TUI prompts. Not a regular
  // control character; dedicated button because no mobile keyboard
  // shortcut exists.
  { label: 'Brk',  bytes: '\x1c',    title: 'Break — pause / debugger interrupt' },
];

/** Best-effort haptic. Silently no-ops on iOS Safari. */
function haptic(ms: number): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { (navigator as Navigator & { vibrate: (n: number) => boolean }).vibrate(ms); } catch { /* ignore */ }
  }
}

export function SpecialKeysBar({ onKey, disabled }: Props) {
  return (
    <div className="special-keys" role="toolbar" aria-label="Terminal special keys">
      {KEYS.map((k) => (
        <KeyButton key={k.label} def={k} disabled={disabled} onKey={onKey} />
      ))}
    </div>
  );
}

function KeyButton({ def, disabled, onKey }: { def: KeyDef; disabled?: boolean; onKey: (b: string) => void }) {
  // Track long-press via setTimeout. We start the timer on pointerdown and
  // cancel on pointerup / pointerleave / pointercancel. If the timer
  // fires before release, we send the long-press bytes — otherwise the
  // tap fires on pointerup.
  const timerRef = useRef<number | null>(null);
  const firedLongRef = useRef(false);

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Prevent the button from stealing focus from <input>. Without this,
    // tapping a key dismisses the soft keyboard on mobile.
    e.preventDefault();
    if (disabled) return;
    firedLongRef.current = false;
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      firedLongRef.current = true;
      timerRef.current = null;
      haptic(25);
      onKey(def.longPressBytes ?? def.bytes + def.bytes);
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Always preventDefault so click doesn't steal focus.
    e.preventDefault();
    cancelTimer();
    // If the long-press timer already fired, don't re-send on release.
    if (firedLongRef.current) return;
    if (disabled) return;
    haptic(8);
    onKey(def.bytes);
  };

  const handlePointerCancel = () => {
    cancelTimer();
  };

  return (
    <button
      type="button"
      className="special-key"
      title={def.title}
      aria-label={def.title ?? def.label}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
      // Belt-and-braces: also stop click focus shift for browsers
      // that fire click without preceding pointerdown.
      onClick={(e) => e.preventDefault()}
    >
      {def.label}
    </button>
  );
}