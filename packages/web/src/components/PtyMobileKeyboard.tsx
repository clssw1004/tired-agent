/**
 * PtyMobileKeyboard — custom on-screen keyboard for mobile PTY sessions.
 *
 * Why: the system keyboard can't be avoided when an <input> is present, but
 * keeping an input bar permanently visible wastes vertical space and creates
 * a sync issue. This component replaces SpecialKeysBar + PtyInputBar on
 * mobile (PTY / process mode only).
 *
 * Two modes:
 *   Collapsed (~40px): ← ↑ ↓ → Esc Tab c d Brk Ctrl Shift 🔤
 *   Expanded  (~240px): QWERTY letters + control keys + Space/Enter/IME
 *
 * IME mode: tapping 🌐 summons a floating input with system keyboard for
 * Chinese/IME input. Type text → tap ⏎ → whole chunk sent to PTY → closes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModifierKey, ModifierState } from './SpecialKeysBar';

// ─── Types ───────────────────────────────────────────────────────────

interface KeyDef {
  id: string;
  label: string;
  base: string;
  shift?: string;
  ctrl?: string;
  width?: number;
  kind: 'letter' | 'control' | 'modifier' | 'action' | 'ui';
}

// ─── Key definitions ─────────────────────────────────────────────────

function letterDefs(chars: string): KeyDef[] {
  return chars.split(' ').map((ch) => ({
    id: ch, label: ch, base: ch, shift: ch.toUpperCase(),
    ctrl: String.fromCharCode(ch.toUpperCase().charCodeAt(0) - 0x40),
    kind: 'letter' as const,
  }));
}

const LETTER_ROW_1 = letterDefs('q w e r t y u i o p');
const LETTER_ROW_2 = letterDefs('a s d f g h j k l');

const LETTER_ROW_3: KeyDef[] = [
  { id: 'shift', label: '⇧', base: '', kind: 'modifier', width: 1.5 },
  ...letterDefs('z x c v b n m'),
  { id: 'backspace', label: '⌫', base: '\x7f', kind: 'action', width: 1.5 },
];

const ACTION_ROW: KeyDef[] = [
  { id: 'ime', label: '🌐', base: '', kind: 'ui', width: 1.0 },
  { id: 'slash', label: '/', base: '/', kind: 'action', width: 1.0 },
  { id: 'ctrl', label: 'Ctrl', base: '', kind: 'modifier', width: 1.2 },
  { id: 'space', label: 'Space', base: ' ', kind: 'action', width: 3.2 },
  { id: 'dot', label: '.', base: '.', kind: 'action', width: 1.0 },
  { id: 'enter2', label: '⏎', base: '\r', kind: 'action', width: 1.5 },
];

const CTRL_ROW: KeyDef[] = [
  { id: 'arrow-left', label: '←', base: '\x1b[D', kind: 'control' },
  { id: 'arrow-up', label: '↑', base: '\x1b[A', kind: 'control' },
  { id: 'arrow-down', label: '↓', base: '\x1b[B', kind: 'control' },
  { id: 'arrow-right', label: '→', base: '\x1b[C', kind: 'control' },
  { id: 'esc', label: 'Esc', base: '\x1b', kind: 'control' },
  { id: 'tab', label: 'Tab', base: '\t', kind: 'control', width: 1.2 },
  { id: 'brk', label: 'Brk', base: '\x1c', kind: 'control' },
];

const COLLAPSED_KEYS: KeyDef[] = [
  ...CTRL_ROW,
  { id: 'ctrl', label: 'Ctrl', base: '', kind: 'modifier', width: 1.2 },
  { id: 'shift', label: 'Shift', base: '', kind: 'modifier', width: 1.2 },
  { id: 'expand', label: '🔤', base: '', kind: 'ui' },
];

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveBytes(key: KeyDef, mod: ModifierState): string | null {
  if (mod.ctrl !== 'off' && key.ctrl !== undefined) return key.ctrl;
  if (mod.shift !== 'off' && key.shift !== undefined) return key.shift;
  return key.base || null;
}

// ─── IME Floating Input ──────────────────────────────────────────────

function ImeInput({ onSend, onClose }: { onSend: (t: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');

  useEffect(() => { ref.current?.focus(); }, []);

  const send = () => {
    if (text) onSend(text);
    setText('');
    onClose();
  };

  return (
    <div className="pty-ime-overlay">
      <div className="pty-ime-bar">
        <input ref={ref} type="text" value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const native = e.nativeEvent as any;
            if (e.key === 'Enter' && !native.isComposing) send();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="输入文字…" autoComplete="off" spellCheck={false} />
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
      style={def.width ? { flex: `${def.width} 0 auto` } : undefined}
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

  const handleTap = useCallback((def: KeyDef) => {
    if (disabled) return;
    switch (def.kind) {
      case 'modifier': {
        if (def.id === 'ctrl' || def.id === 'shift') {
          const cur = modifiers[def.id as ModifierKey];
          const next: 'off' | 'oneShot' | 'sticky' = cur === 'off' ? 'oneShot' : cur === 'oneShot' ? 'sticky' : 'off';
          onSetModifier(def.id as ModifierKey, next);
        }
        return;
      }
      case 'ui': {
        if (def.id === 'expand') { setExpanded((v) => !v); return; }
        if (def.id === 'ime') { setImeOpen(true); return; }
        return;
      }
      default: {
        const bytes = resolveBytes(def, modifiers);
        if (bytes) onKey(bytes);
        if (modifiers.ctrl !== 'off') onConsumeModifier('ctrl');
        if (modifiers.shift !== 'off') onConsumeModifier('shift');
      }
    }
  }, [disabled, modifiers, onSetModifier, onConsumeModifier, onKey]);

  const handleImeSend = useCallback((text: string) => { onKey(text); }, [onKey]);

  const r = (def: KeyDef) => (
    <KeyButton key={def.id} def={def}
      active={(def.id === 'ctrl' && modifiers.ctrl !== 'off') || (def.id === 'shift' && modifiers.shift !== 'off')}
      disabled={disabled} onTap={handleTap} />
  );

  return (
    <div className={'pty-keyboard' + (expanded ? ' pty-keyboard-expanded' : '')}>
      {expanded ? (
        <>
          <div className="pty-keyboard-row">{LETTER_ROW_1.map(r)}</div>
          <div className="pty-keyboard-row">{LETTER_ROW_2.map(r)}</div>
          <div className="pty-keyboard-row">{LETTER_ROW_3.map(r)}</div>
          <div className="pty-keyboard-row">{ACTION_ROW.map(r)}</div>
          <div className="pty-keyboard-row">{CTRL_ROW.map(r)}</div>
        </>
      ) : (
        <div className="pty-keyboard-row">{COLLAPSED_KEYS.map(r)}</div>
      )}
      {imeOpen && <ImeInput onSend={handleImeSend} onClose={() => setImeOpen(false)} />}
    </div>
  );
}
