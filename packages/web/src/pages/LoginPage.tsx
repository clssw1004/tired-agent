/**
 * Login page — driven entirely by `useAuth().status`.
 *
 * State machine:
 *   needs-manager  → form to enter the Manager base URL.
 *   needs-login    → form to enter the Manager admin token.
 *   logging-in     → spinner.
 *   logged-in      → redirect to /servers (handled in this component).
 *   error          → banner + retry, falling back to the appropriate form.
 *   uninitialized  → brief loading state until the boot effect resolves.
 */

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/AuthContext';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  const [urlInput, setUrlInput] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  // Once we have a valid session, send the user to the agent list.
  useEffect(() => {
    if (auth.status === 'logged-in') {
      navigate('/servers', { replace: true });
    }
  }, [auth.status, navigate]);

  // ── needs-manager: configure Manager base URL ────────────────────────
  if (auth.status === 'needs-manager') {
    return (
      <div className="login">
        <div className="login-card">
          <h1>tired-pc</h1>
          <p className="tagline">Connect to your Manager to get started.</p>

          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              const url = urlInput.trim();
              if (!url) return;
              auth.setManagerBaseUrl(url);
              setUrlInput('');
            }}
          >
            <div className="field">
              <label className="field-label">Manager URL *</label>
              <input
                placeholder="https://manager.example.com"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onFocus={() => {
                  if (!urlInput) setUrlInput(window.location.origin);
                }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <button type="submit" style={{ width: '100%' }}>
              Continue
            </button>
          </form>

          <p className="empty-hint" style={{ marginTop: 12 }}>
            The Manager is the entry point that brokers access to your
            agents. Paste the URL where it's deployed.
          </p>
        </div>
      </div>
    );
  }

  // ── needs-login: enter the Manager admin token ───────────────────────
  if (auth.status === 'needs-login') {
    return (
      <div className="login">
        <div className="login-card">
          <h1>tired-pc</h1>
          <p className="tagline">
            Sign in to <code>{auth.managerBaseUrl}</code>
          </p>

          {auth.error && (
            <div className="error-banner">
              <span>{auth.error}</span>
            </div>
          )}

          <form
            className="modal"
            onSubmit={async (e) => {
              e.preventDefault();
              const tk = tokenInput.trim();
              if (!tk) return;
              try {
                await auth.login(tk);
                setTokenInput('');
              } catch {
                /* error banner already rendered by auth state */
              }
            }}
          >
            <div className="field">
              <label className="field-label">Manager token *</label>
              <input
                type="password"
                placeholder="paste your token here"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                autoFocus
              />
            </div>
            <button type="submit" style={{ width: '100%' }}>
              Sign in
            </button>
          </form>

          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                localStorage.removeItem('tired-pc:manager-base-url');
                localStorage.removeItem('tired-pc:manager-session-token');
                window.location.reload();
              }}
            >
              Use a different Manager
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── logging-in / uninitialized: spinner ───────────────────────────────
  if (auth.status === 'logging-in' || auth.status === 'uninitialized') {
    return (
      <div className="login">
        <div className="login-card">
          <h1>tired-pc</h1>
          <p className="tagline">Connecting…</p>
        </div>
      </div>
    );
  }

  // ── logged-in: redirect handled by the effect above ───────────────────
  if (auth.status === 'logged-in') {
    return <Navigate to="/servers" replace />;
  }

  // ── error: surface it and offer a retry path ──────────────────────────
  return (
    <div className="login">
      <div className="login-card">
        <h1>tired-pc</h1>
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
              localStorage.removeItem('tired-pc:manager-base-url');
              localStorage.removeItem('tired-pc:manager-session-token');
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
