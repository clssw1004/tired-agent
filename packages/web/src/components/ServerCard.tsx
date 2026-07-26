import type { AgentServerRef } from '../store/ServerContext';

interface Props {
  server: AgentServerRef;
  onClick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function getStateLabel(status?: string): string {
  if (status === 'online') return '在线';
  if (status === 'offline') return '离线';
  if (status === 'pending') return '待注册';
  return '未知';
}

export function ServerCard({ server, onClick, onEdit, onRemove }: Props) {
  const state = server.status ?? 'pending';
  return (
    <div className="card card-clickable" onClick={onClick}>
      <div className="card-info">
        <div className="card-name">{server.name || server.agentBaseUrl}</div>
        <div className="card-meta">{server.agentBaseUrl}</div>
        <div className="server-card-status">
          <span className={`server-state-dot server-state-${state}`} />
          <span className="server-state-label">
            {getStateLabel(server.status)}
          </span>
        </div>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-ghost" onClick={onEdit}>Edit</button>
        <button className="btn-danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}
