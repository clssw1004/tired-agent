/**
 * useDeviceType — viewport-based device classification.
 *
 * Returns 'desktop' when window.innerWidth >= DESKTOP_MIN_WIDTH, 'mobile'
 * otherwise. Listens for `resize` events so dragging a desktop window
 * across the 768 px boundary (or rotating a phone) re-classifies
 * correctly. Replaces an earlier one-shot `useState(() => innerWidth >= 768)`
 * that never updated.
 */

import { useEffect, useState } from 'react';

/** Match CSS `@media (min-width: 768px)` breakpoints in styles.css. */
export const DESKTOP_MIN_WIDTH = 768;

export type DeviceType = 'desktop' | 'mobile';

function classify(): DeviceType {
  return window.innerWidth >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';
}

export function useDeviceType(): DeviceType {
  const [type, setType] = useState<DeviceType>(classify);

  useEffect(() => {
    const handler = () => {
      const next = classify();
      // Avoid an unnecessary re-render when the value hasn't actually changed.
      setType((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return type;
}
