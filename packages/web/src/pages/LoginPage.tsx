/**
 * Login page — single form for Manager URL + token.
 *
 * State machine:
 *   needs-credentials → URL + token form.
 *   logging-in        → spinner (form disabled).
 *   logged-in         → redirect to /servers (handled in the useEffect).
 *   error             → banner above the form, user retries.
 *   uninitialized     → brief loading until boot effect resolves.
 *
 * When URL already known (from a previous session that has expired), the
 * URL field is pre-filled. Otherwise it defaults to window.location.origin
 * (handy when the SPA is served directly by the Manager).
 */

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/AuthContext';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  // Pre-fill URL from stored base URL, or default to the current origin.
  useEffect(() => {
    if (!urlInput && auth.managerBaseUrl) {
      setUrlInput(auth.managerBaseUrl);
    } else if (!urlInput && !auth.managerBaseUrl) {
      setUrlInput(window.location.origin);
    }
  }, [auth.managerBaseUrl, urlInput]);

  // Once we have a valid session, send the user to the agent list.
  useEffect(() => {
    if (auth.status === 'logged-in') {
      navigate('/servers', { replace: true });
    }
  }, [auth.status, navigate]);

  // ── needs-credentials: URL + token form ─────────────────────────
  if (auth.status === 'needs-credentials') {
    return (
      <div className="login">
        <div className="login-card">
          <div className="login-brand">
            <div className="login-brand-logo" aria-hidden>T</div>
            <div className="login-brand-name">tired-agent</div>
          </div>
          <p className="tagline">Connect to your Manager to get started.</p>

          {auth.error && (
            <div className="error-banner">
              <span>{auth.error}</span>
            </div>
          )}

          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              const url = urlInput.trim();
              const tk = tokenInput.trim();
              if (!url || !tk) return;
              try {
                await auth.connectAndLogin(url, tk);
              } catch {
                /* error banner already rendered by auth state */
              }
            }}
          >
            <div className="field">
              <label className="field-label">Manager URL *</label>
              <input
                placeholder="https://manager.example.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={!urlInput}
              />
            </div>

            <div className="field">
              <label className="field-label">Token *</label>
              <input
                type="password"
                placeholder="paste your admin token here"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus={!!urlInput}
              />
            </div>

            <button type="submit" disabled={(auth.status as string) === 'logging-in'}>
              {(auth.status as string) === 'logging-in' ? 'Connecting…' : 'Connect'}
            </button>
          </form>

          <div className="login-help">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                localStorage.removeItem('tired-agent:manager-base-url');
                localStorage.removeItem('tired-agent:manager-session-token');
                localStorage.removeItem('tired-agent:manager-refresh-token');
                window.location.reload();
              }}
            >
              Reset Manager settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── logging-in / uninitialized: spinner ──────────────────────────
  if (auth.status === 'logging-in' || auth.status === 'uninitialized') {
    return (
      <div className="login">
        <div className="login-card">
          <h1>tired-agent</h1>
          <p className="tagline">Connecting…</p>
        </div>
      </div>
    );
  }

  // ── logged-in: redirect handled by the effect above ──────────────
  if (auth.status === 'logged-in') {
    return <Navigate to="/servers" replace />;
  }

  // ── error: surface it and offer a retry path ─────────────────────
  return (
    <div className="login">
      <div className="login-card">
        <h1>tired-agent</h1>
        {auth.error && (
          <div className="error-banner">
            <span>{auth.error}</span>
          </div>
        )}
        <button
          style={{ width: '100%' }}
          onClick={() => {
            auth.logout();
            navigate(0);
          }}
        >
          Try again
        </button>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              localStorage.removeItem('tired-agent:manager-base-url');
              localStorage.removeItem('tired-agent:manager-session-token');
              window.location.reload();
            }}
          >
            Reset Manager settings
          </button>
        </div>
      </div>
    </div>
  );
}
