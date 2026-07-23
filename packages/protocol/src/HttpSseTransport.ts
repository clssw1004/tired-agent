/**
 * HttpSseTransport — MVP implementation of `Transport` using HTTP REST
 * for control plane and Server-Sent Events for the live output stream.
 *
 * Auto-reconnects with exponential backoff so the UI does not have to
 * worry about network blips; missed bytes during the disconnect window
 * are picked up via `fetchOutput` on each reconnect.
 */

import type {
  DirectoryFavorite,
  DirectoryListing,
  DirectoryShortcuts,
  FetchOutputResult,
  ResizeRequest,
  ServerRef,
  Session,
  SessionSpec,
  StreamEvent,
  InputRequest,
} from './types.js';
import type {
  SubscribeHandlers,
  Subscription,
  Transport,
} from './Transport.js';

/** Exponential backoff bounds for SSE reconnect attempts (milliseconds). */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;

function authHeaders(ref: ServerRef): HeadersInit {
  return {
    Authorization: `Bearer ${ref.token}`,
    Accept: 'application/json',
  };
}

function ensureBaseUrl(ref: ServerRef): string {
  return ref.baseUrl.replace(/\/+$/, '');
}

async function checkOk(res: Response, op: string): Promise<Response> {
  if (res.ok) return res;
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ? `: ${body.error.message}` : '';
  } catch {
    /* ignore */
  }
  throw new Error(`${op} failed (${res.status})${detail}`);
}

function base64ToBytes(b64: string): Uint8Array {
  // React Native (and older browsers) lack atob/btoa on binary strings,
  // but Uint8Array + global.atob is available everywhere we target.
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunk, bytes.length)),
    );
  }
  return globalThis.btoa(binary);
}

/**
 * Create an SSE connection with auto-reconnect (exponential backoff).
 * Returns a Subscription whose `close()` permanently stops the stream.
 *
 * @param agentId — when set, the SSE URL is routed through a Manager's proxy
 *   (`/v1/agents/:agentId/sessions/:id/stream`).
 */
function openEventSource(
  url: string,
  headers: Record<string, string>,
  initialFrom: number,
  onEvent: (ev: StreamEvent) => void,
  onError: (err: Error) => void,
  agentId?: string,
): { close: () => void } {
  let stopped = false;
  let attempt = 0;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // Highest byte offset consumed so far. On reconnect we resume from here so
  // the server does not replay bytes we already have (avoids duplicates).
  let currentFrom = Math.max(0, initialFrom);

  const connect = () => {
    if (stopped) return;

    // EventSource does not natively support custom headers (browsers & RN),
    // so we pass the token via a query string for SSE only. REST calls use
    // the Authorization header. The server accepts both for SSE endpoints.
    // `from` resumes the stream at the offset we've already consumed.
    const u = new URL(url);
    u.searchParams.set('from', String(currentFrom));
    const urlWithToken = appendQueryToken(u.toString(), headers.Authorization ?? '');
    es = new EventSource(urlWithToken);

    // The server emits *named* SSE events (event: output / state / heartbeat).
    // The event name lives only in the SSE `event:` line — the JSON payload
    // has no `type` field. We read `msg.type` (set by EventSource from the
    // `event:` line) to recover the StreamEvent discriminator; otherwise
    // subscribe's `ev.type === 'output'` branch never matches and chunks
    // are silently dropped on the client.
    const dispatch = (msg: MessageEvent) => {
      attempt = 0;
      try {
        const parsed = JSON.parse(msg.data) as Record<string, unknown>;
        const eventType = (msg.type || (parsed.type as string)) as string | undefined;
        if (!eventType) {
          onError(new Error('SSE event without a type discriminator'));
          return;
        }
        // Server serialises the session flat (matches the Session shape).
        // The StreamEvent union expects `{type:'state', session: Session}`
        // so wrap. Heartbeats get only `ts`. Output chunks pass through.
        const ev = (() => {
          switch (eventType) {
            case 'state':
              return { type: 'state', session: parsed } as unknown as StreamEvent;
            case 'heartbeat':
              return { type: 'heartbeat', ts: Number(parsed.ts ?? 0) } as StreamEvent;
            default:
              return {
                type: 'output',
                offset: Number(parsed.offset ?? 0),
                data: String(parsed.data ?? ''),
              } as StreamEvent;
          }
        })();
        // Advance the resume offset past this chunk so a reconnect won't
        // replay it.
        if (ev.type === 'output') {
          currentFrom = Math.max(currentFrom, ev.offset + base64ToBytes(ev.data).length);
        }
        onEvent(ev);
      } catch (err) {
        onError(new Error(`Failed to parse SSE event: ${(err as Error).message}`));
      }
    };
    es.addEventListener('output', dispatch as EventListener);
    es.addEventListener('state', dispatch as EventListener);
    es.addEventListener('heartbeat', dispatch as EventListener);
    // Fallback for any unnamed events the server might ever emit.
    es.onmessage = dispatch;

    es.onerror = () => {
      if (stopped) return;
      es?.close();
      es = null;
      const delay = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_MIN_MS * 2 ** Math.min(attempt, 6),
      );
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
      onError(new Error(`SSE disconnected; reconnecting in ${delay}ms (attempt ${attempt})`));
    };
  };

  connect();

  return {
    close: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      es = null;
    },
  };
}

function appendQueryToken(url: string, authHeader: string): string {
  if (!authHeader.toLowerCase().startsWith('bearer ')) return url;
  const token = authHeader.slice('bearer '.length).trim();
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set('access_token', token);
  return u.toString();
}

/**
 * HTTP + SSE implementation of `Transport`.
 *
 * Use the `createHttpSseTransport()` factory rather than instantiating directly,
 * so we can swap fetch implementations in tests.
 *
 * When `agentId` is supplied, API paths are prefixed with `/v1/agents/:aid/`
 * so requests route through a Manager proxy to a specific Agent.
 */
export class HttpSseTransport implements Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  /** Build the base path for session-related API calls. */
  private sessionUrl(
    ref: ServerRef,
    sessionId: string,
    suffix: string,
    agentId?: string,
  ): string {
    const base = ensureBaseUrl(ref);
    if (agentId) {
      return `${base}/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}${suffix}`;
    }
    return `${base}/v1/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  }

  /** Build a URL for agent-managed endpoints (sessions list, create). */
  private agentsUrl(ref: ServerRef, agentId?: string): string {
    const base = ensureBaseUrl(ref);
    if (agentId) {
      return `${base}/v1/agents/${encodeURIComponent(agentId)}/sessions`;
    }
    return `${base}/v1/sessions`;
  }

  /** Build a URL for directory-browsing endpoints. */
  private directoriesUrl(ref: ServerRef, agentId?: string): string {
    const base = ensureBaseUrl(ref);
    return agentId
      ? `${base}/v1/agents/${encodeURIComponent(agentId)}/directories`
      : `${base}/v1/directories`;
  }

  async listSessions(ref: ServerRef, agentId?: string): Promise<Session[]> {
    const res = await this.fetchImpl(this.agentsUrl(ref, agentId), {
      headers: authHeaders(ref),
    });
    await checkOk(res, 'listSessions');
    return (await res.json()) as Session[];
  }

  async createSession(ref: ServerRef, spec: SessionSpec, agentId?: string): Promise<Session> {
    const res = await this.fetchImpl(this.agentsUrl(ref, agentId), {
      method: 'POST',
      headers: { ...authHeaders(ref), 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    await checkOk(res, 'createSession');
    return (await res.json()) as Session;
  }

  async listDirectories(
    ref: ServerRef,
    path?: string,
    agentId?: string,
  ): Promise<DirectoryListing> {
    const base = this.directoriesUrl(ref, agentId);
    const url = path == null
      ? base
      : `${base}?${new URLSearchParams({ path }).toString()}`;
    const res = await this.fetchImpl(url, { headers: authHeaders(ref) });
    await checkOk(res, 'listDirectories');
    return (await res.json()) as DirectoryListing;
  }

  async getDirectoryShortcuts(
    ref: ServerRef,
    agentId?: string,
  ): Promise<DirectoryShortcuts> {
    const res = await this.fetchImpl(
      `${this.directoriesUrl(ref, agentId)}/shortcuts`,
      { headers: authHeaders(ref) },
    );
    await checkOk(res, 'getDirectoryShortcuts');
    return (await res.json()) as DirectoryShortcuts;
  }

  async addDirectoryFavorite(
    ref: ServerRef,
    favorite: { path: string; name?: string },
    agentId?: string,
  ): Promise<DirectoryFavorite> {
    const res = await this.fetchImpl(
      `${this.directoriesUrl(ref, agentId)}/favorites`,
      {
        method: 'POST',
        headers: { ...authHeaders(ref), 'Content-Type': 'application/json' },
        body: JSON.stringify(favorite),
      },
    );
    await checkOk(res, 'addDirectoryFavorite');
    return (await res.json()) as DirectoryFavorite;
  }

  async removeDirectoryFavorite(
    ref: ServerRef,
    id: string,
    agentId?: string,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `${this.directoriesUrl(ref, agentId)}/favorites/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'removeDirectoryFavorite');
  }

  async getSession(ref: ServerRef, id: string, agentId?: string): Promise<Session> {
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, '', agentId),
      { headers: authHeaders(ref) },
    );
    await checkOk(res, 'getSession');
    return (await res.json()) as Session;
  }

  async killSession(ref: ServerRef, id: string, agentId?: string): Promise<void> {
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, '', agentId),
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'killSession');
  }

  async deleteSession(ref: ServerRef, id: string, agentId?: string): Promise<void> {
    // Same endpoint as killSession — server distinguishes exited vs running
    // and routes to hard-delete vs SIGKILL respectively.
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, '', agentId),
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'deleteSession');
  }

  async pruneSessions(
    ref: ServerRef,
    olderThanHours = 24,
    agentId?: string,
  ): Promise<{ removed: number }> {
    const base = ensureBaseUrl(ref);
    const path = agentId
      ? `${base}/v1/agents/${encodeURIComponent(agentId)}/sessions/prune`
      : `${base}/v1/sessions/prune`;
    const res = await this.fetchImpl(
      `${path}?olderThanHours=${olderThanHours}`,
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'pruneSessions');
    return (await res.json()) as { removed: number };
  }

  async resizeSession(
    ref: ServerRef,
    id: string,
    cols: number,
    rows: number,
    agentId?: string,
  ): Promise<void> {
    const body: ResizeRequest = { cols, rows };
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, '/resize', agentId),
      { method: 'POST', headers: { ...authHeaders(ref), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    await checkOk(res, 'resizeSession');
  }

  async fetchOutput(
    ref: ServerRef,
    id: string,
    fromOffset: number,
    limit?: number,
    agentId?: string,
    /**
     * When set, ask the server to read only the last `n` bytes via a
     * backwards seek (much faster than replaying 50MB on every session
     * re-open). Mutually exclusive with `from`/`limit` server-side; when
     * provided we drop `from` from the URL so the server's refine check
     * doesn't trip on `from !== 0`.
     */
    tail?: number,
  ): Promise<FetchOutputResult> {
    const params = new URLSearchParams();
    if (tail != null) {
      params.set('tail', String(tail));
    } else {
      params.set('from', String(fromOffset));
      if (limit != null) params.set('limit', String(limit));
    }
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, `/output?${params.toString()}`, agentId),
      { headers: authHeaders(ref) },
    );
    await checkOk(res, 'fetchOutput');
    return (await res.json()) as FetchOutputResult;
  }

  subscribe(
    ref: ServerRef,
    id: string,
    handlers: SubscribeHandlers,
    agentId?: string,
    fromOffset = 0,
  ): Subscription {
    const url = this.sessionUrl(ref, id, '/stream', agentId);
    const connection = openEventSource(
      url,
      { Authorization: `Bearer ${ref.token}` },
      fromOffset,
      (ev) => {
        if (ev.type === 'output') {
          handlers.onChunk({
            offset: ev.offset,
            data: base64ToBytes(ev.data),
          });
        } else if (ev.type === 'state') {
          handlers.onState(ev.session);
        }
        // 'heartbeat' is silently consumed
      },
      handlers.onError,
      agentId,
    );
    return { close: () => connection.close() };
  }

  async sendInput(ref: ServerRef, id: string, data: Uint8Array, agentId?: string): Promise<void> {
    const body: InputRequest = { data: bytesToBase64(data) };
    const res = await this.fetchImpl(
      this.sessionUrl(ref, id, '/input', agentId),
      { method: 'POST', headers: { ...authHeaders(ref), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    await checkOk(res, 'sendInput');
  }

  async listAgents(ref: ServerRef): Promise<{ id: string; name: string; baseUrl: string }[]> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/manager/agents`, {
      headers: authHeaders(ref),
    });
    await checkOk(res, 'listAgents');
    return (await res.json()) as { id: string; name: string; baseUrl: string }[];
  }

  async addAgent(ref: ServerRef, agent: { name: string; baseUrl: string; token: string }): Promise<{ id: string }> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/manager/agents`, {
      method: 'POST',
      headers: { ...authHeaders(ref), 'Content-Type': 'application/json' },
      body: JSON.stringify(agent),
    });
    await checkOk(res, 'addAgent');
    return (await res.json()) as { id: string };
  }

  async deleteAgent(ref: ServerRef, agentId: string): Promise<void> {
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/manager/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'deleteAgent');
  }

  async login(ref: ServerRef, token: string): Promise<{
    sessionToken: string;
    refreshToken: string;
    sessionExpiresIn: number;
    refreshExpiresIn: number;
  }> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/manager/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    await checkOk(res, 'login');
    return (await res.json()) as {
      sessionToken: string;
      refreshToken: string;
      sessionExpiresIn: number;
      refreshExpiresIn: number;
    };
  }

  async refreshSession(
    ref: ServerRef,
    refreshToken: string,
  ): Promise<{
    sessionToken: string;
    refreshToken: string;
    sessionExpiresIn: number;
    refreshExpiresIn: number;
  }> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/manager/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${refreshToken}` },
    });
    await checkOk(res, 'refreshSession');
    return (await res.json()) as {
      sessionToken: string;
      refreshToken: string;
      sessionExpiresIn: number;
      refreshExpiresIn: number;
    };
  }

  async checkSession(ref: ServerRef): Promise<boolean> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/manager/auth/me`, {
      headers: { Authorization: `Bearer ${ref.token}` },
    });
    return res.ok;
  }
}

export function createHttpSseTransport(): HttpSseTransport {
  return new HttpSseTransport();
}
