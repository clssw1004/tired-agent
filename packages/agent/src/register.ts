/**
 * Agent auto-registration with a Manager.
 *
 * Flow:
 *   Admin generates base64(json({managerUrl, agentName, registerSecret})).
 *   Agent startup decodes the string, POSTs to the Manager's registration
 *   endpoint, receives an agent-specific token, and persists it locally
 *   so subsequent restarts skip registration.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerConfig } from './config.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RegisterPayload {
  managerUrl: string;
  agentName: string;
  registerSecret: string;
}

export interface AgentCredentials {
  id: string;
  token: string;
}

// ─── Registration logic ─────────────────────────────────────────

/** Decode a base64 register string. */
export function decodeRegisterString(b64: string): RegisterPayload {
  const json = Buffer.from(b64, 'base64').toString('utf-8');
  return JSON.parse(json) as RegisterPayload;
}

/** Path to the credentials file in the data directory. */
function credentialsPath(dataDir: string): string {
  return join(dataDir, '.agent-credentials');
}

/** Load saved credentials, if any. */
export async function loadCredentials(dataDir: string): Promise<AgentCredentials | null> {
  const file = credentialsPath(dataDir);
  if (!existsSync(file)) return null;
  try {
    const raw = await readFile(file, 'utf-8');
    return JSON.parse(raw) as AgentCredentials;
  } catch {
    return null;
  }
}

/** Persist credentials for subsequent restarts. */
export async function saveCredentials(dataDir: string, creds: AgentCredentials): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(credentialsPath(dataDir), JSON.stringify(creds, null, 2), 'utf-8');
}

/**
 * Register this agent with the Manager.
 *
 * POSTs the agent's name and self-reported URL to the Manager. Returns
 * the assigned agent id and API token on success.
 */
export async function registerWithManager(
  managerUrl: string,
  name: string,
  registerSecret: string,
  agentBaseUrl: string,
): Promise<AgentCredentials> {
  // Strip trailing slash from manager URL.
  const base = managerUrl.replace(/\/+$/, '');
  const url = `${base}/v1/manager/agents/register`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      baseUrl: agentBaseUrl,
      registerToken: registerSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`registration failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<AgentCredentials>;
}

/**
 * Run the registration flow if needed.
 *
 * Checks for saved credentials first; if they exist, returns them
 * immediately.  Otherwise, if cfg.registerString is present, decodes
 * it and registers with the Manager.  Returns null if neither
 * condition is met.
 */
export async function getOrRegisterCredentials(cfg: ServerConfig): Promise<AgentCredentials | null> {
  // 1. Check for saved credentials.
  const saved = await loadCredentials(cfg.dataDir);
  if (saved) return saved;

  // 2. If register string is present, decode and register.
  if (cfg.registerString) {
    const payload = decodeRegisterString(cfg.registerString);
    const agentBaseUrl = `http://${cfg.host}:${cfg.port}`;
    const creds = await registerWithManager(
      payload.managerUrl,
      payload.agentName,
      payload.registerSecret,
      agentBaseUrl,
    );
    await saveCredentials(cfg.dataDir, creds);
    return creds;
  }

  return null;
}
