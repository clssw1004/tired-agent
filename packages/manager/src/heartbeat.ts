/**
 * In-memory heartbeat tracker for agents.
 *
 * Maintains lastSeen timestamps and metadata per agent. Records are kept
 * until explicitly removed (via removeAgent) — never auto-pruned.
 */

export interface AgentHeartbeatInfo {
  lastSeen: number;
  firstSeenAt: number;
  version: string | null;
  hostname: string | null;
  agentUptime: number | null;
  beatCount: number;
  remoteAddress: string | null;
}

export type AgentState = 'online' | 'offline' | 'unknown';

export interface AgentStatus {
  state: AgentState;
  lastSeen: number | null;
  firstSeenAt: number | null;
  version: string | null;
  hostname: string | null;
  agentUptime: number | null;
  beatCount: number;
  remoteAddress: string | null;
}

export const OFFLINE_TIMEOUT_MS = 90_000;

export class HeartbeatTracker {
  private store = new Map<string, AgentHeartbeatInfo>();

  /** Record a heartbeat for an agent. Creates entry if first time. */
  beat(
    agentId: string,
    info: {
      version?: string;
      hostname?: string;
      uptime?: number;
      remoteAddress?: string;
    },
  ): void {
    const now = Date.now();
    const existing = this.store.get(agentId);

    this.store.set(agentId, {
      lastSeen: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
      version: info.version ?? existing?.version ?? null,
      hostname: info.hostname ?? existing?.hostname ?? null,
      agentUptime: info.uptime ?? existing?.agentUptime ?? null,
      beatCount: (existing?.beatCount ?? 0) + 1,
      remoteAddress: info.remoteAddress ?? existing?.remoteAddress ?? null,
    });
  }

  /** Get heartbeat status for a single agent. Returns null if never seen. */
  getStatus(agentId: string): AgentStatus | null {
    const info = this.store.get(agentId);
    if (!info) return null;

    const now = Date.now();
    const state: AgentState =
      now - info.lastSeen <= OFFLINE_TIMEOUT_MS ? 'online' : 'offline';

    return {
      state,
      lastSeen: info.lastSeen,
      firstSeenAt: info.firstSeenAt,
      version: info.version,
      hostname: info.hostname,
      agentUptime: info.agentUptime,
      beatCount: info.beatCount,
      remoteAddress: info.remoteAddress,
    };
  }

  /**
   * Enrich an array of Agent rows with heartbeat status fields.
   * Agents never seen (no heartbeat yet) get state: 'unknown'.
   */
  enrichAgents<T extends { id: string }>(
    agents: T[],
  ): (T & AgentStatus)[] {
    return agents.map((agent) => {
      const status = this.getStatus(agent.id);
      return {
        ...agent,
        state: status?.state ?? 'unknown',
        lastSeen: status?.lastSeen ?? null,
        firstSeenAt: status?.firstSeenAt ?? null,
        version: status?.version ?? null,
        hostname: status?.hostname ?? null,
        agentUptime: status?.agentUptime ?? null,
        beatCount: status?.beatCount ?? 0,
        remoteAddress: status?.remoteAddress ?? null,
      };
    });
  }

  /** Remove heartbeat tracking for an agent (called on agent deletion). */
  removeAgent(agentId: string): void {
    this.store.delete(agentId);
  }

  /** Number of tracked agents (for diagnostics). */
  get size(): number {
    return this.store.size;
  }
}
