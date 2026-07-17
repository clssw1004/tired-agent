import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useServerList } from '../store/ServerContext';

/**
 * Login page — picks or selects a server. The "active" server's token
 * is sent on every API call, so this is also where the bearer token
 * gets implicitly activated.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const { servers, activeId, setActiveId } = useServerList();

  // Auto-select first server if none is active
  useEffect(() => {
    if (!activeId && servers.length > 0) {
      setActiveId(servers[0]!.id);
    }
  }, [servers, activeId, setActiveId]);

  const handleSelect = (id: string) => {
    setActiveId(id);
    navigate('/servers');
  };

  const handleGoToServers = () => navigate('/servers');

  return (
    <div className="login">
      <div className="login-card">
        <h1>tired-pc</h1>
        <p className="tagline">
          Connect to a server daemon to start remote-controlling your sessions.
        </p>

        {servers.length === 0 ? (
          <>
            <div className="empty">
              <div className="empty-icon">🖥️</div>
              <div className="empty-text">No servers yet</div>
              <div className="empty-hint">
                Add your first server to get started.
              </div>
            </div>
            <button style={{ width: '100%' }} onClick={handleGoToServers}>
              Add Server
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label className="field-label">Choose a server</label>
              <select
                value={activeId ?? ''}
                onChange={(e) => setActiveId(e.target.value)}
              >
                <option value="" disabled>Select…</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.baseUrl}
                  </option>
                ))}
              </select>
            </div>
            {activeId && (
              <button
                style={{ width: '100%' }}
                onClick={() => handleSelect(activeId)}
              >
                Continue
              </button>
            )}
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button className="btn-ghost" onClick={handleGoToServers}>
                Manage servers
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
