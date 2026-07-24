/**
 * Agent heartbeat sender.
 *
 * Sends periodic POST requests to the manager to report liveness.
 * Started automatically when the agent is registered with a manager.
 */

import { HEARTBEAT_PATH } from '@tired-agent/protocol';

export interface HeartbeatOptions {
  /** Manager base URL (e.g. http://192.168.2.77:8443). */
  managerUrl: string;
  /** Agent ID assigned by the manager during registration. */
  agentId: string;
  /** Agent bearer token assigned by the manager. */
  token: string;
  /** Agent display name (hostname). */
  name: string;
  /** Heartbeat interval in ms (default 30000). */
  intervalMs?: number;
  /** Agent software version. */
  version: string;
}

/**
 * Start the heartbeat loop. Returns a stop function.
 * Sends the first beat immediately, then at each interval.
 */
export function startHeartbeat(opts: HeartbeatOptions): () => void {
  // Send first beat immediately
  sendBeat(opts);

  const intervalMs = opts.intervalMs ?? 30_000;
  const timer = setInterval(() => sendBeat(opts), intervalMs);

  return () => {
    clearInterval(timer);
  };
}

async function sendBeat(opts: HeartbeatOptions): Promise<void> {
  const url = `${opts.managerUrl}${HEARTBEAT_PATH}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: opts.version,
        hostname: opts.name,
        uptime: Math.floor(process.uptime()),
      }),
    });

    if (res.status === 401) {
      // Token was rejected — agent may have been re-registered or deleted
      // from manager. Log but keep trying in case it's transient.
      console.warn(
        `[heartbeat] manager rejected token (401), agent ${opts.agentId} may need re-registration`,
      );
    }
  } catch {
    // Network error (manager down, DNS failure, etc.) — silently retry on next interval.
    // Don't spam logs on every failure.
  }
}
