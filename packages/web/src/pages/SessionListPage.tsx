import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Session, SessionStatus, ServerRef } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { SessionCard } from '../components/SessionCard';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';

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
  // Modal-driven confirmation (replaces native confirm()/alert()).
  const [pending, setPending] = useState<
    | { kind: 'kill'; sessionId: string }
    | { kind: 'delete'; sessionId: string }
    | { kind: 'prune' }
    | null
  >(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const toast = useToast();

  // IMPORTANT: memoize the ServerRef. Inline object literals get a fresh
  // identity on every render, which would invalidate useCallback deps below
  // and cause the auto-refresh useEffect to tear down + rebuild the
  // setInterval on every parent re-render — visible as dozens of
  // listSessions requests per second ("疯狂请求").
  const serverRef = useMemo<ServerRef | null>(
    () => (server
      ? { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token }
      : null),
    [server],
  );

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
    setPending({ kind: 'kill', sessionId });
  };

  const handleDelete = async (sessionId: string) => {
    // Same guard as handleKill — must have BOTH serverRef AND agentId before
    // hitting the manager proxy. Without agentId the SPA would call
    // /v1/sessions/:id directly, which has no manager route and returns 404
    // (or worse, leaks the manager URL into an unrelated handler).
    if (!serverRef || !agentId) return;
    setPending({ kind: 'delete', sessionId });
  };

  const handlePrune = async () => {
    if (!serverRef || !agentId) return;
    setPending({ kind: 'prune' });
  };

  const confirmPending = async () => {
    if (!pending || !serverRef || !agentId) {
      setPending(null);
      return;
    }
    setBusyAction(true);
    setModalError(null);
    try {
      if (pending.kind === 'kill') {
        await transport.killSession(serverRef, pending.sessionId, agentId);
        toast.success(`Killed session ${pending.sessionId.slice(0, 8)}`);
      } else if (pending.kind === 'delete') {
        await transport.deleteSession(serverRef, pending.sessionId, agentId);
        toast.success('Session log deleted');
      } else if (pending.kind === 'prune') {
        const r = await transport.pruneSessions(serverRef, 24, agentId);
        setPruneInfo(r.removed);
        toast.success(`Cleaned ${r.removed} stale session${r.removed === 1 ? '' : 's'}`);
      }
      setPending(null);
      await load();
    } catch (e) {
      const msg = (e as Error).message;
      setModalError(msg);
      toast.error(msg);
    } finally {
      setBusyAction(false);
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

      <Modal
        open={pending !== null}
        intent={pending?.kind === 'prune' ? 'danger' : 'danger'}
        icon={pending?.kind === 'kill' ? '⚠️' : pending?.kind === 'delete' ? '🗑️' : '🧹'}
        title={
          pending?.kind === 'kill'
            ? 'Kill this session?'
            : pending?.kind === 'delete'
              ? 'Delete session log?'
              : 'Clean stale sessions?'
        }
        description={
          pending?.kind === 'kill'
            ? 'The running process will be terminated and removed from the list.'
            : pending?.kind === 'delete'
              ? 'Removes the database row and the on-disk output log. Cannot be undone.'
              : 'Drops all sessions that have been inactive for more than 24 hours.'
        }
        confirmLabel={busyAction ? 'Working…' : 'Confirm'}
        cancelLabel="Cancel"
        onConfirm={confirmPending}
        onCancel={() => { if (!busyAction) { setPending(null); setModalError(null); } }}
      />
      {modalError && pending && (
        <div className="error-banner" style={{ marginTop: 12 }}>
          <span>{modalError}</span>
          <button onClick={() => setModalError(null)}>✕</button>
        </div>
      )}
    </div>
  );
}
