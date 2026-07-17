import type { Session, SessionStatus } from '@tired-pc/protocol';

interface Props {
  session: Session;
  onClick: () => void;
  onKill?: () => void;
  onDelete?: () => void;
}

const STATUS_LABEL: Record<SessionStatus, { className: string }> = {
  starting: { className: 'dot dot-starting' },
  running: { className: 'dot dot-running' },
  exited: { className: 'dot dot-exited' },
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
  const status = STATUS_LABEL[session.status];
  const exitedAgo =
    session.status === 'exited' && session.exitedAt ? timeSince(session.exitedAt) : null;

  return (
    <div className="card card-clickable" onClick={onClick}>
      <div className="card-info">
        <div className="card-name">
          <span className={status.className} />
          {session.label || session.cmd}
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
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        {session.status !== 'exited' && onKill && (
          <button className="btn-danger" onClick={onKill}>Kill</button>
        )}
        {session.status === 'exited' && onDelete && (
          <button className="btn-cancel" onClick={onDelete} aria-label="Delete">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
