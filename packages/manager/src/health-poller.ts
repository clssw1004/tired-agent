/**
 * Manager-side active health poller.
 *
 * Periodically polls each registered agent's /health endpoint and updates
 * the agent's status in the DB. Replaces the previous agent→manager
 * heartbeat push model — this polls in the same direction as command
 * dispatch (Manager→Agent), so a successful poll proves the control
 * path is functional.
 *
 * Flow:
 *   pending → first successful poll → online
 *   online  → poll timeout/failure    → offline
 *   offline → successful poll         → online
 */

import type { Storage } from './storage.js';
import { log } from './util/log.js';

const DEFAULT_INTERVAL_MS = 60_000;  // every 60 seconds
const POLL_TIMEOUT_MS = 5_000;       // 5s per agent

export class HealthPoller {
  private storage: Storage;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(storage: Storage, intervalMs: number = DEFAULT_INTERVAL_MS) {
    this.storage = storage;
    this.intervalMs = intervalMs;
  }

  /** Start the polling loop. */
  start(): void {
    log.info({ intervalMs: this.intervalMs }, 'health-poller: starting');
    // Poll immediately, then on interval
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
  }

  /** Stop the polling loop. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('health-poller: stopped');
  }

  /** Poll all agents once. */
  async poll(): Promise<void> {
    const agents = this.storage.listAgents();
    if (agents.length === 0) return;

    await Promise.allSettled(
      agents.map(async (agent) => {
        if (this.stopped) return;
        try {
          const baseUrl = agent.baseUrl.replace(/\/+$/, '');
          const url = `${baseUrl}/health`;
          const res = await fetch(url, {
            signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
          });

          if (res.ok) {
            const body = await res.json() as {
              platform?: { os: string; arch: string; release: string };
            };

            // Update platform from health response (may be richer than registration data)
            if (body.platform) {
              if (this.stopped) return;
              this.storage.updateAgentPlatform(
                agent.id,
                body.platform.os,
                body.platform.arch,
                body.platform.release,
              );
            }

            // Transition to online (idempotent)
            if (agent.status !== 'online') {
              if (this.stopped) return;
              this.storage.updateAgentStatus(agent.id, 'online');
              log.info({ agentId: agent.id, name: agent.name }, 'health-poller: agent online');
            }
          } else {
            // Agent returned non-2xx
            if (agent.status !== 'offline') {
              if (this.stopped) return;
              this.storage.updateAgentStatus(agent.id, 'offline');
              log.warn({ agentId: agent.id, name: agent.name, status: res.status }, 'health-poller: agent unhealthy');
            }
          }
        } catch (err) {
          // Network error or timeout
          if (agent.status !== 'offline') {
            if (this.stopped) return;
            this.storage.updateAgentStatus(agent.id, 'offline');
            log.warn({ agentId: agent.id, name: agent.name, err: (err as Error).message }, 'health-poller: agent unreachable');
          }
        }
      }),
    );
  }
}
