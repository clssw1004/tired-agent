import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { Session } from '@tired-pc/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { TerminalView } from '../components/TerminalView';
import { InputBar } from '../components/InputBar';

export function TerminalPage() {
  const { id, sid } = useParams<{ id: string; sid: string }>();
  const navigate = useNavigate();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;

  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!server || !sid) return;
    transport
      .getSession(
        { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
        sid,
      )
      .then(setSession)
      .catch((e) => setError((e as Error).message));
  }, [server, sid]);

  const handleStateChange = useCallback((s: Session) => {
    setSession(s);
  }, []);

  const handleTransportError = useCallback((err: Error) => {
    setError(err.message);
  }, []);

  const handleSend = useCallback(
    async (data: Uint8Array) => {
      if (!server || !sid) return;
      try {
        await transport.sendInput(
          { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
          sid,
          data,
        );
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [server, sid],
  );

  if (!server) {
    return (
      <div className="page">
        <div className="empty">Server not found</div>
      </div>
    );
  }

  return (
    <div className="terminal-view">
      <div className="terminal-header">
        <button className="back-btn" onClick={() => navigate(`/servers/${server.id}`)}>
          ‹ Back
        </button>
        <div className="session-info">
          <span className={`dot dot-${session?.status ?? 'starting'}`} />
          <span className="session-label">
            {session?.label || session?.cmd || '…'}
          </span>
        </div>
        <div className="terminal-host">{server.baseUrl}</div>
      </div>

      {error && (
        <div className="error-banner" style={{ margin: '8px 16px 0', borderRadius: 8 }}>
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="terminal-body">
        {sid && (
          <TerminalView
            server={{ id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token }}
            sessionId={sid}
            onStateChange={handleStateChange}
            onTransportError={handleTransportError}
          />
        )}
      </div>

      <InputBar
        disabled={session?.status === 'exited'}
        onSend={handleSend}
      />
    </div>
  );
}
