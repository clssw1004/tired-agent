/**
 * AuthContext — Manager-based authentication with dual-token sliding refresh.
 *
 * Token model (OAuth 2.0 style):
 *   - sessionToken（内存，1h）：所有 manager 请求的 Bearer，到期前自动 refresh
 *   - refreshToken（localStorage，30d）：唯一持久化，用于换 sessionToken，滑动续期
 *
 * 持久化 key 不变（向后兼容）：
 *   - `tired-agent:manager-base-url`    —— baseUrl（与旧版一致）
 *   - `tired-agent:manager-session-token` —— 旧版 sessionToken 仍存（不做有效负载），
 *     占位。新 token 体系下不影响业务，后续轮次可清理。
 *   - `tired-agent:manager-refresh-token` —— 新增：唯一持久化的 refreshToken。
 *
 * 自动续期触发：
 *   1. mount 后起 1h interval 检查 sessionToken 寿命
 *   2. visibilitychange visible → 补查一次
 *   3. 每次 build 请求前确保 fresh（由 caller 自行调 ensureFreshSession 或
 *      在每个 manager API 调用前隐式检查）
 *
 * 并发合并：同一 refreshToken 的 refresh 请求正在 inflight 时，后续 await 复用。
 */

import { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
  | 'needs-credentials'
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
  /** Atomic: set base URL + login in one call. */
  connectAndLogin(url: string, token: string): Promise<void>;
  login(token: string): Promise<void>;
  logout(): void;
  refreshAgents(): Promise<void>;
  addAgent(name: string, baseUrl: string, token: string): Promise<void>;
  deleteAgent(id: string): Promise<void>;
}

const BASE_URL_KEY = 'tired-agent:manager-base-url';
const REFRESH_TOKEN_KEY = 'tired-agent:manager-refresh-token';
// 旧 key 仍在写入以保证降级兼容，但不再作为身份源。
const LEGACY_SESSION_KEY = 'tired-agent:manager-session-token';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;  // 5 分钟提前窗口
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 小时主动检查

function makeManagerRef(baseUrl: string, token: string | null): ServerRef {
  return { id: 'manager', name: 'Manager', baseUrl, token: token ?? '' };
}

const AuthContext = createContext<AuthState | null>(null);

// ── Refresh state (module-level, so timer + inflight dedup 不与 React 重渲染深度绑定) ──

let _refreshToken: string | null = null;
let _sessionToken: string | null = null;
let _sessionExpiresAtMs = 0;
let _inflightRefresh: Promise<void> | null = null;

export function getManagerSessionToken(): string | null { return _sessionToken; }

/**
 * 确保当前 sessionToken 有效；必要时静默 refresh。
 * 此函数可从 AuthContext 外部调用（如在 transport 包装器或 hooks 中）。
 */
export async function ensureFreshSession(): Promise<void> {
  const remaining = _sessionExpiresAtMs - Date.now();
  if (_sessionToken && remaining > REFRESH_WINDOW_MS) return;
  if (!_refreshToken || !getBaseUrl()) throw new Error('unauthorized');

  if (!_inflightRefresh) {
    _inflightRefresh = (async () => {
      const mgrRef = makeManagerRef(getBaseUrl()!, _refreshToken!);
      const res = await transport.refreshSession(mgrRef, _refreshToken!);
      _sessionToken = res.sessionToken;
      _sessionExpiresAtMs = Date.now() + res.sessionExpiresIn * 1000;
      _refreshToken = res.refreshToken;
      // 新的 refreshToken 持久化
      localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
      // 旧 sessionToken 字段写占位（向后兼容）
      localStorage.setItem(LEGACY_SESSION_KEY, res.sessionToken);
    })().finally(() => {
      _inflightRefresh = null;
    });
  }
  await _inflightRefresh;
}

// 用于读取在模块作用域外调用 setBaseUrl 后的值（略笨但无循环依赖）
let _globalBaseUrl: string | null = null;
function getBaseUrl(): string | null { return _globalBaseUrl; }
function setBaseUrl(v: string | null) { _globalBaseUrl = v; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [managerBaseUrl, setManagerBaseUrlState] = useState<string | null>(
    () => localStorage.getItem(BASE_URL_KEY),
  );
  // sessionToken 不再用于 useState 驱动——UI 需要实时更新时走 sessionToken 的 setState
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [status, setStatus] = useState<AuthStatus>('uninitialized');
  const [error, setError] = useState<string | null>(null);
  const refreshIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 同步模块级 _globalBaseUrl
  useEffect(() => { setBaseUrl(managerBaseUrl); }, [managerBaseUrl]);

  // ── refresh timer ─────────────────────────────────────────────────────────

  const doRefresh = useCallback(async () => {
    try {
      await ensureFreshSession();
      setSessionToken(_sessionToken);
    } catch {
      // 连续 refresh 失败不主动踢（避免 timer 与用户操作冲突），
      // 等实际请求回来触发 401 再走 logout。
    }
  }, []);

  // mount 时起 timer；unmount 清
  useEffect(() => {
    refreshIntervalRef.current = setInterval(doRefresh, REFRESH_INTERVAL_MS);
    return () => {
      if (refreshIntervalRef.current) clearInterval(refreshIntervalRef.current);
    };
  }, [doRefresh]);

  // visibilitychange: 回来时 refresh 一次
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') void doRefresh();
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [doRefresh]);

  // ── refreshAgents ─────────────────────────────────────────────────────────

  const refreshAgents = useCallback(async () => {
    if (!managerBaseUrl) { setAgents([]); return; }
    const ref = makeManagerRef(managerBaseUrl, _sessionToken);
    const list = await transport.listAgents(ref);
    setAgents(list);
  }, [managerBaseUrl]);

  // ── setManagerBaseUrl ─────────────────────────────────────────────────────

  const setManagerBaseUrlFn = useCallback((url: string) => {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (!trimmed) return;
    localStorage.setItem(BASE_URL_KEY, trimmed);
    setManagerBaseUrlState(trimmed);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    setSessionToken(null);
    setAgents([]);
    setStatus('needs-credentials');
    setError(null);
  }, []);

  // ── login ─────────────────────────────────────────────────────────────────

  const login = useCallback(
    async (token: string, baseUrlOverride?: string) => {
      const baseUrl = baseUrlOverride ?? managerBaseUrl;
      if (!baseUrl) {
        setStatus('needs-credentials');
        throw new Error('Manager base URL is not set');
      }
      setStatus('logging-in');
      setError(null);
      try {
        const ref = makeManagerRef(baseUrl, null);
        const res = await transport.login(ref, token);

        // 内存 token + 过期时间
        _sessionToken = res.sessionToken;
        _sessionExpiresAtMs = Date.now() + res.sessionExpiresIn * 1000;

        // 持久化 refreshToken
        _refreshToken = res.refreshToken;
        localStorage.setItem(REFRESH_TOKEN_KEY, res.refreshToken);
        localStorage.setItem(LEGACY_SESSION_KEY, res.sessionToken); // 向后兼容

        setSessionToken(res.sessionToken);

        const list = await transport.listAgents(makeManagerRef(baseUrl, res.sessionToken));
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

  const connectAndLogin = useCallback(
    async (url: string, token: string) => {
      const cleanUrl = url.trim().replace(/\/+$/, '');
      if (!cleanUrl) {
        setStatus('needs-credentials');
        throw new Error('Manager URL is required');
      }
      localStorage.setItem(BASE_URL_KEY, cleanUrl);
      setManagerBaseUrlState(cleanUrl);
      setAgents([]);
      await login(token, cleanUrl);
    },
    [login],
  );

  // ── logout ────────────────────────────────────────────────────────────────

  const logout = useCallback(() => {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    _refreshToken = null;
    _sessionToken = null;
    _sessionExpiresAtMs = 0;
    setSessionToken(null);
    setAgents([]);
    setStatus('needs-credentials');
    setError(null);
  }, []);

  // ── addAgent / deleteAgent ────────────────────────────────────────────────

  const addAgent = useCallback(
    async (name: string, baseUrl: string, token: string) => {
      if (!managerBaseUrl) throw new Error('Not logged in');
      await ensureFreshSession();
      const ref = makeManagerRef(managerBaseUrl, _sessionToken);
      await transport.addAgent(ref, { name, baseUrl, token });
      await refreshAgents();
    },
    [managerBaseUrl, refreshAgents],
  );

  const deleteAgent = useCallback(
    async (id: string) => {
      if (!managerBaseUrl) throw new Error('Not logged in');
      await ensureFreshSession();
      const ref = makeManagerRef(managerBaseUrl, _sessionToken);
      await transport.deleteAgent(ref, id);
      await refreshAgents();
    },
    [managerBaseUrl, refreshAgents],
  );

  // ── Boot ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!managerBaseUrl) {
        if (!cancelled) setStatus('needs-credentials');
        return;
      }

      // 从 localStorage 读 refreshToken
      const rt = localStorage.getItem(REFRESH_TOKEN_KEY);
      if (!rt) {
        if (!cancelled) setStatus('needs-credentials');
        return;
      }
      _refreshToken = rt;

      try {
        // 用 refreshToken 换 sessionToken
        await ensureFreshSession();
        if (cancelled) return;
        setSessionToken(_sessionToken);

        const list = await transport.listAgents(makeManagerRef(managerBaseUrl, _sessionToken));
        if (cancelled) return;
        setAgents(list);
        setStatus('logged-in');
      } catch {
        if (cancelled) return;
        localStorage.removeItem(REFRESH_TOKEN_KEY);
        _refreshToken = null;
        _sessionToken = null;
        setSessionToken(null);
        setStatus('needs-credentials');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      managerBaseUrl,
      sessionToken,
      agents,
      status,
      error,
      setManagerBaseUrl: setManagerBaseUrlFn,
      connectAndLogin,
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
      setManagerBaseUrlFn,
      connectAndLogin,
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
