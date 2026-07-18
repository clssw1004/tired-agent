/**
 * Modal — mobile-first dialog primitive that replaces native confirm()/alert().
 *
 * Why we don't use window.confirm / window.alert on mobile:
 *   - iOS Safari renders confirm() full-screen and can't be styled
 *   - alert() blocks the event loop, no swipe-to-dismiss
 *   - neither triggers a haptic on accept/cancel
 *   - neither supports custom content (icons, descriptions)
 *
 * Modal renders as a bottom-sheet on portrait phones (full-width, slide-up
 * handle) and a centered card on wider viewports. Buttons are ≥44 px tall
 * to satisfy Apple HIG touch targets. Backdrop click + Escape both
 * resolve to `onCancel`.
 *
 * Use via the {@link confirm} helper for the common two-button case.
 */

import { useEffect } from 'react';

interface Props {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' styles the confirm button red and warns the user. */
  intent?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional icon emoji or text shown above the title. */
  icon?: string;
}

export function Modal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  intent = 'default',
  onConfirm,
  onCancel,
  icon,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <>
      <div className="modal-backdrop" onClick={onCancel} aria-hidden />
      <div
        className="modal-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? 'modal-desc' : undefined}
      >
        <div className="modal-handle" aria-hidden />
        {icon && <div className="modal-icon" aria-hidden>{icon}</div>}
        <div id="modal-title" className="modal-title">{title}</div>
        {description && <div id="modal-desc" className="modal-desc">{description}</div>}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn modal-btn-cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={'modal-btn modal-btn-confirm' + (intent === 'danger' ? ' is-danger' : '')}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}