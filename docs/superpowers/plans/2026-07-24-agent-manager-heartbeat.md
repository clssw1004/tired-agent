# Agent-Manager 心跳机制 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 定期向 Manager 发送心跳，Manager 追踪存活状态并在 Web 前端展示

**Architecture:** Agent 每 30s POST 心跳到 Manager 公共端点，Manager 在内存中维护 `agentId → AgentHeartbeatInfo` 映射，`GET /api/v1/manager/agents` 返回附带在线状态，Web 前端 AgentCard 显示状态指示器。

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React

## Global Constraints

- 所有心跳状态信息存储在内存（不持久化到 DB）
- 除非 Manager 删除 Agent，否则心跳记录永不自动删除
- Agent 心跳自动启动（已注册即有）
- 离线超时 90 秒
- 心跳间隔 30 秒
- Protocol 包优先构建

---

### Task 1: Protocol 包 — 新增心跳类型和常量

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/protocol/src/constants.ts`

**Interfaces:**
- Produces: `HeartbeatRequest`, `HeartbeatResponse` 类型, `HEARTBEAT_PATH` 常量

- [ ] **Step 1: 在 `types.ts` 新增心跳请求/响应类型**

在 `packages/protocol/src/types.ts` 文件末尾添加：

```typescript
/** Heartbeat request payload sent by agent to manager. */
export interface HeartbeatRequest {
  /** Agent 软件版本, e.g. "0.1.19" */
  version?: string;
  /** Agent 主机名 */
  hostname?: string;
  /** Agent 进程已运行秒数 (process.uptime()) */
  uptime?: number;
}

/** Heartbeat response from manager. */
export interface HeartbeatResponse {
  status: 'ok';
  ts: number;
  managerVersion: string;
}
```

- [ ] **Step 2: 在 `constants.ts` 新增心跳路径常量**

```typescript
export const API_PREFIX = '/api/v1' as const;
/** 心跳端点路径（拼接在 manager 的 baseUrl 后使用） */
export const HEARTBEAT_PATH = `${API_PREFIX}/manager/heartbeat` as const;
```

- [ ] **Step 3: 验证构建**

```bash
cd C:\wspec\tired-agent
npm run build:protocol
```

Expected: 构建成功，无类型错误。

- [ ] **Step 4: 提交**

```bash
git add packages/protocol/src/types.ts packages/protocol/src/constants.ts
git commit -m "feat(protocol): add heartbeat types and HEARTBEAT_PATH constant"
```

---

### Task 2: Manager — Storage 新增 findAgentByToken

**Files:**
- Modify: `packages/manager/src/storage.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Storage.findAgentByToken(token: string): Agent | undefined`

- [ ] **Step 1: 在 Storage 接口和实现中新增 `findAgentByToken`**

在 `packages/manager/src/storage.ts`：

接口部分（约第 66 行 `listAgents(): Agent[];` 附近）添加：

```typescript
  /** 通过 bearer token 查找 Agent（用于心跳认证）。 */
  findAgentByToken(token: string): Agent | undefined;
```

实现部分（`registerAgent` 方法后，约第 297 行）添加实现：

```typescript
  function findAgentByToken(token: string): Agent | undefined {
    const row: any = db()
      .prepare('SELECT id, agent_key, name, baseUrl, token, enabled, createdAt FROM manager_agents WHERE token = ?')
      .get(token);
    return row ? deserializeAgent(row) : undefined;
  }
```

在返回对象（return 语句）中添加 `findAgentByToken`。

- [ ] **Step 2: 验证构建**

```bash
npm run build:manager
```

Expected: 构建成功。

- [ ] **Step 3: 提交**

```bash
git add packages/manager/src/storage.ts
git commit -m "feat(manager): add findAgentByToken for heartbeat auth"
```

---

### Task 3: Manager — HeartbeatTracker 类 + 测试

**Files:**
- Create: `packages/manager/src/heartbeat.ts`
- Test: （暂无独立测试文件，后续可以加）

**Interfaces:**
- Produces: `HeartbeatTracker` 类 — `beat()`, `getStatus()`, `enrichAgents()`, `removeAgent()`

- [ ] **Step 1: 创建 `heartbeat.ts`**

创建 `packages/manager/src/heartbeat.ts`：

```typescript
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
```

- [ ] **Step 2: 验证构建**

```bash
npm run build:manager
```

Expected: 构建成功，无类型错误。

- [ ] **Step 3: 提交**

```bash
git add packages/manager/src/heartbeat.ts
git commit -m "feat(manager): add HeartbeatTracker for agent liveness tracking"
```

---

### Task 4: Manager — 心跳端点 + 路由整合

**Files:**
- Modify: `packages/manager/src/routes/agents.ts`
- Modify: `packages/manager/src/auth.ts`
- Modify: `packages/manager/src/app.ts`
- Modify: `packages/manager/src/index.ts`

**Dependencies:**
- Consumes: `HeartbeatTracker` (Task 3), `Storage.findAgentByToken()` (Task 2), `HeartbeatRequest`, `HEARTBEAT_PATH` (Task 1)
- Produces: `POST /api/v1/manager/heartbeat`, `GET /api/v1/manager/agents` 附带状态增强

- [ ] **Step 1: 修改 `routes/agents.ts` — 新增心跳路由，修改 listAgents**

读取 `packages/manager/src/routes/agents.ts` 了解当前代码，然后：

1. 在 `registerAgentRoutes` 函数的 `listAgents` 路由中，调用 `heartbeatTracker.enrichAgents()` 包裹结果
2. 新增 `registerHeartbeatRoute` 函数

```typescript
import type { HeartbeatTracker } from '../heartbeat.js';
import { API_PREFIX, HEARTBEAT_PATH } from '@tired-agent/protocol';
import type { HeartbeatRequest } from '@tired-agent/protocol';

export function registerAgentRoutes(
  scoped: FastifyInstance,
  storage: Storage,
  heartbeatTracker: HeartbeatTracker,
): void {
  // 修改：listAgents 路由 handler，在返回前调用 heartbeatTracker.enrichAgents()
  scoped.get('/manager/agents', async (_req, reply) => {
    const agents = storage.listAgents();
    const enriched = heartbeatTracker.enrichAgents(agents);
    return reply.code(200).send(enriched);
  });

  // ... 其他现有路由（post, delete）

  // 新增：心跳端点
  registerHeartbeatRoute(scoped, storage, heartbeatTracker);
}

export function registerHeartbeatRoute(
  scoped: FastifyInstance,
  storage: Storage,
  heartbeatTracker: HeartbeatTracker,
): void {
  scoped.post('/manager/heartbeat', async (req, reply) => {
    // 1. 从 Authorization header 提取 agent token
    const header = req.headers['authorization'] ?? '';
    let token = '';
    if (header.toLowerCase().startsWith('bearer ')) {
      token = header.slice(7).trim();
    }

    if (!token) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'missing bearer token' },
      });
    }

    // 2. 通过 token 查找 Agent
    const agent = storage.findAgentByToken(token);
    if (!agent) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'invalid agent token' },
      });
    }

    // 3. 解析请求体（可选字段）
    const body = req.body as HeartbeatRequest | undefined;

    // 4. 记录心跳
    heartbeatTracker.beat(agent.id, {
      version: body?.version,
      hostname: body?.hostname,
      uptime: body?.uptime,
      remoteAddress: req.ip,
    });

    // 5. 返回
    return reply.code(200).send({
      status: 'ok' as const,
      ts: Date.now(),
      managerVersion: '0.1.19',
    });
  });
}
```

注意：`managerVersion` 应从包的实际版本读取。读取 `packages/manager/src/config.ts` 看是否有版本常量可用。如果没有，可以先硬编码 `0.1.19` 或从 `package.json` 导入。如果有现成的版本变量，使用它。

- [ ] **Step 2: 在 `auth.ts` 的 `PUBLIC_PATHS` 中添加心跳端点**

```typescript
const PUBLIC_PATHS = new Set<string>([
  '/health',
  `${API_PREFIX}/manager/auth/login`,
  `${API_PREFIX}/manager/auth/refresh`,
  `${API_PREFIX}/manager/agents/register`,
  `${API_PREFIX}/manager/heartbeat`,  // 新增
]);
```

- [ ] **Step 3: 修改 `app.ts` — 传递 HeartbeatTracker**

```typescript
import type { HeartbeatTracker } from './heartbeat.js';

export async function createApp(
  cfg: ManagerConfig,
  storage: Storage,
  heartbeatTracker: HeartbeatTracker,  // 新增参数
): Promise<FastifyInstance> {
  // ... 现有代码 ...

  app.register(async (scoped) => {
    registerAuthRoutes(scoped, storage, cfg);
    registerAgentRoutes(scoped, storage, heartbeatTracker);  // 传入 heartbeatTracker
    registerProxyRoutes(scoped, storage);
  }, { prefix: API_PREFIX });

  // ... 其余代码 ...
}
```

- [ ] **Step 4: 修改 `index.ts` — 创建 HeartbeatTracker 实例**

```typescript
import { HeartbeatTracker } from './heartbeat.js';

async function main() {
  // ... 现有初始化逻辑 ...

  const heartbeatTracker = new HeartbeatTracker();

  // 传入 createApp
  const app = await createApp(cfg, storage, heartbeatTracker);

  // ... app.listen() ...

  // 后续 shutdown 时不需要特殊清理（内存数据不持久化）
}
```

- [ ] **Step 5: 验证构建**

```bash
npm run build:manager
```

Expected: 构建成功。

- [ ] **Step 6: 提交**

```bash
git add packages/manager/src/routes/agents.ts packages/manager/src/auth.ts packages/manager/src/app.ts packages/manager/src/index.ts
git commit -m "feat(manager): add heartbeat endpoint and agent liveness status"
```

---

### Task 5: Agent — 心跳发送逻辑

**Files:**
- Create: `packages/agent/src/heartbeat.ts`
- Modify: `packages/agent/src/config.ts`
- Modify: `packages/agent/src/index.ts`

**Dependencies:**
- Consumes: `HeartbeatRequest`, `HEARTBEAT_PATH`, `API_PREFIX` (Task 1), `ServerConfig.managerUrl`/`agentId`

- [ ] **Step 1: 创建 `packages/agent/src/heartbeat.ts`**

```typescript
/**
 * Agent heartbeat sender.
 *
 * Sends periodic POST requests to the manager to report liveness.
 * Started automatically when the agent is registered with a manager.
 */

import { API_PREFIX, HEARTBEAT_PATH } from '@tired-agent/protocol';

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
        'Authorization': `Bearer ${opts.token}`,
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
```

- [ ] **Step 2: 修改 `config.ts` — 新增字段**

查看 `packages/agent/src/config.ts`，在 `ServerConfig` 接口中新增：

```typescript
export interface ServerConfig {
  // ... 现有字段 ...

  /** Agent ID assigned by the manager during registration. */
  agentId?: string;
  /** Manager base URL for heartbeat and management. */
  managerUrl?: string;
}
```

并在 `loadConfig()` 函数中从凭据文件读取这些字段。查看现有凭据文件读取逻辑（可能在 `register.ts` 或 `cli.ts` 中），读取 `.agent-credentials` JSON 文件：

```typescript
// 在 loadConfig() 中，读取凭据文件以获取 managerUrl 和 agentId
const credentialsPath = join(dataDir, '.agent-credentials');
try {
  const credsRaw = readFileSync(credentialsPath, 'utf-8');
  const creds = JSON.parse(credsRaw);
  if (creds.managerUrl) cfg.managerUrl = creds.managerUrl;
  if (creds.agentId) cfg.agentId = creds.agentId;
  if (creds.token) cfg.token = creds.token; // 已有 token 逻辑但确认使用管理器的 token
} catch {
  // 没有凭据文件 → 未注册，静默忽略
}
```

> 注意：需要 `import { readFileSync } from 'node:fs'`

- [ ] **Step 3: 修改 `index.ts` — 集成心跳**

```typescript
import { startHeartbeat } from './heartbeat.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 在 main() 中，app.listen 成功后：
async function main() {
  // ... 现有逻辑 ...

  // 尝试读取凭据并启动心跳
  try {
    const credsPath = join(dataDir, '.agent-credentials');
    const credsRaw = readFileSync(credsPath, 'utf-8');
    const creds = JSON.parse(credsRaw);

    if (creds.managerUrl && creds.agentId) {
      const stopHeartbeat = startHeartbeat({
        managerUrl: creds.managerUrl,
        agentId: creds.agentId,
        token: creds.token,
        name: cfg.name,
        version: '0.1.19',  // 硬编码版本，或从 package.json 导入
      });

      // 注册关闭时停止心跳
      registerShutdown(() => stopHeartbeat());
    }
  } catch {
    // 未注册 → 不启动心跳
  }
}
```

> 注意：`registerShutdown` 可能接受一个回调或需要在 shutdown.ts 中整合。查看 `packages/agent/src/shutdown.ts` 了解现有的关闭逻辑。

- [ ] **Step 4: 验证构建**

```bash
npm run build:agent
```

Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/heartbeat.ts packages/agent/src/config.ts packages/agent/src/index.ts
git commit -m "feat(agent): add heartbeat sender to report liveness to manager"
```

---

### Task 6: Web 前端 — AgentCard 显示存活状态

**Files:**
- Modify: `packages/web/src/components/AgentCard.tsx`
- Modify: `packages/web/src/styles.css`

**Dependencies:**
- Consumes: Manager API 返回的 `Agent` 对象现在包含 `state`, `lastSeen`, `version`, `hostname`, `agentUptime`, `beatCount`, `remoteAddress`

- [ ] **Step 1: 读取当前 AgentCard 和 ServerListPage 代码**

```bash
cat packages/web/src/components/AgentCard.tsx
cat packages/web/src/pages/ServerListPage.tsx
```

了解现有的卡片结构和 props 类型。

- [ ] **Step 2: 修改 AgentCard 显示状态**

在 `AgentCard.tsx` 中：

1. 扩展接口/类型以包含心跳字段：

```typescript
interface AgentCardProps {
  id: string;
  name: string;
  baseUrl: string;
  // 新增字段
  state?: 'online' | 'offline' | 'unknown';
  lastSeen?: number | null;
  version?: string | null;
  hostname?: string | null;
  agentUptime?: number | null;
  beatCount?: number;
}
```

2. 在卡片头部或右上角添加状态指示器：

```tsx
function getStateLabel(state: string, lastSeen: number | null): string {
  if (state === 'online') return '在线';
  if (state === 'offline' && lastSeen) {
    const seconds = Math.floor((Date.now() - lastSeen) / 1000);
    if (seconds < 120) return `${seconds} 秒前离线`;
    return `离线 ${Math.floor(seconds / 60)} 分钟`;
  }
  return '未知';
}

// 在卡片内部：
<div className="agent-card">
  <div className="agent-card-header">
    <span className={`agent-state-dot agent-state-${state ?? 'unknown'}`} />
    <span className="agent-state-label">
      {getStateLabel(state ?? 'unknown', lastSeen ?? null)}
    </span>
  </div>
  <div className="agent-card-body">
    <h3>{name}</h3>
    <p className="agent-url">{baseUrl}</p>

    {/* 可选：折叠的详细信息 */}
    {state !== 'unknown' && (
      <div className="agent-card-details">
        {version && <span>v{version}</span>}
        {hostname && <span>{hostname}</span>}
        {agentUptime != null && (
          <span>运行 {Math.floor(agentUptime / 3600)}h</span>
        )}
        {beatCount != null && <span>心跳 ×{beatCount}</span>}
      </div>
    )}
  </div>
</div>
```

- [ ] **Step 3: 添加 CSS 样式**

在 `packages/web/src/styles.css` 添加：

```css
/* ── Agent card status ──────────────────────────────────── */

.agent-state-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  flex-shrink: 0;
}
.agent-state-online {
  background: #51cf66;
  box-shadow: 0 0 4px rgba(81, 207, 102, 0.5);
}
.agent-state-offline {
  background: #ff6b6b;
}
.agent-state-unknown {
  background: #6c6c80;
}

.agent-state-label {
  font-size: 12px;
  color: var(--text-secondary, #888);
}

.agent-card-details {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-secondary, #888);
}
```

- [ ] **Step 4: 在 ServerListPage.tsx 中将状态字段传递给 AgentCard**

查看 `packages/web/src/pages/ServerListPage.tsx` 中现有的 mapping 代码，确保这些新字段从 API 响应传递到 `AgentCard`。

```tsx
// 在 ServerListPage 的 map/render 中：
<AgentCard
  id={agent.id}
  name={agent.name}
  baseUrl={agent.baseUrl}
  state={agent.state}
  lastSeen={agent.lastSeen}
  version={agent.version}
  hostname={agent.hostname}
  agentUptime={agent.agentUptime}
  beatCount={agent.beatCount}
/>
```

- [ ] **Step 5: 验证构建**

```bash
npm run build:protocol
npm run build:web
```

Expected: 构建成功。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/components/AgentCard.tsx packages/web/src/pages/ServerListPage.tsx packages/web/src/styles.css
git commit -m "feat(web): show agent online/offline status in AgentCard"
```

---

### Task 7: 端到端验证

**Files:** 无代码变更，纯手动验证

- [ ] **Step 1: 构建所有包**

```bash
npm run build:protocol
npm run build:manager
npm run build:agent
npm run build:web
```

Expected: 所有包构建成功。

- [ ] **Step 2: 启动 Manager 并验证心跳端点**

```bash
# 终端 1：启动 Manager
node packages/manager/dist/index.js --port 8443 --token admin-token-12345678
```

```bash
# 终端 2：检查 Manager /health
curl -s http://localhost:8443/health | jq .
# → { "status": "ok", "ts": ... }

# 检查 agents 列表（应该为空）
curl -s http://localhost:8443/api/v1/manager/agents -H "Authorization: Bearer admin-token-12345678" | jq .
# → []
```

- [ ] **Step 3: 注册并启动 Agent**

```bash
# 终端 3：注册 Agent（之前先生成一个注册 token）
# 或通过 Manager 的 /onboarding 生成注册命令
node packages/agent/dist/cli.js start --port 8444 --token test-token --register "<base64_string>"
```

- [ ] **Step 4: 验证心跳上报**

等 5 秒让首次心跳发送，然后：

```bash
curl -s http://localhost:8443/api/v1/manager/agents -H "Authorization: Bearer admin-token-12345678" | jq .
```

Expected：看到一个 agent，`state` 为 `"online"`，`version`、`hostname`、`lastSeen`、`beatCount` 等字段正常填充。

- [ ] **Step 5: 停止 Agent 验证离线检测**

```bash
node packages/agent/dist/cli.js stop
# 等待 95 秒（超过 90s 超时）
sleep 95
curl -s http://localhost:8443/api/v1/manager/agents -H "Authorization: Bearer admin-token-12345678" | jq '.[0].state'
```

Expected：`"offline"`

- [ ] **Step 6: 重新启动 Agent 验证恢复**

```bash
node packages/agent/dist/cli.js start
sleep 5
curl -s http://localhost:8443/api/v1/manager/agents -H "Authorization: Bearer admin-token-12345678" | jq '.[0].state'
```

Expected：`"online"`

- [ ] **Step 7: 验证 Web 前端展示**

启动 Vite dev server，在浏览器中打开 ServerListPage，确认 AgentCard 显示正确的状态指示器。

```bash
npm run dev:web
```
