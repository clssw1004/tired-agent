import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { ServerRef, SessionMode } from '@tired-agent/protocol';
import { useServerList } from '../store/ServerContext';
import { transport } from '../api/transport';
import { useToast } from '../components/Toast';
import { DirectoryPickerModal } from '../components/DirectoryPickerModal';

// 32-char unambiguous alphabet: drops 0/1/l/o which are easy to misread or
// confuse. Combined with the local timestamp the label is essentially unique
// across sessions (32^8 × seconds = ~10^13).
const LABEL_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * Generate a default session label when the user leaves the field empty.
 * Format: `<8-char-random>_<YYYYMMDD>T<HHMMSS>` using local time. Example:
 *   a3k9m2x8_20260721T143052
 *
 * The randomness disambiguates sessions opened in the same second; the
 * timestamp makes it easy to spot when a session was created by glancing
 * at the SessionCard list.
 */
function generateDefaultLabel(): string {
  const rnd = Array.from(
    { length: 8 },
    () => LABEL_CHARS[Math.floor(Math.random() * LABEL_CHARS.length)],
  ).join('');
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${rnd}_${stamp}`;
}

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
  // Terminal size is fixed at 80×24 as a sane PTY bootstrap. The web side
  // (PtySessionView) auto-syncs the actual cols/rows to the browser
  // viewport via POST /v1/sessions/:id/resize, so this initial value only
  // matters for the very first frame. No user-facing controls needed.
  const INITIAL_COLS = 80;
  const INITIAL_ROWS = 24;
  const [mode, setMode] = useState<SessionMode>('process');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const manualArgs = args.trim() ? args.trim().split(/\s+/) : [];
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
          args: manualArgs,
          cwd: cwd.trim() || undefined,
          // Auto-generate a memorable, unique label when the user leaves the
          // field empty — otherwise SessionCard rows are visually identical
          // when several sessions of the same command are open.
          label: label.trim() || generateDefaultLabel(),
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
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
          </div>

          <div className="form-section">
            <div className="form-section-label">Options</div>
            <div className="field">
              <label className="field-label">Label (optional)</label>
              <input
                placeholder="留空自动生成 a3k9m2x8_20260721T143052"
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
              <div className="field-hint">
                终端尺寸会在会话开始后自动匹配浏览器窗口宽度，无需手动设置。电脑和移动端都按实际宽度调整。
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