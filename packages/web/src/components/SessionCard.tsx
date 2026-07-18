import type { Session, SessionStatus } from '@tired-agent/protocol';

interface Props {
  session: Session;
  onClick: () => void;
  onKill?: () => void;
  onDelete?: () => void;
}

const STATUS_BADGE: Record<SessionStatus, { className: string; label: string }> = {
  starting: { className: 'badge badge-warn',  label: 'Starting' },
  running:  { className: 'badge badge-ok',    label: 'Running'  },
  exited:   { className: 'badge badge-dim',   label: 'Exited'   },
};

/** Human-friendly "X minutes ago" formatter for exited sessions. */
function timeSince(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function SessionCard({ session, onClick, onKill, onDelete }: Props) {
  const badge = STATUS_BADGE[session.status];
  const exitedAgo =
    session.status === 'exited' && session.exitedAt ? timeSince(session.exitedAt) : null;

  return (
    <div className="card card-clickable session-card" onClick={onClick}>
      <div className="card-info">
        <div className="card-name">
          {session.label || session.cmd}
          <span className={badge.className + ' session-badge'}>{badge.label}</span>
        </div>
        <div className="card-meta">
          {session.args?.length
            ? `${session.cmd} ${session.args.join(' ')}`
            : session.cmd}
          {' · '}
          {session.status === 'exited'
            ? `exit ${session.exitCode ?? '?'}` + (exitedAgo ? ` · ${exitedAgo}` : '')
            : `pid ${session.pid ?? '?'}`}
        </div>
      </div>
      <div className="card-actions session-actions" onClick={(e) => e.stopPropagation()}>
        {session.status !== 'exited' && onKill && (
          <button
            type="button"
            className="session-action-btn action-kill"
            onClick={onKill}
            aria-label="Kill session"
          >
            <span className="session-action-icon" aria-hidden>⏹</span>
            <span>Kill</span>
          </button>
        )}
        {session.status === 'exited' && onDelete && (
          <button
            type="button"
            className="session-action-btn action-delete"
            onClick={onDelete}
            aria-label="Delete session log"
          >
            <span className="session-action-icon" aria-hidden>🗑</span>
            <span>Delete</span>
          </button>
        )}
      </div>
    </div>
  );
}
