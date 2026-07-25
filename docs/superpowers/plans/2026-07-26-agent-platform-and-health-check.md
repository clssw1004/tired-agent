# Agent 平台信息上报 + Manager 主动健康轮询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 上报 OS 平台信息并持久化，Manager 主动轮询 agent /health 替代心跳推送

**Architecture:** 三模块联动：协议层新增 PlatformInfo 类型 → Agent 注册时 + /health 返回平台信息、优化 IP 检测 → Manager 主动轮询替代心跳、状态持久化

**Tech Stack:** Node.js, Fastify, SQLite, TypeScript

---

### Task 1: Protocol 层新增 PlatformInfo 类型

**Files:**
- Modify: `packages/protocol/src/types.ts`

**Interfaces:**
- Consumes: 无
- Produces: `PlatformInfo` 接口, `#HealthResponse` 文档注释

- [ ] **Step 1: 添加 PlatformInfo 接口**

在 `packages/protocol/src/types.ts` 的 `HeartbeatRequest` 上方插入：

```typescript
/** OS 平台信息 */
export interface PlatformInfo {
  /** 操作系统类型：'win32' | 'linux' | 'darwin' */
  os: string;
  /** CPU 架构：'x64' | 'arm64' | 'ia32' */
  arch: string;
  /** 版本号，如 '10.0.26200'、'6.1.7601' */
  release: string;
}
```

- [ ] **Step 2: HeartbeatRequest 增加 platform**

```typescript
export interface HeartbeatRequest {
  version?: string;
  hostname?: string;
  uptime?: number;
  /** Agent 操作系统平台信息 */
  platform?: PlatformInfo;
}
```

- [ ] **Step 3: 提交**

```bash
git add packages/protocol/src/types.ts
git commit -m "feat(protocol): add PlatformInfo type"
```

---

### Task 2: Agent — 注册时上报平台信息

**Files:**
- Modify: `packages/agent/src/register.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: `PlatformInfo` (from protocol), `ServerConfig` (from config.ts)
- Produces: `registerWithManager()` 新增 platform 参数，注册 body 包含 platform

- [ ] **Step 1: `register.ts` — 修改 `registerWithManager()` 增加 platform 参数**

```typescript
export async function registerWithManager(
  managerUrl: string,
  name: string,
  agentBaseUrl: string,
  agentKey?: string,
  platform?: { os: string; arch: string; release: string },
): Promise<{ id: string; token: string; status?: string }> {
  const base = managerUrl.replace(/\/+$/, '');
  const url = `${base}${API_PREFIX}/manager/agents/register`;

  const body: Record<string, string | object> = {
    name,
    baseUrl: agentBaseUrl,
  };
  if (agentKey) body.agentKey = agentKey;
  if (platform) body.platform = platform;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`registration failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<{ id: string; token: string; status?: string }>;
}
```

- [ ] **Step 2: `register.ts` — 修改 `getOrRegisterCredentials()` 传入 platform**

在 `getOrRegisterCredentials()` 的 `advertiseHost` 行之后，找到 `registerWithManager` 调用：

```typescript
const advertiseHost = cfg.host === '0.0.0.0' ? detectLanIp() : cfg.host;
const agentBaseUrl = `http://${advertiseHost}:${cfg.port}`;
const platform = { os: process.platform, arch: os.arch(), release: os.release() };
const creds = await registerWithManager(
  payload.managerUrl,
  cfg.name,
  agentBaseUrl,
  agentKey,
  platform,
);
```

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/register.ts
git commit -m "feat(agent): send platform info during registration"
```

---

### Task 3: Agent — /health 端点返回平台信息

**Files:**
- Modify: `packages/agent/src/app.ts`

- [ ] **Step 1: app.ts 引入 os 模块**

在顶部 `import` 区域加入：

```typescript
import { platform, arch, release } from 'node:os';
```

- [ ] **Step 2: /health 端点增加 platform**

```typescript
app.get('/health', async (_req, reply) =>
  reply.code(200).send({
    status: 'ok',
    name: cfg.name,
    port: cfg.port,
    ts: Date.now(),
    platform: { os: platform(), arch: arch(), release: release() },
  }),
);
```

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/app.ts
git commit -m "feat(agent): add platform info to /health endpoint"
```

---

### Task 4: Agent — 删除心跳模块

**Files:**
- Delete: `packages/agent/src/heartbeat.ts`
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: 删除 `packages/agent/src/heartbeat.ts`**

```bash
git rm packages/agent/src/heartbeat.ts
```

- [ ] **Step 2: 修改 `packages/agent/src/index.ts` — 去掉 heartbeat 引用和启动逻辑**

删除 `import { startHeartbeat } from './heartbeat.js';`

找到 `index.ts` 第 144-150 行的 `stopHeartbeat` 相关代码：

```typescript
// Mutable reference so the heartbeat stop function can be set after
// registerShutdown captures it (heartbeat starts after app.listen).
let stopHeartbeat: (() => void) | undefined;

registerShutdown(app, storage, manager, () => {
  stopHeartbeat?.();
});
```

改为：

```typescript
registerShutdown(app, storage, manager, () => {
  // No heartbeat to stop
});
```

删除 `index.ts` 第 160-178 行的心跳启动代码（`const credentialsPath = ...` 到 `catch { ... }`）

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/index.ts
git commit -m "feat(agent): remove heartbeat module, manager now polls /health"
```

---

### Task 5: Manager — Storage 增加 platform 和 status 字段

**Files:**
- Modify: `packages/manager/src/storage.ts`

**Interfaces:**
- Produces: `Agent` 类型增加 status、platformOs/arch/release；`registerAgent()` 接受平台参数；新增 `updateAgentStatus()`、`updateAgentPlatform()`

- [ ] **Step 1: Agent 接口增加字段**

```typescript
export interface Agent {
  id: string;
  agentKey: string;
  name: string;
  baseUrl: string;
  token: string;
  enabled: boolean;
  createdAt: number;
  /** 注册状态：pending | online | offline */
  status: string;
  platformOs: string;
  platformArch: string;
  platformRelease: string;
}
```

- [ ] **Step 2: SQLite 表增加列 (init 内)**

在 `init()` 函数中，`manager_agents` 建表语句增加：

```typescript
db().exec(`
  CREATE TABLE IF NOT EXISTS manager_agents (
    id          TEXT PRIMARY KEY,
    agent_key   TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    baseUrl     TEXT NOT NULL,
    token       TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    createdAt   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    platform_os     TEXT NOT NULL DEFAULT '',
    platform_arch   TEXT NOT NULL DEFAULT '',
    platform_release TEXT NOT NULL DEFAULT ''
  );
  ...
`);
```

并在迁移段增加 ALTER TABLE（向后兼容已有 DB）：

```typescript
// Migration: add status and platform columns
const hasStatus = handle
  .prepare("SELECT 1 FROM pragma_table_info('manager_agents') WHERE name = 'status'")
  .get();
if (!hasStatus) {
  handle.exec(`ALTER TABLE manager_agents ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_os TEXT NOT NULL DEFAULT ''`);
  handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_arch TEXT NOT NULL DEFAULT ''`);
  handle.exec(`ALTER TABLE manager_agents ADD COLUMN platform_release TEXT NOT NULL DEFAULT ''`);
}
```

- [ ] **Step 3: 修改 `registerAgent()` 接受 platform**

```typescript
function registerAgent(
  name: string,
  baseUrl: string,
  agentKey?: string,
  platform?: { os: string; arch: string; release: string },
): { id: string; token: string; status: string } {
  // ... existing dedup logic ...
  // In all INSERT/UPDATE paths, add platform fields and status
  // e.g. UPDATE:
  db().prepare(
    'UPDATE manager_agents SET baseUrl = ?, name = ?, platform_os = ?, platform_arch = ?, platform_release = ? WHERE agent_key = ?',
  ).run(baseUrl, name, platform?.os ?? '', platform?.arch ?? '', platform?.release ?? '', agentKey);

  // INSERT:
  db().prepare(
    'INSERT INTO manager_agents (id, agent_key, name, baseUrl, token, enabled, createdAt, status, platform_os, platform_arch, platform_release) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
  ).run(newId, agentKeyFinal, name, baseUrl, token, createdAt, 'pending', platform?.os ?? '', platform?.arch ?? '', platform?.release ?? '');
  // Note: registerAgent returns { id, token, status: 'pending' }
  return { id: newId, token, status: 'pending' };
}
```

- [ ] **Step 4: 新增 `updateAgentStatus()` 和 `updateAgentPlatform()`**

```typescript
function updateAgentStatus(id: string, status: string): void {
  db().prepare('UPDATE manager_agents SET status = ? WHERE id = ?').run(status, id);
}

function updateAgentPlatform(id: string, os: string, arch: string, release: string): void {
  db().prepare(
    'UPDATE manager_agents SET platform_os = ?, platform_arch = ?, platform_release = ? WHERE id = ?',
  ).run(os, arch, release, id);
}
```

将它们添加到 `Storage` 接口声明和 `createStorage()` 的返回对象中。

- [ ] **Step 5: 更新 `deserializeAgent()`**

```typescript
function deserializeAgent(r: any): Agent {
  return {
    id: r.id,
    agentKey: r.agent_key ?? '',
    name: r.name,
    baseUrl: r.baseUrl,
    token: r.token,
    enabled: Boolean(r.enabled),
    createdAt: Number(r.createdAt),
    status: r.status ?? 'pending',
    platformOs: r.platform_os ?? '',
    platformArch: r.platform_arch ?? '',
    platformRelease: r.platform_release ?? '',
  };
}
```

- [ ] **Step 6: 提交**

```bash
git add packages/manager/src/storage.ts
git commit -m "feat(manager): add status and platform columns to manager_agents"
```

---

### Task 6: Manager — 创建 health-poller 模块

**Files:**
- Create: `packages/manager/src/health-poller.ts`

**Interfaces:**
- Consumes: `Storage` (接口中的 `listAgents()`, `updateAgentStatus()`, `updateAgentPlatform()`)
- Produces: `HealthPoller` 类

- [ ] **Step 1: 创建 `packages/manager/src/health-poller.ts`**

```typescript
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
              this.storage.updateAgentPlatform(
                agent.id,
                body.platform.os,
                body.platform.arch,
                body.platform.release,
              );
            }

            // Transition to online (idempotent)
            if (agent.status !== 'online') {
              this.storage.updateAgentStatus(agent.id, 'online');
              log.info({ agentId: agent.id, name: agent.name }, 'health-poller: agent online');
            }
          } else {
            // Agent returned non-2xx
            if (agent.status !== 'offline') {
              this.storage.updateAgentStatus(agent.id, 'offline');
              log.warn({ agentId: agent.id, name: agent.name, status: res.status }, 'health-poller: agent unhealthy');
            }
          }
        } catch (err) {
          // Network error or timeout
          if (agent.status !== 'offline') {
            this.storage.updateAgentStatus(agent.id, 'offline');
            log.warn({ agentId: agent.id, name: agent.name, err: (err as Error).message }, 'health-poller: agent unreachable');
          }
        }
      }),
    );
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add packages/manager/src/health-poller.ts
git commit -m "feat(manager): add HealthPoller for active /health polling"
```

---

### Task 7: Manager — 修改 routes/agents.ts

**Files:**
- Modify: `packages/manager/src/routes/agents.ts`

- [ ] **Step 1: RegisterAgentSchema 增加 platform**

```typescript
const RegisterAgentSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  agentKey: z.string().optional(),
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    release: z.string(),
  }).optional(),
});
```

- [ ] **Step 2: 注册端点存储 platform，返回 status**

```typescript
app.post('/manager/agents/register', async (req, reply) => {
  const parsed = RegisterAgentSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: { code: 'invalid_request', message: parsed.error.message },
    });
  }
  const { id, token, status } = storage.registerAgent(
    parsed.data.name,
    parsed.data.baseUrl,
    parsed.data.agentKey,
    parsed.data.platform,
  );
  return reply.code(201).send({ id, token, status });
});
```

- [ ] **Step 3: GET /manager/agents 列表返回平台信息**

```typescript
app.get('/manager/agents', async (_req, reply) => {
  const agents = storage.listAgents();
  const mapped = agents.map((a) => ({
    id: a.id,
    name: a.name,
    baseUrl: a.baseUrl,
    enabled: a.enabled,
    createdAt: a.createdAt,
    status: a.status,
    platform: a.platformOs
      ? { os: a.platformOs, arch: a.platformArch, release: a.platformRelease }
      : undefined,
  }));
  return reply.code(200).send(mapped);
});
```

- [ ] **Step 4: 移除 heartbeat 探测逻辑**

删除 `GET /manager/agents` 中的 `unknownAgents` 探测代码（当前第 60-84 行），以及 `heartbeatTracker` 的引用。不再需要 `HeartbeatRequest` 的 import。

- [ ] **Step 5: 移除 heartbeat 端点**

删除 `POST /manager/heartbeat` 路由（当前第 137-173 行）。

- [ ] **Step 6: 更新函数签名**

`registerAgentRoutes()` 去掉 `heartbeatTracker` 参数：

```typescript
export function registerAgentRoutes(app: FastifyInstance, storage: Storage): void {
```

去掉 `HeartbeatTracker` 和 `HeartbeatRequest` 的 import。

- [ ] **Step 7: 提交**

```bash
git add packages/manager/src/routes/agents.ts
git commit -m "feat(manager): add platform field, return status, remove heartbeat endpoint"
```

---

### Task 8: Manager — 修改 app.ts 和 index.ts

**Files:**
- Modify: `packages/manager/src/app.ts`
- Modify: `packages/manager/src/index.ts`

- [ ] **Step 1: app.ts — 去掉 heartbeatTracker 引用**

```typescript
export async function createApp(
  cfg: ManagerConfig,
  storage: Storage,
): Promise<FastifyInstance> {
```

去掉 `HeartbeatTracker` 的 import。

```typescript
app.register(async (scoped) => {
  registerAuthRoutes(scoped, storage, cfg);
  registerAgentRoutes(scoped, storage);  // no heartbeatTracker
  registerProxyRoutes(scoped, storage);
}, { prefix: API_PREFIX });
```

- [ ] **Step 2: index.ts — 用 HealthPoller 替代 HeartbeatTracker**

引入 HealthPoller：

```typescript
import { HealthPoller } from './health-poller.js';
```

去掉 `HeartbeatTracker` 的 import。

修改 `main()`：

```typescript
const healthPoller = new HealthPoller(storage);
healthPoller.start();

const app = await createApp(cfg, storage);

registerShutdown(app, storage, () => {
  healthPoller.stop();
});

await app.listen({ port: cfg.port, host: cfg.host });
```

- [ ] **Step 3: 提交**

```bash
git add packages/manager/src/app.ts packages/manager/src/index.ts
git commit -m "feat(manager): integrate HealthPoller, remove HeartbeatTracker"
```

---

### Task 9: Agent — 优化 detectLanIp()

**Files:**
- Modify: `packages/agent/src/register.ts`

- [ ] **Step 1: 新增 `detectBestLanIp()` 函数**

在 `detectLanIp()` 之后新增：

```typescript
import { createSocket } from 'node:dgram';

/**
 * 使用 UDP socket 路由探测获取最佳广告 IP。
 * 通过向 Manager 地址建立伪连接让内核选择出口网卡 IP，
 * 确保 Manager 可达。
 */
function detectBestLanIp(managerHost: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = createSocket('udp4');
    const timeout = setTimeout(() => {
      sock.close();
      // 超时回退到常规检测
      resolve(null);
    }, 2000);

    sock.once('error', () => {
      clearTimeout(timeout);
      sock.close();
      resolve(null);
    });

    sock.connect(1, managerHost, () => {
      clearTimeout(timeout);
      const ip = sock.localAddress;
      sock.close();
      resolve(ip || null);
    });
  });
}
```

- [ ] **Step 2: 增强常规 `detectLanIp()`**

过滤常见的虚拟网卡名称：

```typescript
export function detectLanIp(): string {
  const interfaces = networkInterfaces();
  const candidates: string[] = [];
  const virtualPattern = /^(docker|vEthernet|vbox|vmnet|br-|lo|tun|tap)/i;

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (virtualPattern.test(name)) continue; // 跳过虚拟网卡
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        candidates.push(addr.address);
      }
    }
  }

  for (const ip of candidates) {
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return ip;
    }
  }

  if (candidates.length > 0) return candidates[0];

  throw new Error(
    '无法自动检测可用的非回环 IP 地址。请通过 --host 参数手动指定广告 IP。',
  );
}
```

- [ ] **Step 3: 修改 `getOrRegisterCredentials()` 使用新检测**

```typescript
const advertiseHost = cfg.host === '0.0.0.0'
  ? await detectBestLanIp(new URL(payload.managerUrl).hostname) || detectLanIp()
  : cfg.host;
```

- [ ] **Step 4: 提交**

```bash
git add packages/agent/src/register.ts
git commit -m "feat(agent): improve detectLanIp with UDP routing and virtual NIC filter"
```

---

### Task 10: 清理并编译验证

- [ ] **Step 1: 清理残留引用**

检查是否有其他文件引用了被删除的 `heartbeat.ts` 或 `HeartbeatTracker`：

```bash
grep -r 'heartbeat' packages/ --include='*.ts' -l
```

如有遗漏引用，逐一清理。

- [ ] **Step 2: 编译验证**

```bash
npm run build:protocol && npm run build:manager && npm run build:agent
```

- [ ] **Step 3: 类型检查**

```bash
npm run typecheck
```
