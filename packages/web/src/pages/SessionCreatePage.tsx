import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ServerRef, SessionMode } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { useToast } from '../components/Toast';
import { DirectoryPickerModal } from '../components/DirectoryPickerModal';

interface ArgumentOption {
  id: string;
  label: string;
  args: string[];
  hint: string;
}

interface Preset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  hint: string;
  emoji: string;
  options?: ArgumentOption[];
}

// Common interactive shells / REPLs the user might want to start. Tapping a
// preset populates the form so they don't have to remember the command.
// Each preset may expose common argument shortcuts as toggleable chips.
const PRESETS: Preset[] = [
  { id: 'claude', label: 'Claude', cmd: 'claude', args: [], hint: 'Anthropic Claude Code CLI', emoji: '✦' },
  { id: 'bash', label: 'Bash', cmd: 'bash', args: [], hint: 'POSIX shell', emoji: '$', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
    { id: 'login', label: 'Login', args: ['-l'], hint: 'Start as a login shell' },
  ] },
  { id: 'zsh', label: 'Zsh', cmd: 'zsh', args: [], hint: 'Z shell', emoji: '$', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
    { id: 'login', label: 'Login', args: ['-l'], hint: 'Start as a login shell' },
  ] },
  { id: 'cmd', label: 'cmd.exe', cmd: 'cmd.exe', args: [], hint: 'Windows command prompt', emoji: '>', options: [
    { id: 'no-auto-run', label: 'No AutoRun', args: ['/d'], hint: 'Disable AutoRun commands' },
  ] },
  { id: 'powershell', label: 'PowerShell', cmd: 'powershell.exe', args: [], hint: 'Windows PowerShell', emoji: '>', options: [
    { id: 'no-logo', label: 'No logo', args: ['-NoLogo'], hint: 'Hide startup logo' },
    { id: 'no-profile', label: 'No profile', args: ['-NoProfile'], hint: 'Skip profile scripts' },
  ] },
  { id: 'python', label: 'Python', cmd: 'python3', args: ['-i'], hint: 'Interactive Python REPL', emoji: '🐍', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
  ] },
  { id: 'node', label: 'Node', cmd: 'node', args: [], hint: 'Node.js REPL', emoji: '⬢', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
  ] },
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
  const [cwd, setCwd] = useState('');
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [activeOptionIds, setActiveOptionIds] = useState<string[]>([]);
  const [cols, setCols] = useState(80);
  const [rows, setRows] = useState(24);
  const [mode, setMode] = useState<SessionMode>('process');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single source of truth for arguments:
  //   - `args` state holds ONLY the user's manually typed extra arguments.
  //   - preset default args + active option chips flow through `effectiveArgs`.
  // This keeps preset/chip args from ever being duplicated into the manual box.
  const selectedPreset = PRESETS.find((preset) => preset.cmd === cmd);
  const selectedOptionArgs = (selectedPreset?.options ?? [])
    .filter((option) => activeOptionIds.includes(option.id))
    .flatMap((option) => option.args);
  const effectiveArgs = [...(selectedPreset?.args ?? []), ...selectedOptionArgs];

  const commandPreview = useMemo(() => {
    const c = cmd.trim();
    if (!c) return '';
    const manualArgs = args.trim() ? args.trim().split(/\s+/) : [];
    const tokens = [c, ...effectiveArgs, ...manualArgs];
    return tokens.join(' ');
  }, [cmd, args, effectiveArgs]);

  const applyPreset = (p: Preset) => {
    setCmd(p.cmd);
    // Preset defaults live in `effectiveArgs`, never in the manual box.
    // Reset manual args + chips so we don't re-send stale defaults.
    setArgs('');
    setActiveOptionIds([]);
    setLabel('');
    // Claude preset auto-selects structured mode; other presets use PTY.
    setMode(p.cmd === 'claude' ? 'persistent' : 'process');
  };

  // When command changes away from claude, persistent mode is unavailable.
  // Auto-switch to process mode so the user doesn't accidentally create a
  // persistent session with a non-claude command (which would fail).
  useEffect(() => {
    if (cmd !== 'claude') {
      setMode('process');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmd]);

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
      // Assemble in a stable order: preset defaults → chip args → manual args.
      // `effectiveArgs` never overlaps the manual box, so no duplicates.
      const manualArgs = args.trim() ? args.trim().split(/\s+/) : [];
      const finalArgs = [...effectiveArgs, ...manualArgs];
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
          args: finalArgs,
          cwd: cwd.trim() || undefined,
          label: label.trim() || undefined,
          cols,
          rows,
          mode,
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
                  key={p.id}
                  type="button"
                  className={
                    'preset-tile' +
                    (cmd === p.cmd ? ' is-active' : '')
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
            <div className="form-section-label">生命周期</div>
            <div className="mode-toggle">
              <button
                type="button"
                className={'mode-toggle-btn' + (mode === 'process' ? ' is-active' : '')}
                onClick={() => setMode('process')}
              >
                <span className="mode-toggle-icon">⬛</span>
                <span className="mode-toggle-text">随进程</span>
                <span className="mode-toggle-desc">进程结束即自动终止</span>
              </button>
              <button
                type="button"
                className={'mode-toggle-btn' + (mode === 'persistent' ? ' is-active' : '')}
                onClick={() => setMode('persistent')}
                disabled={cmd !== 'claude'}
              >
                <span className="mode-toggle-icon">💬</span>
                <span className="mode-toggle-text">持久</span>
                <span className="mode-toggle-desc">需用户手动 Kill（仅 claude）</span>
              </button>
            </div>
            {cmd !== 'claude' && (
              <div className="field-hint">持久模式仅支持 claude 命令</div>
            )}
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
            {selectedPreset?.options && selectedPreset.options.length > 0 && (
              <div className="argument-options" aria-label="Common arguments">
                {selectedPreset.options.map((option) => {
                  const active = activeOptionIds.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={'argument-chip' + (active ? ' is-active' : '')}
                      title={option.hint}
                      onClick={() => {
                        setActiveOptionIds((ids) => active
                          ? ids.filter((id) => id !== option.id)
                          : [...ids, option.id]);
                      }}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}
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
            <div className="field">
              <label className="field-label">Working directory</label>
              <div className="cwd-input-row">
                <input
                  className="form-input-mono"
                  placeholder="Agent home directory"
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  spellCheck={false}
                />
                <button type="button" onClick={() => setDirectoryPickerOpen(true)}>
                  Choose
                </button>
              </div>
              {cwd && (
                <button type="button" className="btn-ghost cwd-clear" onClick={() => setCwd('')}>
                  Clear directory
                </button>
              )}
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

      {directoryPickerOpen && (
        <DirectoryPickerModal
          server={server}
          value={cwd || undefined}
          onSelect={(path) => {
            setCwd(path);
            setDirectoryPickerOpen(false);
          }}
          onClose={() => setDirectoryPickerOpen(false)}
        />
      )}
    </div>
  );
}