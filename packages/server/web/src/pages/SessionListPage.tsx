import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Session } from '@tired-pc/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { SessionCard } from '../components/SessionCard';

export function SessionListPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!server) return;
    try {
      const list = await transport.listSessions({
        id: server.id,
        name: server.name,
        baseUrl: server.baseUrl,
        token: server.token,
      });
      setSessions(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [server]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // auto-refresh every 5s
    return () => clearInterval(t);
  }, [load]);

  const handleKill = async (sessionId: string) => {
    if (!server) return;
    if (!confirm('Kill this session? The process will be terminated.')) return;
    try {
      await transport.killSession(
        { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
        sessionId,
      );
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  if (!server) {
    return (
      <div className="page">
        <div className="page-inner">
          <div className="empty">
            <div className="empty-text">Server not found</div>
            <button onClick={() => navigate('/servers')}>Back to Servers</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-title">{server.name || server.baseUrl}</div>
            <div className="page-subtitle">{server.baseUrl}</div>
          </div>
          <div className="toolbar">
            <button onClick={() => navigate('/servers')}>← Servers</button>
            <button onClick={() => navigate(`/servers/${server.id}/sessions/new`)}>
              + New Session
            </button>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {sessions.length === 0 && !error && (
          <div className="empty">
            <div className="empty-icon">⌨️</div>
            <div className="empty-text">No sessions</div>
            <div className="empty-hint">
              Create a session to start a command on this server.
            </div>
          </div>
        )}

        {sessions.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            onClick={() => navigate(`/servers/${server.id}/sessions/${s.id}`)}
            onKill={s.status !== 'exited' ? () => handleKill(s.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
