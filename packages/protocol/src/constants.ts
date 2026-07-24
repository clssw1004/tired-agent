/**
 * Shared route-prefix constant for all tired-agent services.
 *
 * Both the manager and the agent mount their API routes under this prefix.
 * Consumers (HttpSseTransport, Vite proxy, etc.) reference the same constant
 * so a one-line change re-prefixes everything.
 */
export const API_PREFIX = '/api/v1' as const;
/** 心跳端点路径（拼接在 manager 的 baseUrl 后使用） */
export const HEARTBEAT_PATH = `${API_PREFIX}/manager/heartbeat` as const;
