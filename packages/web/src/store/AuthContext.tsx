/**
 * AuthContext — Manager-based authentication and agent registry.
 *
 * The SPA now talks to a Manager (instead of saving server URLs in
 * localStorage). On mount we:
 *   1. Read `tired-agent:manager-base-url` + `tired-agent:manager-session-token`
 *      from localStorage.
 *   2. If both are present, call `transport.checkSession` to validate the
 *      token. If valid, fetch the agent list and go to `logged-in`.
 *   3. Otherwise, prompt the user for the missing credential.
 *
 * The token is the user-supplied Manager admin token (entered on the
 * login page). The session token is what the Manager hands back and is
 * used as a bearer token on every subsequent request.
 */

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ServerRef } from '@tired-agent/protocol';
import { transport } from '../api/transport';

export interface AgentSummary {
  id: string;
  name: string;
  baseUrl: string;
}

export type AuthStatus =
  | 'uninitialized'
  | 'needs-manager'
  | 'needs-login'
  | 'logged-in'
  | 'logging-in'
  | 'error';

export interface AuthState {
  managerBaseUrl: string | null;
  sessionToken: string | null;
  agents: AgentSummary[];
  status: AuthStatus;
  error: string | null;
  setManagerBaseUrl(url: string): void;
  login(token: string): Promise<void>;
  logout(): void;
  refreshAgents(): Promise<void>;
  addAgent(name: string, baseUrl: string, token: string): Promise<void>;
  deleteAgent(id: string): Promise<void>;
}

const BASE_URL_KEY = 'tired-agent:manager-base-url';
const SESSION_TOKEN_KEY = 'tired-agent:manager-session-token';

/**
 * Build a ServerRef that points at the Manager — used for all
 * Manager-API calls (login, checkSession, listAgents, addAgent, deleteAgent)
 * that do not target a specific agent.
 */
function makeManagerRef(baseUrl: string, token: string | null): ServerRef {
  return { id: 'manager', name: 'Manager', baseUrl, token: token ?? '' };
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [managerBaseUrl, setManagerBaseUrlState] = useState<string | null>(
    () => localStorage.getItem(BASE_URL_KEY),
  );
  const [sessionToken, setSessionTokenState] = useState<string | null>(
    () => localStorage.getItem(SESSION_TOKEN_KEY),
  );
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [status, setStatus] = useState<AuthStatus>('uninitialized');
  const [error, setError] = useState<string | null>(null);

  // Persist base URL
  const setManagerBaseUrl = useCallback((url: string) => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    localStorage.setItem(BASE_URL_KEY, trimmed);
    setManagerBaseUrlState(trimmed);
    // Saving a new base URL invalidates any existing session.
    localStorage.removeItem(SESSION_TOKEN_KEY);
    setSessionTokenState(null);
    setAgents([]);
    setStatus('needs-login');
    setError(null);
  }, []);

  const refreshAgents = useCallback(async () => {
    if (!managerBaseUrl || !sessionToken) {
      setAgents([]);
      return;
    }
    const ref = makeManagerRef(managerBaseUrl, sessionToken);
    const list = await transport.listAgents(ref);
    setAgents(list);
  }, [managerBaseUrl, sessionToken]);

  const login = useCallback(
    async (token: string) => {
      if (!managerBaseUrl) {
        setStatus('needs-manager');
        throw new Error('Manager base URL is not set');
      }
      setStatus('logging-in');
      setError(null);
      try {
        const ref = makeManagerRef(managerBaseUrl, null);
        const { sessionToken: newToken } = await transport.login(ref, token);
        localStorage.setItem(SESSION_TOKEN_KEY, newToken);
        setSessionTokenState(newToken);
        const list = await transport.listAgents(
          makeManagerRef(managerBaseUrl, newToken),
        );
        setAgents(list);
        setStatus('logged-in');
      } catch (e) {
        const msg = (e as Error).message;
        setError(msg);
        setStatus('error');
        throw e;
      }
    },
    [managerBaseUrl],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    setSessionTokenState(null);
    setAgents([]);
    setStatus('needs-login');
    setError(null);
  }, []);

  const addAgent = useCallback(
    async (name: string, baseUrl: string, token: string) => {
      if (!managerBaseUrl || !sessionToken) {
        throw new Error('Not logged in');
      }
      const ref = makeManagerRef(managerBaseUrl, sessionToken);
      await transport.addAgent(ref, {
        name: name.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ''),
        token,
      });
      await refreshAgents();
    },
    [managerBaseUrl, sessionToken, refreshAgents],
  );

  const deleteAgent = useCallback(
    async (id: string) => {
      if (!managerBaseUrl || !sessionToken) {
        throw new Error('Not logged in');
      }
      const ref = makeManagerRef(managerBaseUrl, sessionToken);
      await transport.deleteAgent(ref, id);
      await refreshAgents();
    },
    [managerBaseUrl, sessionToken, refreshAgents],
  );

  // Boot sequence: figure out the initial status, validate any cached
  // session token, and fetch the agent list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!managerBaseUrl) {
        if (!cancelled) setStatus('needs-manager');
        return;
      }
      if (!sessionToken) {
        if (!cancelled) setStatus('needs-login');
        return;
      }
      try {
        const ok = await transport.checkSession(
          makeManagerRef(managerBaseUrl, sessionToken),
        );
        if (cancelled) return;
        if (!ok) {
          localStorage.removeItem(SESSION_TOKEN_KEY);
          setSessionTokenState(null);
          setStatus('needs-login');
          return;
        }
        const list = await transport.listAgents(
          makeManagerRef(managerBaseUrl, sessionToken),
        );
        if (cancelled) return;
        setAgents(list);
        setStatus('logged-in');
      } catch (e) {
        if (cancelled) return;
        // Network or unexpected error: keep the URL but force re-login.
        localStorage.removeItem(SESSION_TOKEN_KEY);
        setSessionTokenState(null);
        setError((e as Error).message);
        setStatus('needs-login');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []); // intentionally only on mount

  const value = useMemo<AuthState>(
    () => ({
      managerBaseUrl,
      sessionToken,
      agents,
      status,
      error,
      setManagerBaseUrl,
      login,
      logout,
      refreshAgents,
      addAgent,
      deleteAgent,
    }),
    [
      managerBaseUrl,
      sessionToken,
      agents,
      status,
      error,
      setManagerBaseUrl,
      login,
      logout,
      refreshAgents,
      addAgent,
      deleteAgent,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
