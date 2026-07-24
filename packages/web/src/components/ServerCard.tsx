import type { AgentServerRef } from '../store/ServerContext';

interface Props {
  server: AgentServerRef;
  onClick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

function getStateLabel(state?: string, lastSeen?: number | null): string {
  if (state === 'online') return '在线';
  if (state === 'offline' && lastSeen) {
    const seconds = Math.floor((Date.now() - lastSeen) / 1000);
    if (seconds < 120) return `${seconds} 秒前离线`;
    return `离线 ${Math.floor(seconds / 60)} 分钟`;
  }
  return '未知';
}

export function ServerCard({ server, onClick, onEdit, onRemove }: Props) {
  const state = server.state ?? 'unknown';
  return (
    <div className="card card-clickable" onClick={onClick}>
      <div className="card-info">
        <div className="card-name">{server.name || server.agentBaseUrl}</div>
        <div className="card-meta">{server.agentBaseUrl}</div>
        <div className="server-card-status">
          <span className={`server-state-dot server-state-${state}`} />
          <span className="server-state-label">
            {getStateLabel(server.state, server.lastSeen)}
          </span>
          {server.version && <span className="server-version">v{server.version}</span>}
        </div>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-ghost" onClick={onEdit}>Edit</button>
        <button className="btn-danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}
