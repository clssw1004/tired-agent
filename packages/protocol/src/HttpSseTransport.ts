/**
 * HttpSseTransport — MVP implementation of `Transport` using HTTP REST
 * for control plane and Server-Sent Events for the live output stream.
 *
 * Auto-reconnects with exponential backoff so the UI does not have to
 * worry about network blips; missed bytes during the disconnect window
 * are picked up via `fetchOutput` on each reconnect.
 */

import type {
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
    'Content-Type': 'application/json',
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
 */
function openEventSource(
  url: string,
  headers: Record<string, string>,
  onEvent: (ev: StreamEvent) => void,
  onError: (err: Error) => void,
): { close: () => void } {
  let stopped = false;
  let attempt = 0;
  let es: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // EventSource does not natively support custom headers (browsers & RN),
  // so we pass the token via a query string for SSE only. REST calls use
  // the Authorization header. The server accepts both for SSE endpoints.
  const urlWithToken = appendQueryToken(url, headers.Authorization ?? '');

  const connect = () => {
    if (stopped) return;
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
 */
export class HttpSseTransport implements Transport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  async listSessions(ref: ServerRef): Promise<Session[]> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/sessions`, {
      headers: authHeaders(ref),
    });
    await checkOk(res, 'listSessions');
    return (await res.json()) as Session[];
  }

  async createSession(ref: ServerRef, spec: SessionSpec): Promise<Session> {
    const res = await this.fetchImpl(`${ensureBaseUrl(ref)}/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(ref),
      body: JSON.stringify(spec),
    });
    await checkOk(res, 'createSession');
    return (await res.json()) as Session;
  }

  async getSession(ref: ServerRef, id: string): Promise<Session> {
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}`,
      { headers: authHeaders(ref) },
    );
    await checkOk(res, 'getSession');
    return (await res.json()) as Session;
  }

  async killSession(ref: ServerRef, id: string): Promise<void> {
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: authHeaders(ref) },
    );
    await checkOk(res, 'killSession');
  }

  async resizeSession(
    ref: ServerRef,
    id: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    const body: ResizeRequest = { cols, rows };
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}/resize`,
      { method: 'POST', headers: authHeaders(ref), body: JSON.stringify(body) },
    );
    await checkOk(res, 'resizeSession');
  }

  async fetchOutput(
    ref: ServerRef,
    id: string,
    fromOffset: number,
    limit?: number,
  ): Promise<FetchOutputResult> {
    const params = new URLSearchParams({ from: String(fromOffset) });
    if (limit != null) params.set('limit', String(limit));
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}/output?${params.toString()}`,
      { headers: authHeaders(ref) },
    );
    await checkOk(res, 'fetchOutput');
    return (await res.json()) as FetchOutputResult;
  }

  subscribe(
    ref: ServerRef,
    id: string,
    handlers: SubscribeHandlers,
  ): Subscription {
    const url = `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}/stream`;
    const connection = openEventSource(
      url,
      { Authorization: `Bearer ${ref.token}` },
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
    );
    return { close: () => connection.close() };
  }

  async sendInput(ref: ServerRef, id: string, data: Uint8Array): Promise<void> {
    const body: InputRequest = { data: bytesToBase64(data) };
    const res = await this.fetchImpl(
      `${ensureBaseUrl(ref)}/v1/sessions/${encodeURIComponent(id)}/input`,
      { method: 'POST', headers: authHeaders(ref), body: JSON.stringify(body) },
    );
    await checkOk(res, 'sendInput');
  }
}

export function createHttpSseTransport(): HttpSseTransport {
  return new HttpSseTransport();
}
