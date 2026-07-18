import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerList } from '../store/ServerContext';
import { ServerCard } from '../components/ServerCard';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';

export function ServerListPage() {
  const navigate = useNavigate();
  const { servers, removeServer } = useServerList();
  const [pendingRemove, setPendingRemove] = useState<{ id: string; name: string } | null>(null);
  const toast = useToast();

  const confirmRemove = () => {
    if (!pendingRemove) return;
    removeServer(pendingRemove.id);
    toast.success(`Removed "${pendingRemove.name}"`);
    setPendingRemove(null);
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
            <button onClick={() => navigate('/onboarding')}>+ Onboard</button>
            <button onClick={() => navigate('/servers/new')} className="btn-cancel">+ Manual</button>
          </div>
        </div>

        {servers.length === 0 && (
          <div className="empty empty-large">
            <div className="empty-illustration" aria-hidden>
              <span className="empty-glyph">⌨️</span>
            </div>
            <div className="empty-text">No agents yet</div>
            <div className="empty-hint">
              tired-agent lets you control PTY sessions from your phone.
              <br />Spin one up on a machine you own, then come back here to connect.
            </div>
            <div className="empty-actions">
              <button onClick={() => navigate('/onboarding')}>Onboard an agent</button>
              <button onClick={() => navigate('/servers/new')} className="btn-cancel">Add manually</button>
            </div>
          </div>
        )}

        {servers.map((s) => (
          <ServerCard
            key={s.id}
            server={s}
            onClick={() => navigate(`/servers/${s.id}`)}
            onEdit={() => navigate(`/servers/${s.id}/edit`)}
            onRemove={() => setPendingRemove({ id: s.id, name: s.name })}
          />
        ))}

        <Modal
          open={pendingRemove !== null}
          intent="danger"
          icon="🗑"
          title={`Remove "${pendingRemove?.name ?? ''}"?`}
          description="Unregisters the agent from this portal. The agent daemon keeps running on its host machine — you can re-register anytime."
          confirmLabel="Remove"
          onConfirm={confirmRemove}
          onCancel={() => setPendingRemove(null)}
        />
      </div>
    </div>
  );
}
