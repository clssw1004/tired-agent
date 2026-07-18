import { useNavigate } from 'react-router-dom';
import { useServerList } from '../store/ServerContext';
import { ServerCard } from '../components/ServerCard';

export function ServerListPage() {
  const navigate = useNavigate();
  const { servers, removeServer } = useServerList();

  const handleRemove = (id: string, name: string) => {
    if (confirm(`Remove "${name}" from the list?\n\nThis won't stop the daemon.`)) {
      removeServer(id);
    }
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-title">Agents</div>
            <div className="page-subtitle">
              {servers.length === 0
                ? 'Add an agent to get started'
                : `${servers.length} agent${servers.length > 1 ? 's' : ''}`}
            </div>
          </div>
          <div className="toolbar">
            <button onClick={() => navigate('/servers/new')}>+ Add Agent</button>
          </div>
        </div>

        {servers.length === 0 && (
          <div className="empty">
            <div className="empty-icon">🖥️</div>
            <div className="empty-text">No agents yet</div>
            <div className="empty-hint">
              Add your first tired-pc agent to start controlling sessions from the browser.
            </div>
          </div>
        )}

        {servers.map((s) => (
          <ServerCard
            key={s.id}
            server={s}
            onClick={() => navigate(`/servers/${s.id}`)}
            onEdit={() => navigate(`/servers/${s.id}/edit`)}
            onRemove={() => handleRemove(s.id, s.name)}
          />
        ))}
      </div>
    </div>
  );
}
