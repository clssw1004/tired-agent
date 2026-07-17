import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useServerList } from '../store/ServerContext';
import type { ServerRef } from '@tired-pc/protocol';

interface Props {
  mode: 'create' | 'edit';
}

export function ServerEditPage({ mode }: Props) {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { addServer, updateServer, getServer } = useServerList();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'edit' && id) {
      const s = getServer(id);
      if (s) {
        setName(s.name);
        setBaseUrl(s.baseUrl);
        setToken(s.token);
      }
    }
  }, [mode, id, getServer]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    const url = (baseUrl ?? '').trim();
    const tk = (token ?? '').trim();
    const nm = (name ?? '').trim();
    if (!url) {
      setError('Base URL is required');
      return;
    }
    if (!tk) {
      setError('Token is required');
      return;
    }
    const normalizedUrl = url.replace(/\/+$/, '');
    const finalName = nm || normalizedUrl;
    if (mode === 'create') {
      const newId = addServer({
        name: finalName,
        baseUrl: normalizedUrl,
        token: tk,
      });
      // Persist immediately so the list page (remounted) sees the new entry
      const existing = JSON.parse(localStorage.getItem('tired-pc:servers') ?? '[]') as ServerRef[];
      const next = [...existing.filter((s) => s.id !== newId), { id: newId, name: finalName, baseUrl: normalizedUrl, token: tk }];
      localStorage.setItem('tired-pc:servers', JSON.stringify(next));
    } else if (id) {
      updateServer(id, {
        name: finalName,
        baseUrl: normalizedUrl,
        token: tk,
      });
      const existing = JSON.parse(localStorage.getItem('tired-pc:servers') ?? '[]') as ServerRef[];
      const next = existing.map((s) =>
        s.id === id ? { ...s, name: finalName, baseUrl: normalizedUrl, token: tk } : s,
      );
      localStorage.setItem('tired-pc:servers', JSON.stringify(next));
    }
    navigate('/servers');
  };

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 540 }}>
        <div className="page-header">
          <div className="page-title">{mode === 'create' ? 'Add Server' : 'Edit Server'}</div>
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
            <label className="field-label">Server URL *</label>
            <input
              placeholder="http://192.168.1.100:8443"
              value={baseUrl}
              onFocus={() => {
                if (!baseUrl) setBaseUrl(window.location.origin);
              }}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label className="field-label">Bearer Token *</label>
            <input
              type="password"
              placeholder="paste your token here"
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
            <button type="submit">
              {mode === 'create' ? 'Add' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
