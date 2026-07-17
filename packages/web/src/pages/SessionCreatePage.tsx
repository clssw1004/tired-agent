import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';

export function SessionCreatePage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;

  const isWindows = navigator.platform.toLowerCase().includes('win');
  const [cmd, setCmd] = useState(isWindows ? 'cmd.exe' : 'bash');
  const [args, setArgs] = useState('');
  const [label, setLabel] = useState('');
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!server) {
      setError('Server not found');
      return;
    }
    setError(null);
    if (!cmd.trim()) {
      setError('Command is required');
      return;
    }
    setLoading(true);
    try {
      const argList = args.trim() ? args.trim().split(/\s+/) : [];
      const session = await transport.createSession(
        { id: server.id, name: server.name, baseUrl: server.baseUrl, token: server.token },
        {
          cmd: cmd.trim(),
          args: argList,
          label: label.trim() || undefined,
          cols,
          rows,
        },
      );
      navigate(`/servers/${server.id}/sessions/${session.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!server) {
    return (
      <div className="page">
        <div className="empty">Server not found</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 540 }}>
        <div className="page-header">
          <div className="page-title">New Session</div>
          <div className="page-subtitle">{server.baseUrl}</div>
        </div>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
          </div>
        )}

        <div className="modal">
          <div className="field">
            <label className="field-label">Command *</label>
            <input
              placeholder="claude"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label className="field-label">Arguments (space-separated)</label>
            <input
              placeholder="--no-input"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label className="field-label">Label (optional)</label>
            <input
              placeholder="e.g. My Project"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Cols</label>
              <input
                type="number"
                min={1}
                max={500}
                value={cols}
                onChange={(e) => setCols(Number(e.target.value))}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Rows</label>
              <input
                type="number"
                min={1}
                max={200}
                value={rows}
                onChange={(e) => setRows(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="modal-actions">
            <button className="btn-cancel" onClick={() => navigate(`/servers/${server.id}`)}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={loading}>
              {loading ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
