import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../store/AuthContext';
import { CommandBlock } from './CommandBlock';

/**
 * Auto-register tab.
 *
 * Admin sets the Manager URL → page builds the base64 payload → user
 * copies the install + start one-liner onto the target machine. The
 * agent uses its own hostname as the display name in the manager UI.
 * No shared secret, no ticket, no extra fields.
 */
export function AutoRegisterTab() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [managerUrl, setManagerUrl] = useState('');

  // Default Manager URL once on mount.
  useEffect(() => {
    if (!managerUrl) {
      setManagerUrl(auth.managerBaseUrl || window.location.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trimmedUrl = managerUrl.trim().replace(/\/+$/, '');
  const b64 = trimmedUrl ? encodeRegister({ managerUrl: trimmedUrl }) : '';
  const fullCommand = b64
    ? `npm install -g @tired-agent/agent && tired-agent start --register "${b64}" --daemon`
    : '';

  return (
    <div>
      <div className="onboarding-blurb">
        Paste this one-liner into a shell on any machine you want to
        control from this Manager. The agent registers itself using its
        hostname as the display name — no config needed.
      </div>

      <form className="onboarding-form" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label className="field-label">Manager URL</label>
          <input
            value={managerUrl}
            onChange={(e) => setManagerUrl(e.target.value)}
            placeholder="https://manager.example.com:8443"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className="empty-hint" style={{ marginTop: 6 }}>
            Must be reachable from the agent's machine. Defaults to the
            Manager's own URL.
          </div>
        </div>
      </form>

      {b64 ? (
        <>
          <CommandBlock label="Run this on the target machine" command={fullCommand} multiline />
          <CommandBlock label="Raw base64 connection string" command={b64} />
          <div className="onboarding-foot">
            The agent registers with this Manager and binds to{' '}
            <code>0.0.0.0:8444</code>. Re-running the same command on the
            same machine reuses the saved <code>agentKey</code> (no
            duplicates).{' '}
            <a onClick={() => navigate('/servers')} style={{ cursor: 'pointer' }}>
              View agents →
            </a>
          </div>
        </>
      ) : (
        <div className="error-banner">
          <span>Enter the Manager URL to generate the command.</span>
        </div>
      )}
    </div>
  );
}

/** Mirror of `RegisterPayload` from `@tired-agent/agent/src/register.ts`. */
interface RegisterPayload {
  managerUrl: string;
}

/** Encode payload exactly as the agent CLI decodes it. */
function encodeRegister(p: RegisterPayload): string {
  const json = JSON.stringify(p);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
