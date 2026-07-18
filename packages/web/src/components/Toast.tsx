/**
 * Toast — non-blocking notification system.
 *
 * Use instead of alert() for transient feedback (success after a kill,
 * network error, etc). The toast appears at the top of the screen with a
 * slide-down animation, auto-dismisses after 3 s (configurable), and can
 * be tapped to dismiss immediately.
 *
 * Wired through React Context so any component can call
 * `useToast().show({...})` without prop-drilling.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastOptions {
  kind?: ToastKind;
  /** Duration in ms before auto-dismiss. 0 = sticky until tapped. Default 3000. */
  duration?: number;
}

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  duration: number;
}

interface ToastApi {
  show(text: string, options?: ToastOptions): void;
  success(text: string, duration?: number): void;
  error(text: string, duration?: number): void;
  info(text: string, duration?: number): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi['show']>((text, options) => {
    const id = nextId.current++;
    const item: ToastItem = {
      id,
      kind: options?.kind ?? 'info',
      text,
      duration: options?.duration ?? 3000,
    };
    setItems((prev) => [...prev, item]);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (text, duration) => show(text, { kind: 'success', duration }),
      error: (text, duration) => show(text, { kind: 'error', duration: duration ?? 4500 }),
      info: (text, duration) => show(text, { kind: 'info', duration }),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-live="polite">
        {items.map((t) => (
          <ToastItemView key={t.id} item={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItemView({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    if (item.duration <= 0) return;
    const t = window.setTimeout(onDismiss, item.duration);
    return () => window.clearTimeout(t);
  }, [item.duration, onDismiss]);

  const icon = item.kind === 'success' ? '✓' : item.kind === 'error' ? '✕' : 'ℹ';

  return (
    <button
      type="button"
      className={`toast toast-${item.kind}`}
      onClick={onDismiss}
      aria-label={`${item.kind}: ${item.text}. Tap to dismiss.`}
    >
      <span className="toast-icon" aria-hidden>{icon}</span>
      <span className="toast-text">{item.text}</span>
    </button>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}