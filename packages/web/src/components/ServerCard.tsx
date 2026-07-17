import type { AgentServerRef } from '../store/ServerContext';

interface Props {
  server: AgentServerRef;
  onClick: () => void;
  onEdit: () => void;
  onRemove: () => void;
}

export function ServerCard({ server, onClick, onEdit, onRemove }: Props) {
  return (
    <div className="card card-clickable" onClick={onClick}>
      <div className="card-info">
        <div className="card-name">{server.name || server.agentBaseUrl}</div>
        <div className="card-meta">{server.agentBaseUrl}</div>
      </div>
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn-ghost" onClick={onEdit}>Edit</button>
        <button className="btn-danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}
