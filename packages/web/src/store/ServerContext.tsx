/**
 * ServerContext — thin compatibility shim over `AuthContext`.
 *
 * Originally this module held the localStorage-backed server list. Now that
 * the SPA talks to a Manager, the per-user "server" notion is gone — every
 * `ServerRef` carries the Manager URL + session token, and the agent being
 * proxied to is identified by the new `agentId` field.
 *
 * The shape exposed here matches the old API closely so existing page code
 * (`useServerList()` consumers) keeps working: they call
 * `servers.find(s => s.id === id)` to look up a ref and pass it to the
 * transport. The transport call site now also needs the `agentId` — see
 * the page updates in `src/pages/`.
 */

import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ServerRef } from '@tired-pc/protocol';
import { useAuth } from './AuthContext';

/**
 * ServerRef augmented with the id of the agent being proxied to.
 * `baseUrl` and `token` always refer to the Manager.
 */
export interface AgentServerRef extends ServerRef {
  agentId: string;
}

interface ServerContextValue {
  servers: AgentServerRef[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addServer: (partial: Omit<AgentServerRef, 'id'>) => string;
  updateServer: (id: string, patch: Partial<Omit<AgentServerRef, 'id'>>) => void;
  removeServer: (id: string) => void;
  getServer: (id: string) => AgentServerRef | undefined;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { agents, managerBaseUrl, sessionToken, addAgent, deleteAgent } = useAuth();

  const servers = useMemo<AgentServerRef[]>(
    () =>
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        baseUrl: managerBaseUrl ?? '',
        token: sessionToken ?? '',
        agentId: a.id,
      })),
    [agents, managerBaseUrl, sessionToken],
  );

  // Legacy mutation helpers — they delegate to the AuthContext APIs and
  // return a synthesized id so existing call sites keep their shape.
  const value = useMemo<ServerContextValue>(
    () => ({
      servers,
      activeId: null,
      setActiveId: () => {
        /* no-op: routing decides the active agent via URL params */
      },
      addServer: (partial) => {
        // Fire-and-forget; the caller doesn't await the manager round-trip
        // before navigating. We return a temporary id so the caller's
        // `navigate(/servers/:id)` works while the new agent loads.
        const tempId = `pending_${Date.now()}`;
        void addAgent(partial.name, partial.baseUrl, partial.token);
        return tempId;
      },
      updateServer: (id, patch) => {
        // For simplicity we treat update as delete+add. The Manager API
        // doesn't expose PUT in the transport contract used here.
        void deleteAgent(id).then(() =>
          addAgent(patch.name ?? id, patch.baseUrl ?? '', patch.token ?? ''),
        );
      },
      removeServer: (id) => {
        void deleteAgent(id);
      },
      getServer: (id) => servers.find((s) => s.id === id),
    }),
    [servers, addAgent, deleteAgent],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServerList(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServerList must be used within ServerProvider');
  return ctx;
}
