/**
 * Shared route-prefix constant for all tired-agent services.
 *
 * Both the manager and the agent mount their API routes under this prefix.
 * Consumers (HttpSseTransport, Vite proxy, etc.) reference the same constant
 * so a one-line change re-prefixes everything.
 */
export const API_PREFIX = '/api/v1' as const;
