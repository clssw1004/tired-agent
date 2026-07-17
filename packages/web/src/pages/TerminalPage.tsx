import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Session } from '@tired-pc/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { ChatContainer } from '../components/ChatContainer';

export function TerminalPage() {
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;
  // The active agent is what we're proxying to through the Manager.
  const agentId = server?.agentId;

  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!server || !sid || !agentId) return;
    transport
      .getSession(
        { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
        sid,
        agentId,
      )
      .then(setSession)
      .catch((e) => setError((e as Error).message));
  }, [server, sid, agentId]);

  if (!server) {
    return (
      <div className="page">
        <div className="empty">Server not found</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
        <button className="btn-cancel" onClick={() => navigate(`/servers/${server.id}`)}>‹ Back</button>
      </div>
    );
  }

  return (
    <ChatContainer
      serverRef={{
        id: server.id,
        name: server.name,
        baseUrl: server.baseUrl,
        token: server.token,
      }}
      agentId={agentId ?? ''}
      sessionId={sid!}
      sessionStatus={session?.status ?? 'starting'}
      sessionLabel={session?.label || session?.cmd || '…'}
      sessionCmd={session?.cmd ?? ''}
      sessionArgs={session?.args ?? []}
      onBack={() => navigate(`/servers/${server.id}`)}
    />
  );
}
