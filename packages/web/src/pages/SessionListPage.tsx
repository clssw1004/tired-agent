import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Session, SessionStatus } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { SessionCard } from '../components/SessionCard';

type StatusFilter = 'all' | SessionStatus;

export function SessionListPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;
  // Each ServerRef now represents an Agent; route every call through the
  // Manager proxy using the agent's id.
  const agentId = server?.agentId;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [pruneInfo, setPruneInfo] = useState<number | null>(null);

  const serverRef = server
    ? { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token }
    : null;

  const load = useCallback(async () => {
    if (!serverRef || !agentId) return;
    try {
      const list = await transport.listSessions(serverRef, agentId);
      setSessions(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [serverRef, agentId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // auto-refresh every 5s
    return () => clearInterval(t);
  }, [load]);

  const handleKill = async (sessionId: string) => {
    if (!serverRef || !agentId) return;
    if (!confirm('Kill this session? The process will be terminated.')) return;
    try {
      await transport.killSession(serverRef, sessionId, agentId);
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!serverRef) return;
    if (!confirm('Delete this (already exited) session? Log file is removed too.')) return;
    try {
      await transport.deleteSession(serverRef, sessionId);
      await load();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const handlePrune = async () => {
    if (!serverRef) return;
    if (!confirm('Drop all sessions whose last activity is older than 24 hours?')) return;
    setLoading(true);
    try {
      const r = await transport.pruneSessions(serverRef, 24);
      setPruneInfo(r.removed);
      await load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!server) {
    return (
      <div className="page">
        <div className="page-inner">
          <div className="empty">
            <div className="empty-text">Agent not found</div>
            <button onClick={() => navigate('/servers')}>Back to Agents</button>
          </div>
        </div>
      </div>
    );
  }

  const visible = statusFilter === 'all'
    ? sessions
    : sessions.filter((s) => s.status === statusFilter);
  const counts = {
    all: sessions.length,
    starting: sessions.filter((s) => s.status === 'starting').length,
    running: sessions.filter((s) => s.status === 'running').length,
    exited: sessions.filter((s) => s.status === 'exited').length,
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div>
            <div className="page-title">{server.name || 'Agent'}</div>
            <div className="page-subtitle">{server.agentBaseUrl}</div>
          </div>
          <div className="toolbar">
            <button onClick={() => navigate('/servers')}>← Agents</button>
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

        {pruneInfo !== null && (
          <div className="error-banner" style={{ background: '#1a2a1a', borderColor: '#214021', color: '#7be07b' }}>
            <span>Cleaned up {pruneInfo} stale session{pruneInfo === 1 ? '' : 's'}.</span>
            <button onClick={() => setPruneInfo(null)}>✕</button>
          </div>
        )}

        <div className="toolbar" style={{ marginBottom: 16, gap: 6 }}>
          {(['all', 'starting', 'running', 'exited'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              className={statusFilter === s ? '' : 'btn-ghost'}
              onClick={() => setStatusFilter(s)}
            >
              {s} {counts[s] > 0 && <span style={{ opacity: 0.6 }}>({counts[s]})</span>}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          <button
            className="btn-cancel"
            onClick={handlePrune}
            disabled={loading || counts.exited === 0}
            title="Drop exited sessions older than 24 hours"
          >
            {loading ? 'Cleaning…' : `Clean zombies (${counts.exited})`}
          </button>
        </div>

        {visible.length === 0 && !error && (
          <div className="empty">
            <div className="empty-icon">⌨️</div>
            <div className="empty-text">
              {sessions.length === 0 ? 'No sessions' : 'No matching sessions'}
            </div>
            <div className="empty-hint">
              {sessions.length === 0
                ? 'Create a session to start a command on this agent.'
                : 'Try a different status filter.'}
            </div>
          </div>
        )}

        {visible.map((s) => (
          <SessionCard
            key={s.id}
            session={s}
            onClick={() => navigate(`/servers/${server.id}/sessions/${s.id}`)}
            onKill={s.status !== 'exited' ? () => handleKill(s.id) : undefined}
            onDelete={s.status === 'exited' ? () => handleDelete(s.id) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
