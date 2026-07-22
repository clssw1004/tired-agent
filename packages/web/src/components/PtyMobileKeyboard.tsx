/**
 * PtyMobileKeyboard — full on-screen QWERTY keyboard for mobile PTY sessions.
 *
 * Why: the system keyboard can't be avoided when an <input> is present, but
 * keeping an input bar permanently visible wastes vertical space and creates
 * a sync issue. This component replaces SpecialKeysBar + PtyInputBar on
 * mobile (PTY / process mode only).
 *
 * Two modes:
 *   Collapsed (~40px): Esc  ⇧  Ctrl  Tab  ↑ ↓  ⏎  🔤  🌐
 *                      (← → dropped — available in expanded mode;
 *                       IME 🌐 + 🔤 expand both stay here so the system
 *                       keyboard and letter input are always reachable)
 *   Expanded  (~280px): full QWERTY layout (punctuation stripped to keep
 *                       buttons wide on 360 px phones — `/` retained for
 *                       shell command lookup, no other symbols):
 *                          Esc / Brk / ← ↑ ↓ → / ▾
 *                       1 2 … 0 ⌫
 *                       Tab Q W … P
 *                       Caps A … L Enter
 *                       ⇧  Z … M / ⇧
 *                       🌐 Ctrl Space
 *                       Toggling Shift then tapping a digit still emits
 *                       the shifted variant (`! @ # $ % ^ & * ( )`) —
 *                       resolveBytes handles it; the variants just aren't
 *                       printed on the key labels.
 *
 * Modifier model:
 *   - Shift: tap once (oneShot) → next letter is upper, next symbol uses its
 *     shifted variant, then auto-reset. Long-press to sticky until tapped
 *     again (handled by the host setModifier's oneShot/sticky cycle).
 *   - Ctrl: same oneShot/sticky cycle, intercepts next key and produces a
 *     control byte (letter only — Ctrl+arrow / Ctrl+Tab keep base form).
 *   - Caps: local state in this component only (not part of the global
 *     ModifierState). Tap toggles a sticky uppercase mode. Caps + Shift
 *     behaves like a physical keyboard (XOR — Caps on + Shift on = lowercase).
 *
 * IME mode: tapping 🌐 summons a floating input with the system keyboard for
 * Chinese/IME input. Type text → tap ⏎ → whole chunk sent to PTY → closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModifierKey, ModifierState } from './SpecialKeysBar';

// ─── Types ───────────────────────────────────────────────────────────

interface KeyDef {
  id: string;
  label: string;
  /** Bytes sent with no modifier (and no Caps for letters). */
  base: string;
  /** Bytes sent when Shift is held (or Caps on for letters). */
  shifted?: string;
  /** Bytes sent when Ctrl is held (letters only — control-byte). */
  ctrl?: string;
  /** Flex weight for the row layout; defaults to 1. */
  width?: number;
  kind: 'letter' | 'symbol' | 'control' | 'modifier' | 'action' | 'ui';
}

// ─── Lookup tables ───────────────────────────────────────────────────

/** Shift+digit → ! @ # $ % ^ & * ( ). Used by resolveBytes when the user
 *  toggles Shift then taps a digit — matches physical-keyboard behavior
 *  even though the shifted variant isn't rendered on the key label. */
const SHIFTED_DIGITS = '!@#$%^&*()';

// ─── Key factories ───────────────────────────────────────────────────

function letterDef(ch: string): KeyDef {
  return {
    id: ch,
    label: ch,
    base: ch,
    shifted: ch.toUpperCase(),
    ctrl: String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40),
    kind: 'letter',
  };
}

function digitDef(ch: string): KeyDef {
  return {
    id: ch,
    label: ch,
    base: ch,
    shifted: SHIFTED_DIGITS[Number(ch)],
    kind: 'symbol',
  };
}

// ─── Row layouts (no punctuation — / retained for shell commands) ───

/** Row 0 — utility: Esc / Brk / arrows / collapse toggle. */
const TOP_UTIL_ROW: KeyDef[] = [
  { id: 'esc', label: 'Esc', base: '\x1b', kind: 'control' },
  { id: 'brk', label: 'Brk', base: '\x1c', kind: 'control' },
  { id: 'arrow-left', label: '←', base: '\x1b[D', kind: 'control' },
  { id: 'arrow-up', label: '↑', base: '\x1b[A', kind: 'control' },
  { id: 'arrow-down', label: '↓', base: '\x1b[B', kind: 'control' },
  { id: 'arrow-right', label: '→', base: '\x1b[C', kind: 'control' },
  { id: 'collapse', label: '▾', base: '', kind: 'ui' },
];

/** Row 1 — number row: 1 2 … 0 ⌫. Punctuation (` - =) dropped. */
const NUMBER_ROW: KeyDef[] = [
  ...'1234567890'.split('').map(digitDef),
  { id: 'backspace', label: '⌫', base: '\x7f', kind: 'action', width: 1.5 },
];

/** Row 2 — QWERTY top: Tab Q W … P. Bracket symbols ([ ] \) dropped. */
const TOP_ROW: KeyDef[] = [
  { id: 'tab', label: 'Tab', base: '\t', shifted: '\x1b[Z', kind: 'control', width: 1.5 },
  ...'qwertyuiop'.split('').map(letterDef),
];

/** Row 3 — QWERTY home: Caps A … L Enter. ; ' dropped. */
const HOME_ROW: KeyDef[] = [
  { id: 'caps', label: 'Caps', base: '', kind: 'modifier', width: 1.75 },
  ...'asdfghjkl'.split('').map(letterDef),
  { id: 'enter', label: '⏎', base: '\r', kind: 'control', width: 2.25 },
];

/** Row 4 — QWERTY bottom: ⇧ Z … M / ⇧. , . dropped; / retained because
 *  shells use it to trigger command lookup (Ctrl+R-style history search
 *  helpers, etc.). */
const BOTTOM_ROW: KeyDef[] = [
  { id: 'shift', label: '⇧', base: '', kind: 'modifier', width: 2.0 },
  ...'zxcvbnm'.split('').map(letterDef),
  { id: '/', label: '/', base: '/', shifted: '?', kind: 'symbol' },
  { id: 'shift2', label: '⇧', base: '', kind: 'modifier', width: 2.0 },
];

/** Row 5 — space row: 🌐 Ctrl Space. */
const SPACE_ROW: KeyDef[] = [
  { id: 'ime', label: '🌐', base: '', kind: 'ui', width: 1.2 },
  { id: 'ctrl', label: 'Ctrl', base: '', kind: 'modifier', width: 1.5 },
  { id: 'space', label: 'Space', base: ' ', kind: 'action', width: 7.3 },
];

/** Collapsed-mode row — single-row control strip shown when 🔤 is tapped.
 *  Order (left → right): Esc / Shift / Ctrl / Tab / ↑ ↓ / Enter / 🔤 / 🌐.
 *  Horizontal arrows (← →) are dropped from the collapsed row — 360 px phones
 *  made the row cramped, and ↑ ↓ cover the common "scroll history / step
 *  line" use case. Full ← ↑ ↓ → is still available in the expanded
 *  util row (TOP_UTIL_ROW). IME 🌐 stays here so the system keyboard is
 *  always reachable without expanding. 🔤 stays too — otherwise the user
 *  is trapped in the collapsed view and must refresh to get back to
 *  letter input. ▾ collapse lives in the expanded util row. */
const COLLAPSED_KEYS: KeyDef[] = [
  { id: 'esc', label: 'Esc', base: '\x1b', kind: 'control', width: 1.0 },
  { id: 'shift', label: '⇧', base: '', kind: 'modifier', width: 1.0 },
  { id: 'ctrl', label: 'Ctrl', base: '', kind: 'modifier', width: 1.0 },
  { id: 'tab', label: 'Tab', base: '\t', shifted: '\x1b[Z', kind: 'control', width: 1.0 },
  { id: 'arrow-up', label: '↑', base: '\x1b[A', kind: 'control', width: 0.9 },
  { id: 'arrow-down', label: '↓', base: '\x1b[B', kind: 'control', width: 0.9 },
  { id: 'enter', label: '⏎', base: '\r', kind: 'control', width: 1.3 },
  { id: 'expand', label: '🔤', base: '', kind: 'ui', width: 1.0 },
  { id: 'ime', label: '🌐', base: '', kind: 'ui', width: 1.0 },
];

// ─── Byte resolution ─────────────────────────────────────────────────

/** Compute the bytes a key produces given the current modifier state and
 *  Caps-lock flag. Caps XOR Shift for letter case (physical-keyboard rule):
 *    caps=0 shift=0 → lowercase
 *    caps=0 shift=1 → uppercase
 *    caps=1 shift=0 → uppercase
 *    caps=1 shift=1 → lowercase
 *  Ctrl takes precedence over Shift/Caps and yields the control byte for
 *  letters. Shift on a symbol key picks its shifted variant. */
function resolveBytes(key: KeyDef, mod: ModifierState, capsOn: boolean): string | null {
  if (key.base === '' && key.shifted === undefined && key.ctrl === undefined) {
    // Empty key (modifier / ui / spacer) — never emits.
    return null;
  }

  // Ctrl first — control bytes for letters, otherwise unmodified.
  if (mod.ctrl !== 'off' && key.ctrl !== undefined) {
    return key.ctrl;
  }

  // Letters: case decided by (caps XOR shift). Shift oneShot on a lowercase
  // symbol that happens to be a letter doesn't change the underlying bytes
  // when ctrl is also off, so we evaluate caps+shift here.
  if (key.kind === 'letter') {
    const upper = (mod.shift !== 'off') !== capsOn; // XOR
    return (upper ? key.shifted : key.base) ?? null;
  }

  // Symbol/control/action keys: shift picks the shifted variant when present.
  if (mod.shift !== 'off' && key.shifted !== undefined) {
    return key.shifted;
  }

  return key.base || null;
}

// ─── IME Floating Input ──────────────────────────────────────────────

/** Multi-line IME editor that pops over the on-screen keyboard.
 *  Plain Enter inserts a newline; Shift+Enter / Ctrl+Enter / Cmd+Enter
 *  send the chunk to the PTY (a single `\n`-terminated write so the
 *  underlying program gets exactly one logical command line back).
 *  Escape closes without sending. The ⏎ button always sends. */
function ImeInput({ onSend, onClose }: { onSend: (t: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');

  useEffect(() => { ref.current?.focus(); }, []);

  const send = () => {
    if (text) onSend(text);
    setText('');
    onClose();
  };

  return (
    <div className="pty-ime-overlay">
      <textarea
        ref={ref}
        className="pty-ime-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const native = e.nativeEvent as any;
          if (native.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
          }
          // Shift/Ctrl/Cmd + Enter → send. Plain Enter falls through to
          // the textarea default and inserts a newline.
          if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder="输入文字 — Enter 换行，Shift+Enter 发送"
        rows={3}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <div className="pty-ime-actions">
        <button type="button" className="pty-ime-close" onClick={onClose} aria-label="取消">✕</button>
        <button type="button" className="inputbar-send" onClick={send} aria-label="发送">⏎</button>
      </div>
    </div>
  );
}

// ─── KeyButton ───────────────────────────────────────────────────────

function KeyButton({ def, active, disabled, onTap }: {
  def: KeyDef; active?: boolean; disabled?: boolean; onTap: (d: KeyDef) => void;
}) {
  const cls = 'pty-key' + (active ? ' pty-key-active' : '') +
    (def.kind === 'modifier' ? ' pty-key-mod' : '') +
    (def.kind === 'letter' ? ' pty-key-letter' : '') +
    (def.id === 'space' ? ' pty-key-wide' : '');
  return (
    <button type="button" className={cls}
      style={def.width ? { flex: `${def.width} 1 0%` } : undefined}
      disabled={disabled}
      onPointerDown={(e) => { e.preventDefault(); onTap(def); }}
    >{def.label}</button>
  );
}

// ─── Main ────────────────────────────────────────────────────────────

interface Props {
  disabled?: boolean;
  modifiers: ModifierState;
  onSetModifier: (key: ModifierKey, mode: 'off' | 'oneShot' | 'sticky') => void;
  onConsumeModifier: (key: ModifierKey) => void;
  onKey: (bytes: string) => void;
}

export function PtyMobileKeyboard({ disabled, modifiers, onSetModifier, onConsumeModifier, onKey }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [imeOpen, setImeOpen] = useState(false);
  /** Caps-lock state — local to this keyboard only. Not part of the global
   *  ModifierState because Caps is sticky (not oneShot) and only this
   *  component renders the toggle. */
  const [capsOn, setCapsOn] = useState(false);
  // Desktop detection: match CSS breakpoint. Not a hook, safe to use in render.
  const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;

  const handleTap = useCallback((def: KeyDef) => {
    if (disabled) return;
    switch (def.kind) {
      case 'modifier': {
        if (def.id === 'ctrl') {
          const cur = modifiers.ctrl;
          const next: 'off' | 'oneShot' | 'sticky' =
            cur === 'off' ? 'oneShot' : cur === 'oneShot' ? 'sticky' : 'off';
          onSetModifier('ctrl', next);
        } else if (def.id === 'shift' || def.id === 'shift2') {
          const cur = modifiers.shift;
          const next: 'off' | 'oneShot' | 'sticky' =
            cur === 'off' ? 'oneShot' : cur === 'oneShot' ? 'sticky' : 'off';
          onSetModifier('shift', next);
        } else if (def.id === 'caps') {
          setCapsOn((v) => !v);
        }
        return;
      }
      case 'ui': {
        if (def.id === 'expand') setExpanded(true);
        else if (def.id === 'collapse') setExpanded(false);
        else if (def.id === 'ime') setImeOpen(true);
        return;
      }
      default: {
        const bytes = resolveBytes(def, modifiers, capsOn);
        if (bytes) onKey(bytes);
        if (modifiers.ctrl !== 'off') onConsumeModifier('ctrl');
        if (modifiers.shift !== 'off') onConsumeModifier('shift');
      }
    }
  }, [disabled, modifiers, capsOn, onSetModifier, onConsumeModifier, onKey]);

  const handleImeSend = useCallback((text: string) => { onKey(text); }, [onKey]);

  const r = (def: KeyDef) => (
    <KeyButton key={def.id} def={def}
      active={
        (def.id === 'ctrl' && modifiers.ctrl !== 'off') ||
        ((def.id === 'shift' || def.id === 'shift2') && modifiers.shift !== 'off') ||
        (def.id === 'caps' && capsOn)
      }
      disabled={disabled} onTap={handleTap} />
  );

  // Desktop: render nothing. The CSS already hides the keyboard at >=768px,
  // but removing the DOM entirely avoids wasted work and any layout edge cases.
  if (isDesktop) return null;

  return (
    <>
      {!imeOpen && (
        <div className={'pty-keyboard' + (expanded ? ' pty-keyboard-expanded' : '')}>
          {expanded ? (
            <>
              <div className="pty-keyboard-row">{TOP_UTIL_ROW.map(r)}</div>
              <div className="pty-keyboard-row">{NUMBER_ROW.map(r)}</div>
              <div className="pty-keyboard-row">{TOP_ROW.map(r)}</div>
              <div className="pty-keyboard-row">{HOME_ROW.map(r)}</div>
              <div className="pty-keyboard-row">{BOTTOM_ROW.map(r)}</div>
              <div className="pty-keyboard-row pty-space-row">{SPACE_ROW.map(r)}</div>
            </>
          ) : (
            <div className="pty-keyboard-row pty-collapsed-row">{COLLAPSED_KEYS.map(r)}</div>
          )}
        </div>
      )}
      {/* IME overlay is portaled to document.body so position:fixed is
          unaffected by .pty-keyboard's backdrop-filter (Safari bug). */}
      {imeOpen && createPortal(
        <ImeInput onSend={handleImeSend} onClose={() => setImeOpen(false)} />,
        document.body,
      )}
    </>
  );
}
