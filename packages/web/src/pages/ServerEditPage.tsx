/**
 * Add/Edit Agent page.
 *
 * Fields:
 *   name      — human-friendly label for the agent.
 *   baseUrl   — the AGENT's HTTP root, e.g. http://192.168.1.5:8444
 *   agentToken — the bearer token configured on the agent daemon.
 *
 * On submit we call `auth.addAgent(...)`, which goes through the Manager.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../store/AuthContext';

interface Props {
  mode: 'create' | 'edit';
}

export function ServerEditPage({ mode }: Props) {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { addAgent, agents, managerBaseUrl } = useAuth();

  const existing = id ? agents.find((a) => a.id === id) : undefined;

  const [name, setName] = useState(existing?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    const url = baseUrl.trim();
    const tk = token.trim();
    const nm = name.trim();
    if (!url) {
      setError('Agent URL is required');
      return;
    }
    if (mode === 'create' && !tk) {
      setError('Agent token is required');
      return;
    }
    const normalizedUrl = url.replace(/\/+$/, '');
    const finalName = nm || normalizedUrl;
    setLoading(true);
    try {
      if (mode === 'create') {
        await addAgent(finalName, normalizedUrl, tk);
      } else if (id) {
        // Manager transport used here doesn't expose update; surface the
        // limitation clearly to the user rather than silently mis-saving.
        setError(
          'Editing agents is not supported in this build — remove and re-add.',
        );
        setLoading(false);
        return;
      }
      navigate('/servers');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 540 }}>
        <div className="page-header">
          <div className="page-title">{mode === 'create' ? 'Add Agent' : 'Edit Agent'}</div>
          {managerBaseUrl && (
            <div className="page-subtitle">via Manager {managerBaseUrl}</div>
          )}
        </div>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
          </div>
        )}

        <form className="modal" onSubmit={handleSubmit}>
          <div className="field">
            <label className="field-label">Name (optional)</label>
            <input
              placeholder="e.g. Home Desktop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label">Agent URL *</label>
            <input
              placeholder="http://192.168.1.5:8444"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <div className="empty-hint" style={{ marginTop: 6 }}>
              The direct URL of the agent (must be reachable by the Manager).
            </div>
          </div>

          <div className="field">
            <label className="field-label">
              Agent Token {mode === 'create' ? '*' : '(leave blank to keep current)'}
            </label>
            <input
              type="password"
              placeholder="paste the agent's bearer token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={() => navigate('/servers')}>
              Cancel
            </button>
            <button type="submit" disabled={loading}>
              {loading ? 'Saving…' : mode === 'create' ? 'Add Agent' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
