import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ServerRef, Session } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { ChatContainer } from '../components/ChatContainer';
import { ClaudeChatView } from '../components/ClaudeChatView';

export function TerminalPage() {
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;
  // The active agent is what we're proxying to through the Manager.
  const agentId = server?.agentId;

  // Memoize the ServerRef — see SessionListPage for the rationale.
  const serverRef = useMemo<ServerRef | null>(
    () => (server
      ? { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token }
      : null),
    [server],
  );

  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverRef || !sid || !agentId) return;
    transport
      .getSession(serverRef, sid, agentId)
      .then(setSession)
      .catch((e) => setError((e as Error).message));
  }, [serverRef, sid, agentId]);

  if (!server) {
    return (
      <div className="page">
        <div className="empty">Agent not found</div>
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

  const sharedProps = {
    serverRef: serverRef ?? { id: '', name: '', baseUrl: '', token: '' },
    agentId: agentId ?? '',
    sessionId: sid!,
    onBack: () => server && navigate(`/servers/${server.id}`),
  };

  // Persistent (chat) mode uses a completely independent component.
  if (session?.mode === 'persistent') {
    return (
      <ClaudeChatView
        {...sharedProps}
        sessionLabel={session?.label || 'Claude'}
      />
    );
  }

  return (
    <ChatContainer
      {...sharedProps}
      sessionStatus={session?.status ?? 'starting'}
      sessionLabel={session?.label || session?.cmd || '…'}
      sessionCmd={session?.cmd ?? ''}
      sessionArgs={session?.args ?? []}
      sessionMode={session?.mode}
    />
  );
}
