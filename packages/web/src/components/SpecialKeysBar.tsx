/**
 * SpecialKeysBar — mobile-only row of terminal special keys.
 *
 * Phones don't have physical Tab/Arrow/Esc/Ctrl+C keys. Without this
 * bar, users typing into a Claude/Codex TUI can't navigate prompts,
 * accept dialogs, or interrupt runaway commands. Each button sends a
 * single terminal escape sequence to the host via {@link onKey}.
 *
 * Long-press = strong action (non-modifier buttons): tapping sends the
 * button's normal bytes; holding for ~500ms sends `longPressBytes`
 * (typically the bytes×2). Mirrors how a real user hammers Ctrl+C when
 * a process is wedged — one tap is polite, hold is "I mean it".
 *
 * Modifier buttons (Ctrl, Shift): tapping toggles a sticky/one-shot
 * modifier state at the PtySessionView host. While a modifier is
 * active, every other button computes its bytes via {@link resolveBytes}
 * so e.g. tapping the `↑` button with Shift active produces `\x1b[1;2A`
 * (ANSI shift-up) rather than plain `\x1b[A`. The same modifier state is
 * forwarded to PtyInputBar so system-keyboard letters typed into the
 * `<input>` after toggling Ctrl become `\x01` etc.
 *
 *   short press modifier = 'oneShot' (consumed by next non-modifier key)
 *   long  press modifier = 'sticky'  (stays active until tapped again)
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
 * portrait phones can't fit all 11 buttons in 360 CSS px. See CSS.
 *
 * Desktop hidden via CSS (`@media (min-width: 768px) { display: none }`).
 */

import { useRef } from 'react';

// ─── Modifier key types (shared with PtySessionView + PtyInputBar) ────
/** Identifier for a toggleable modifier (tapping it flips its mode). */
export type ModifierKey = 'ctrl' | 'shift';
/** Mode of a modifier:
 *   off      — not active;
 *   oneShot  — activated by a short tap; auto-reverts to off after the
 *              next non-modifier key consumes it;
 *   sticky   — activated by a long press; persists until the user taps
 *              the modifier button again. */
export type ModifierMode = 'off' | 'oneShot' | 'sticky';
export interface ModifierState {
  ctrl: ModifierMode;
  shift: ModifierMode;
}

const LONG_PRESS_MS = 500;
const MODIFIER_LONG_PRESS_MS = 400;

/** Per-byte-spec entry: describes the bytes a single key produces under
 *  each modifier combination. Any field omitted falls back to the next
 *  more permissive variant via {@link resolveBytes}. */
export interface ByteSpecs {
  base: string;
  shift?: string;
  ctrl?: string;
  ctrlShift?: string;
}

/** Specs for special keys that pass through PtyInputBar's `<input>`
 *  (Tab + the four arrows). Other keys (Esc, Enter) have no modifier
 *  variant and are intentionally omitted. Single source of truth so the
 *  button bar and the input interceptor don't drift out of sync. */
export const SPECIAL_KEY_MODIFIER_SPECS: Readonly<Record<string, ByteSpecs>> = {
  Tab:       { base: '\t',     shift: '\x1b[Z' },
  ArrowUp:   { base: '\x1b[A', shift: '\x1b[1;2A', ctrl: '\x1b[1;5A', ctrlShift: '\x1b[1;6A' },
  ArrowDown: { base: '\x1b[B', shift: '\x1b[1;2B', ctrl: '\x1b[1;5B', ctrlShift: '\x1b[1;6B' },
  ArrowLeft: { base: '\x1b[D', shift: '\x1b[1;2D', ctrl: '\x1b[1;5D', ctrlShift: '\x1b[1;6D' },
  ArrowRight:{ base: '\x1b[C', shift: '\x1b[1;2C', ctrl: '\x1b[1;5C', ctrlShift: '\x1b[1;6C' },
};

/** Compute the bytes for a key given the current {@link ModifierState}.
 *  Falls back gracefully when a more specific combination is missing. */
export function resolveBytes(specs: ByteSpecs, m: ModifierState): string {
  const anyOn = m.ctrl !== 'off' || m.shift !== 'off';
  if (!anyOn) return specs.base;
  if (m.ctrl !== 'off' && m.shift !== 'off') {
    return specs.ctrlShift ?? specs.ctrl ?? specs.shift ?? specs.base;
  }
  if (m.ctrl !== 'off') return specs.ctrl ?? specs.base;
  return specs.shift ?? specs.base;
}

// ─── Button model ─────────────────────────────────────────────────────

interface ModifierButtonDef {
  kind: 'modifier';
  modifier: ModifierKey;
  label: string;
  title?: string;
}

interface SpecialButtonDef {
  kind: 'special';
  label: string;
  /** Byte specs under each modifier combination. */
  specs: ByteSpecs;
  /** Bytes sent on long-press (~500ms hold). Defaults to base bytes×2. */
  longPressBytes?: string;
  title?: string;
}

type ButtonDef = ModifierButtonDef | SpecialButtonDef;

const MODIFIER_BUTTONS: ModifierButtonDef[] = [
  { kind: 'modifier', modifier: 'ctrl', label: 'Ctrl', title: 'Ctrl modifier (short: one-shot, long: sticky)' },
  { kind: 'modifier', modifier: 'shift', label: 'Shift', title: 'Shift modifier (short: one-shot, long: sticky)' },
];

/** Structured-mode keys: only interrupt and stop. Modifier toggles are
 *  not exposed in chat mode (no PTY input to compose against). */
const STRUCTURED_KEYS: SpecialButtonDef[] = [
  { kind: 'special', label: '中断', specs: { base: '\x03' }, longPressBytes: '\x03\x03', title: '中断 Claude (长按强制中断)' },
];

/** PTY-mode keys: full terminal control set + 2 modifier toggles. */
const PTY_KEYS: ButtonDef[] = [
  ...MODIFIER_BUTTONS,
  // Esc — unchanged by any modifier (raw escape byte).
  { kind: 'special', label: 'Esc', specs: { base: '\x1b' }, title: 'Escape' },
  // Tab — Shift+Tab is back-tab.
  { kind: 'special', label: 'Tab', specs: SPECIAL_KEY_MODIFIER_SPECS['Tab'], title: 'Tab (Shift: back-tab)' },
  // c / d — modifier-aware letters, replacing the old hard-coded C-c / C-d.
  { kind: 'special', label: 'c', specs: { base: 'c', shift: 'C', ctrl: '\x03', ctrlShift: '\x03' },
    longPressBytes: '\x03\x03', title: 'c — Ctrl+c to interrupt (hold: hard kill)' },
  { kind: 'special', label: 'd', specs: { base: 'd', shift: 'D', ctrl: '\x04', ctrlShift: '\x04' },
    longPressBytes: '\x04\x04', title: 'd — Ctrl+d for EOF (hold: double EOF)' },
  // Arrows — xterm-style modifier parameters (reused from shared spec).
  { kind: 'special', label: '↑', specs: SPECIAL_KEY_MODIFIER_SPECS['ArrowUp'], title: 'Arrow up' },
  { kind: 'special', label: '↓', specs: SPECIAL_KEY_MODIFIER_SPECS['ArrowDown'], title: 'Arrow down' },
  { kind: 'special', label: '←', specs: SPECIAL_KEY_MODIFIER_SPECS['ArrowLeft'], title: 'Arrow left' },
  { kind: 'special', label: '→', specs: SPECIAL_KEY_MODIFIER_SPECS['ArrowRight'], title: 'Arrow right' },
  // BREAK (\x1c, FS): pauses debugger / some TUI prompts. No modifier variant.
  { kind: 'special', label: 'Brk', specs: { base: '\x1c' }, title: 'Break — pause / debugger interrupt' },
];

// ─── Helpers ──────────────────────────────────────────────────────────

/** Best-effort haptic. Silently no-ops on iOS Safari. */
function haptic(ms: number): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try { (navigator as Navigator & { vibrate: (n: number) => boolean }).vibrate(ms); } catch { /* ignore */ }
  }
}

// ─── Component ────────────────────────────────────────────────────────

interface Props {
  /** Called with the raw terminal bytes for the tapped key. */
  onKey: (bytes: string) => void;
  disabled?: boolean;
  /** When true, render simplified keys for structured (chat) mode. */
  structured?: boolean;
  /** Current modifier key state. Required for PTY mode; unused in
   *  structured mode (where modifier buttons aren't rendered). */
  modifiers?: ModifierState;
  /** Set the modifier's mode. Used by modifier buttons to flip their
   *  own state; SpecialKeysBar also calls this when tapping a modifier
   *  while another modifier is active (toggle-off behavior). */
  onSetModifier?: (key: ModifierKey, mode: ModifierMode) => void;
}

export function SpecialKeysBar({ onKey, disabled, structured, modifiers, onSetModifier }: Props) {
  const keys = structured ? STRUCTURED_KEYS : PTY_KEYS;
  return (
    <div className={'special-keys' + (structured ? ' special-keys-structured' : '')} role="toolbar" aria-label={structured ? 'Chat controls' : 'Terminal special keys'}>
      {keys.map((k) => {
        if (k.kind === 'modifier') {
          const mode = modifiers?.[k.modifier] ?? 'off';
          return (
            <ModifierButton
              key={k.label}
              modifierKey={k.modifier}
              label={k.label}
              mode={mode}
              disabled={disabled}
              title={k.title}
              onSetMode={(m) => onSetModifier?.(k.modifier, m)}
            />
          );
        }
        return (
          <SpecialButton
            key={k.label}
            def={k}
            disabled={disabled}
            modifiers={modifiers ?? { ctrl: 'off', shift: 'off' }}
            onKey={onKey}
          />
        );
      })}
    </div>
  );
}

// ─── Modifier button ───────────────────────────────────────────────────

interface ModifierButtonProps {
  modifierKey: ModifierKey;
  label: string;
  mode: ModifierMode;
  disabled?: boolean;
  title?: string;
  onSetMode: (mode: ModifierMode) => void;
}

function ModifierButton({ label, mode, disabled, title, onSetMode }: ModifierButtonProps) {
  const timerRef = useRef<number | null>(null);
  const firedLongRef = useRef(false);

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    firedLongRef.current = false;
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      firedLongRef.current = true;
      timerRef.current = null;
      haptic(25);
      // Long press → sticky if currently off, otherwise toggle off.
      onSetMode(mode === 'off' ? 'sticky' : 'off');
    }, MODIFIER_LONG_PRESS_MS);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    cancelTimer();
    // If long-press already fired, don't double-toggle on release.
    if (firedLongRef.current) return;
    if (disabled) return;
    haptic(8);
    // Short press → oneShot if currently off, otherwise toggle off.
    onSetMode(mode === 'off' ? 'oneShot' : 'off');
  };

  const handlePointerCancel = () => { cancelTimer(); };

  const cls =
    'special-key modifier' +
    (mode === 'oneShot' ? ' is-one-shot' : '') +
    (mode === 'sticky' ? ' is-sticky' : '');
  return (
    <button
      type="button"
      className={cls}
      title={title}
      aria-label={title ?? label}
      aria-pressed={mode !== 'off'}
      disabled={disabled}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
      onClick={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
}

// ─── Special (action) button ──────────────────────────────────────────

interface SpecialButtonProps {
  def: SpecialButtonDef;
  disabled?: boolean;
  modifiers: ModifierState;
  onKey: (b: string) => void;
}

function SpecialButton({ def, disabled, modifiers, onKey }: SpecialButtonProps) {
  // Long-press logic: tap = resolveBytes(specs, modifiers); hold ≈500ms
  // = longPressBytes (or base×2). Same shape as the original KeyButton
  // but pulls modifier-adjusted bytes instead of a single hard-coded
  // `bytes` field.
  const timerRef = useRef<number | null>(null);
  const firedLongRef = useRef(false);

  const cancelTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (disabled) return;
    firedLongRef.current = false;
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      firedLongRef.current = true;
      timerRef.current = null;
      haptic(25);
      const lb = def.longPressBytes ?? def.specs.base + def.specs.base;
      onKey(lb);
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    cancelTimer();
    if (firedLongRef.current) return;
    if (disabled) return;
    haptic(8);
    onKey(resolveBytes(def.specs, modifiers));
  };

  const handlePointerCancel = () => { cancelTimer(); };

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
      onClick={(e) => e.preventDefault()}
    >
      {def.label}
    </button>
  );
}
