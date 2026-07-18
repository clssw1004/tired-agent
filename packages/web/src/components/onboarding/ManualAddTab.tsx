import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/AuthContext';
import { CommandBlock } from './CommandBlock';

/**
 * Manual-add tab.
 *
 * Walks the user through installing the agent on a remote machine,
 * starting it, and pasting the URL back here so the Manager knows how
 * to reach it. The agent auto-generates its own token on first start
 * (printed to stdout) so the user doesn't have to set one.
 */
export function ManualAddTab() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [agentUrl, setAgentUrl] = useState('');
  const [agentToken, setAgentToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = agentUrl.trim().replace(/\/+$/, '');
    const tk = agentToken.trim();
    const nm = name.trim();
    if (!url) {
      setError('Agent URL is required');
      return;
    }
    // Token is optional — if the user didn't set CLSSW_TOKEN on the
    // agent, the daemon auto-generates one and prints it on first
    // start. The admin then pastes that token here.
    setLoading(true);
    try {
      await auth.addAgent(nm || url, url, tk);
      navigate('/servers');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="onboarding-blurb">
        Run the agent on any machine you control, then paste its URL and
        token below to register it with this Manager.
      </div>

      <div className="onboarding-step">
        <div className="onboarding-step-num">1</div>
        <div className="onboarding-step-body">
          <div className="onboarding-step-title">Install the agent</div>
          <div className="onboarding-step-desc">
            Requires Node.js 18+. Installs the CLI globally.
          </div>
          <CommandBlock
            command="npm install -g @tired-agent/agent"
            label="Run on the target machine"
          />
        </div>
      </div>

      <div className="onboarding-step">
        <div className="onboarding-step-num">2</div>
        <div className="onboarding-step-body">
          <div className="onboarding-step-title">Start the agent</div>
          <div className="onboarding-step-desc">
            Set <code>HOST=0.0.0.0</code> if the Manager is on a different
            machine. The agent prints its auto-generated token on first
            start — copy it for step 3.
          </div>
          <CommandBlock
            multiline
            command={`mkdir -p ~/.tiredagent
cat > ~/.tiredagent/.env <<EOF
HOST=0.0.0.0
PORT=8444
EOF
tired-agent start`}
            label="Run on the target machine"
          />
        </div>
      </div>

      <div className="onboarding-step">
        <div className="onboarding-step-num">3</div>
        <div className="onboarding-step-body">
          <div className="onboarding-step-title">Register with this Manager</div>
          <div className="onboarding-step-desc">
            Paste the URL the agent is listening on (must be reachable by
            this Manager) and the token it printed on first start. The
            token is optional if you set <code>CLSSW_TOKEN</code> yourself
            on the agent — leave blank to use whatever it generated.
          </div>

          {error && (
            <div className="error-banner">
              <span>{error}</span>
            </div>
          )}

          <form className="onboarding-form" onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label">Name (optional)</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Home Desktop"
              />
            </div>
            <div className="field">
              <label className="field-label">Agent URL *</label>
              <input
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                placeholder="http://192.168.1.5:8444"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label className="field-label">Agent Token (optional)</label>
              <input
                value={agentToken}
                onChange={(e) => setAgentToken(e.target.value)}
                placeholder="paste the token the agent printed on first start"
                autoCapitalize="off"
                autoCorrect="off"
              />
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => navigate('/servers')}
              >
                Cancel
              </button>
              <button type="submit" disabled={loading}>
                {loading ? 'Adding…' : 'Add Agent'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
