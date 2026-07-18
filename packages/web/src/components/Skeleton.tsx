/**
 * Skeleton — shimmering placeholder for loading content.
 *
 * Replace spinner loaders with these in lists so the layout doesn't jump
 * when real content arrives. The animation is a left-to-right gradient
 * sweep with prefers-reduced-motion fallback to a static placeholder.
 */

import './Skeleton.css';

interface Props {
  /** Height of the skeleton in px. Default 16. */
  height?: number;
  /** Width as a CSS length (e.g. "60%", "120px"). Default 100%. */
  width?: string;
  /** Border radius in px. Default 6. */
  radius?: number;
  /** Additional className(s) for layout (e.g. margins). */
  className?: string;
}

export function Skeleton({ height = 16, width = '100%', radius = 6, className }: Props) {
  return (
    <span
      className={'skeleton' + (className ? ` ${className}` : '')}
      style={{ height, width, borderRadius: radius }}
      aria-hidden
    />
  );
}

/** Pre-shaped skeleton row matching SessionCard. Use 4–6 of these. */
export function SkeletonSessionCard() {
  return (
    <div className="card skeleton-card">
      <span className="dot" style={{ opacity: 0.35 }} />
      <div className="card-info">
        <Skeleton height={14} width="50%" />
        <Skeleton height={11} width="70%" className="skeleton-meta" />
      </div>
      <div className="card-actions">
        <Skeleton height={28} width={56} radius={8} />
      </div>
    </div>
  );
}

/** Pre-shaped skeleton row matching ServerCard. */
export function SkeletonServerCard() {
  return (
    <div className="card skeleton-card">
      <div className="card-info">
        <Skeleton height={14} width="40%" />
        <Skeleton height={11} width="55%" className="skeleton-meta" />
      </div>
      <div className="card-actions">
        <Skeleton height={28} width={56} radius={8} />
        <Skeleton height={28} width={56} radius={8} />
      </div>
    </div>
  );
}