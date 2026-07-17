/**
 * Server list store — Context-based, shared across all components.
 *
 * Initialized once at app mount from localStorage; updates are
 * persisted synchronously so navigating between pages works.
 */

import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import type { ServerRef } from '@tired-pc/protocol';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'tired-pc:servers';
const ACTIVE_KEY = 'tired-pc:active-server';

function loadServers(): ServerRef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ServerRef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveServers(servers: ServerRef[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(servers));
}

interface ServerContextValue {
  servers: ServerRef[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  addServer: (partial: Omit<ServerRef, 'id'>) => string;
  updateServer: (id: string, patch: Partial<Omit<ServerRef, 'id'>>) => void;
  removeServer: (id: string) => void;
  getServer: (id: string) => ServerRef | undefined;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerRef[]>(loadServers);
  const [activeId, setActiveIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_KEY),
  );

  // Persist servers on every change
  useEffect(() => {
    saveServers(servers);
  }, [servers]);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  }, []);

  const addServer = useCallback((partial: Omit<ServerRef, 'id'>): string => {
    const id = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const server: ServerRef = { id, ...partial };
    setServers((s) => [...s, server]);
    return id;
  }, []);

  const updateServer = useCallback(
    (id: string, patch: Partial<Omit<ServerRef, 'id'>>) => {
      setServers((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    },
    [],
  );

  const removeServer = useCallback((id: string) => {
    setServers((s) => s.filter((x) => x.id !== id));
  }, []);

  const getServer = useCallback(
    (id: string) => servers.find((x) => x.id === id),
    [servers],
  );

  const value = useMemo<ServerContextValue>(
    () => ({ servers, activeId, setActiveId, addServer, updateServer, removeServer, getServer }),
    [servers, activeId, setActiveId, addServer, updateServer, removeServer, getServer],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServerList(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServerList must be used within ServerProvider');
  return ctx;
}
