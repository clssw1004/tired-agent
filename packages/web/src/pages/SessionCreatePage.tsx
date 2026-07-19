import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ServerRef } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { useToast } from '../components/Toast';

interface Preset {
  label: string;
  cmd: string;
  args: string;
  hint: string;
  emoji: string;
}

// Common interactive shells / REPLs the user might want to start. Tapping a
// preset populates the form so they don't have to remember the command.
const PRESETS: Preset[] = [
  { label: 'Claude',  cmd: 'claude', args: '',                    hint: 'Anthropic Claude Code CLI',  emoji: '✦' },
  { label: 'Bash',    cmd: 'bash',   args: '',                    hint: 'POSIX shell',                emoji: '$' },
  { label: 'Zsh',     cmd: 'zsh',    args: '',                    hint: 'Z shell',                    emoji: '$' },
  { label: 'cmd.exe', cmd: 'cmd.exe', args: '',                    hint: 'Windows command prompt',    emoji: '>' },
  { label: 'PowerShell', cmd: 'powershell.exe', args: '',          hint: 'Windows PowerShell',         emoji: '>' },
  { label: 'Python',  cmd: 'python3', args: '-i',                  hint: 'Interactive Python REPL',    emoji: '🐍' },
  { label: 'Node',    cmd: 'node',   args: '',                    hint: 'Node.js REPL',                emoji: '⬢' },
];

export function SessionCreatePage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { servers } = useServerList();
  const server = id ? servers.find((s) => s.id === id) : undefined;
  const toast = useToast();

  const isWindows = navigator.platform.toLowerCase().includes('win');
  const defaultCmd = isWindows ? 'cmd.exe' : 'bash';
  const [cmd, setCmd] = useState(defaultCmd);
  const [args, setArgs] = useState('');
  const [label, setLabel] = useState('');
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commandPreview = useMemo(() => {
    const c = cmd.trim();
    const a = args.trim();
    if (!c) return '';
    return a ? `${c} ${a}` : c;
  }, [cmd, args]);

  const applyPreset = (p: Preset) => {
    setCmd(p.cmd);
    setArgs(p.args);
    setLabel('');
  };

  const handleCreate = async () => {
    if (!server || !server.agentId) {
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
      const serverRef: ServerRef = {
        id: server.id,
        name: server.name,
        baseUrl: server.baseUrl,
        token: server.token,
      };
      const session = await transport.createSession(
        serverRef,
        {
          cmd: cmd.trim(),
          args: argList,
          label: label.trim() || undefined,
          cols,
          rows,
        },
        server.agentId,
      );
      toast.success(`Created ${session.label || session.cmd}`);
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
        <div className="empty">Agent not found</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 560 }}>
        <div className="page-header">
          <div>
            <div className="page-title">New Session</div>
            <div className="page-subtitle">{server.agentBaseUrl}</div>
          </div>
          <div className="toolbar">
            <button className="btn-ghost" onClick={() => navigate(`/servers/${server.id}`)}>
              ← Back
            </button>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        <div className="form-card">
          <div className="form-section">
            <div className="form-section-label">Quick start</div>
            <div className="preset-grid">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={
                    'preset-tile' +
                    (cmd === p.cmd && args === p.args ? ' is-active' : '')
                  }
                  onClick={() => applyPreset(p)}
                  title={p.hint}
                >
                  <span className="preset-emoji" aria-hidden>{p.emoji}</span>
                  <span className="preset-label">{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-label">Command</div>
            <div className="field">
              <input
                placeholder="claude"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                autoFocus
                spellCheck={false}
                className="form-input-mono"
              />
            </div>
            <div className="field">
              <label className="field-label">Arguments (space-separated)</label>
              <input
                placeholder="--no-input"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
                className="form-input-mono"
              />
            </div>
            {commandPreview && (
              <div className="command-preview">
                <span className="command-preview-label">preview</span>
                <code>{commandPreview}</code>
              </div>
            )}
          </div>

          <div className="form-section">
            <div className="form-section-label">Options</div>
            <div className="field">
              <label className="field-label">Label (optional)</label>
              <input
                placeholder="e.g. My Project"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="form-row">
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
          </div>

          <div className="form-actions">
            <button className="btn-cancel" onClick={() => navigate(`/servers/${server.id}`)}>
              Cancel
            </button>
            <button onClick={handleCreate} disabled={loading || !cmd.trim()}>
              {loading ? 'Creating…' : 'Create session'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}