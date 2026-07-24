# Agent-Manager 心跳机制设计文档

## 概述

为 tired-agent 的 Agent 和 Manager 服务增加心跳机制，使 Manager 能追踪 Agent 的存活状态，并让 Web 前端能直观地看到每个 Agent 的在线/离线状态。

## 需求

| 项目 | 决策 |
|------|------|
| 范围 | Agent → Manager 心跳 + 存活追踪 |
| 心跳间隔 | 30 秒发送一次 |
| 离线超时 | 90 秒未收到即标记离线 |
| 数据存储 | 内存追踪（不落 DB） |
| 启动行为 | 已注册的 Agent 自动开始心跳 |
| 状态保留 | 除非用户通过 Manager 删除 Agent，否则心跳信息永不删除 |
| Web 展示 | AgentCard 显示在线/离线状态及详细信息 |

## 架构

```
Agent ──POST /api/v1/manager/heartbeat──→ Manager
  │                                          │
  │  Body: { version, hostname, uptime }     │ 更新 HeartbeatTracker（内存 Map）
  │  Auth: Bearer <agent-token>              │ 每 30s 清理一次超时条目
  │                                          │
  │                               ┌──────────┘
  │                               ▼
  │                       GET /api/v1/manager/agents
  │                               │
  │                               ▼
  │                       Agent[] 附带在线状态
  │                               │
  │                               ▼
  │                       Web 前端 AgentCard
  │                       显示绿/红/灰状态点
```

## 详细设计

### 1. Protocol 包新增类型

**文件**: `packages/protocol/src/types.ts`

```typescript
/** Heartbeat request payload sent by agent to manager. */
export interface HeartbeatRequest {
  version?: string;    // Agent 软件版本, e.g. "0.1.19"
  hostname?: string;   // Agent 主机名
  uptime?: number;     // Agent 进程已运行秒数, process.uptime()
}

/** Heartbeat response from manager. */
export interface HeartbeatResponse {
  status: 'ok';
  ts: number;
  managerVersion: string;
}
```

**文件**: `packages/protocol/src/constants.ts`

```typescript
export const HEARTBEAT_PATH = `${API_PREFIX}/manager/heartbeat` as const;
```

### 2. Manager HeartbeatTracker

**新文件**: `packages/manager/src/heartbeat.ts`

#### AgentHeartbeatInfo 类型

```typescript
interface AgentHeartbeatInfo {
  lastSeen: number;            // 上次心跳时间戳
  firstSeenAt: number;         // 首次收到心跳时间戳
  version: string | null;      // Agent 版本
  hostname: string | null;     // Agent 主机名
  agentUptime: number | null;  // Agent 守护进程运行时长（秒）
  beatCount: number;           // 累计心跳次数
  remoteAddress: string | null;// Agent 出口 IP 地址
}
```

#### HeartbeatTracker 类

```typescript
class HeartbeatTracker {
  private store: Map<string, AgentHeartbeatInfo>;  // agentId → 心跳信息

  /** Agent 上报心跳时调用 */
  beat(agentId: string, info: {
    version?: string;
    hostname?: string;
    uptime?: number;
    remoteAddress?: string;
  }): void;

  /** 查询单个 Agent 的心跳状态 */
  getStatus(agentId: string): {
    state: 'online' | 'offline' | 'unknown';
    lastSeen: number | null;
    firstSeenAt: number | null;
    version: string | null;
    hostname: string | null;
    agentUptime: number | null;
    beatCount: number;
    remoteAddress: string | null;
  } | null;

  /** 批量附加心跳状态到 Agent 列表响应 */
  enrichAgents(agents: Agent[]): AgentHeartbeatEnriched[];

  /** 将 Agent 的心跳信息从追踪器中删除（Manager 删除 Agent 时调用） */
  removeAgent(agentId: string): void;
}
```

#### 状态计算规则

| 条件 | state |
|------|-------|
| `lastSeen === undefined`（从未收到心跳） | `unknown` |
| `lastSeen > now - 90_000`（90 秒内） | `online` |
| `lastSeen <= now - 90_000`（超过 90 秒） | `offline` |

> **注意**：`prune()` 方法**不再存在**——心跳记录从不自动删除。仅当 `DELETE /api/v1/manager/agents/:id` 被调用时，通过 `removeAgent()` 清理对应记录。

#### GET /api/v1/manager/agents 返回增强

每个 Agent 对象附加以下字段：

```typescript
{
  id, name, baseUrl, token, enabled, createdAt,  // 原有字段

  // ── 心跳状态 ──
  state: 'online' | 'offline' | 'unknown',
  lastSeen: number | null,
  firstSeenAt: number | null,
  version: string | null,
  hostname: string | null,
  agentUptime: number | null,
  beatCount: number,
  remoteAddress: string | null,
}
```

### 3. Manager 新增端点

#### POST /api/v1/manager/heartbeat

**认证**：通过 `Authorization: Bearer <agent-token>` 头验证，由 `storage.findAgentByToken()` 查找对应的 Agent。

**请求**：
```
POST /api/v1/manager/heartbeat
Authorization: Bearer <agent-token>
Content-Type: application/json

{
  "version": "0.1.19",
  "hostname": "my-server",
  "uptime": 12345
}
```

**响应 (200)**：
```json
{
  "status": "ok",
  "ts": 1721812345678,
  "managerVersion": "0.1.19"
}
```

**错误**：
- 401 — token 无效（找不到对应的 Agent）

**认证豁免**：添加心跳端点至 `PUBLIC_PATHS`（不需要 session token，通过 agent token 自身认证）。

### 4. Manager Storage 新增方法

**文件**: `packages/manager/src/storage.ts`

```typescript
/** 通过 bearer token 查找 Agent（用于心跳认证）。 */
findAgentByToken(token: string): Agent | undefined;
```

### 5. Manager 主流程整合

**文件**: `packages/manager/src/app.ts`

- `createApp()` 接收 `HeartbeatTracker` 参数
- 创建 `HeartbeatTracker` 实例
- 将心跳相关路由注册到 scoped 路由组

**文件**: `packages/manager/src/index.ts`

- 创建 `HeartbeatTracker` 实例

**文件**: `packages/manager/src/routes/agents.ts`

- `listAgents` 路由：调用 `heartbeatTracker.enrichAgents()`
- 新增 `registerHeartbeatRoute(scoped, storage, heartbeatTracker)` 函数
- `POST /manager/heartbeat` 路由处理

### 6. Agent 心跳发送

**新文件**: `packages/agent/src/heartbeat.ts`

```typescript
interface HeartbeatOptions {
  managerUrl: string;
  agentId: string;
  token: string;
  name: string;
  intervalMs: number;  // 30000
  version: string;
}

function startHeartbeat(opts: HeartbeatOptions): () => void;
function stopHeartbeat(): void;
```

**心跳发送逻辑**：
1. Agent 启动完成后（服务已监听），检查凭据
2. 已注册 → 立即发送第一次心跳，然后每 30s 循环发送
3. 发送失败（网络错误或 401）→ 静默记录日志，等待下次重试
4. 返回 stop 函数用于关闭时取消定时器

**文件**: `packages/agent/src/config.ts`

```typescript
export interface ServerConfig {
  // ... 现有字段
  agentId?: string;     // Manager 分配的 agentId（从凭据文件读取）
  managerUrl?: string;  // Manager base URL（从凭据文件读取，用于心跳）
}
```

**文件**: `packages/agent/src/index.ts`

- 启动后读取凭据文件 → 合并到 `ServerConfig`
- 成功 listen 后，如 `managerUrl` 存在则调用 `startHeartbeat()`
- 关闭流程中调用 `stopHeartbeat()`（通过 shutdown.ts 整合）

### 7. Web 前端 AgentCard

**文件**: `packages/web/src/components/AgentCard.tsx`

- `AgentCardProps` 新增 `state`, `lastSeen`, `version`, `hostname`, `agentUptime`, `beatCount` 字段
- 根据 `state` 渲染状态指示器：

| state | 指示器颜色 | 标签 |
|-------|-----------|------|
| `online` | 绿色圆点 (#51cf66) | "在线" |
| `offline` | 红色圆点 (#ff6b6b) | "离线"（xx 秒前） |
| `unknown` | 灰色圆点 (#6c6c80) | "未知" |

- 额外元信息以可展开形式展示：version、hostname、agentUptime、firstSeenAt

**文件**: `packages/web/src/styles.css`

- 新增 `.agent-state-online`、`.agent-state-offline`、`.agent-state-unknown` 样式

## 数据流示例

```
时间线:
T+0s    Agent 启动 → 读取凭据 → 开始监听 :8444
T+0.5s  Agent 触发首次心跳 POST → Manager 收到 → 标记 online
T+30s   Agent 触发心跳 → lastSeen 更新
T+60s   Agent 触发心跳 → lastSeen 更新
T+90s   Agent 停止（宕机）
T+120s  Manager 未收到心跳 → 自动标记 offline
T+180s  Web 前端轮询 GET /agents → 看到 offline → 显示红色状态点
```

## 文件变更清单

| 包 | 文件 | 变更 |
|---|---|---|
| protocol | `src/types.ts` | 新增 `HeartbeatRequest`, `HeartbeatResponse` 类型 |
| protocol | `src/constants.ts` | 新增 `HEARTBEAT_PATH` |
| manager | `src/heartbeat.ts` | **新建** — HeartbeatTracker 类 |
| manager | `src/storage.ts` | 新增 `findAgentByToken()` |
| manager | `src/routes/agents.ts` | 修改 listAgents；新增 registerHeartbeatRoute |
| manager | `src/auth.ts` | 心跳端点到 PUBLIC_PATHS |
| manager | `src/app.ts` | 传递 HeartbeatTracker |
| manager | `src/index.ts` | 创建 HeartbeatTracker |
| agent | `src/heartbeat.ts` | **新建** — 心跳发送逻辑 |
| agent | `src/config.ts` | ServerConfig 新增 agentId, managerUrl |
| agent | `src/index.ts` | 启动/关闭时集成心跳 |
| web | `src/components/AgentCard.tsx` | 在线状态指示器 |
| web | `src/styles.css` | 状态指示器样式 |

## 验证方案

### 单元测试
- `HeartbeatTracker.beat()` + `getStatus()` 正确性
- `HeartbeatTracker.enrichAgents()` 批量注入
- `HeartbeatTracker.removeAgent()` 清理
- `storage.findAgentByToken()` 正确查找

### 端到端验证
```bash
# 启动 Manager（心跳端点默认开启）
npm run dev:manager -- --token admin-token-12345678

# 注册并启动 Agent
node packages/agent/dist/cli.js start --register "<base64>"

# 验证心跳
curl http://localhost:8443/api/v1/manager/agents
# → 应看到 state: "online", lastSeen, version 等字段

# 停止 Agent
node packages/agent/dist/cli.js stop
sleep 95

# 验证离线
curl http://localhost:8443/api/v1/manager/agents
# → 应看到 state: "offline"

# 重新启动 Agent
node packages/agent/dist/cli.js start
curl http://localhost:8443/api/v1/manager/agents
# → 应看到 state: "online"

# 删除 Agent 后心跳记录应消失
curl -X DELETE http://localhost:8443/api/v1/manager/agents/:id
```

## 边界情况

- **Agent 注册但从未发送心跳**：state 为 `unknown`
- **Agent 心跳间断**（网络闪断）：Manager 保持离线状态，Agent 恢复后重新变为 online
- **Manager 重启**：心跳追踪信息丢失，Agent 会继续发送心跳，Manager 从头追踪
- **Agent Token 被重置**（Manager 端手动删除重新注册）：Agent 收到 401 → 心跳停止，需要重新注册
- **多个 Agent 共享同一 Token**：不可能，每个 Agent 注册时获得唯一 token
