import type { Session, SessionStatus } from '@tired-pc/protocol';

interface Props {
  session: Session;
  onClick: () => void;
  onKill?: () => void;
}

const STATUS_LABEL: Record<SessionStatus, { className: string }> = {
  starting: { className: 'dot dot-starting' },
  running: { className: 'dot dot-running' },
  exited: { className: 'dot dot-exited' },
};

export function SessionCard({ session, onClick, onKill }: Props) {
  const status = STATUS_LABEL[session.status];
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
            ? `exit ${session.exitCode ?? '?'}`
            : `pid ${session.pid ?? '?'}`}
        </div>
      </div>
      {session.status !== 'exited' && onKill && (
        <div className="card-actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn-danger" onClick={onKill}>Kill</button>
        </div>
      )}
    </div>
  );
}
