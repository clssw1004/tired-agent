# tired-agent 架构重构：Agent / Manager 分服务

> 日期：2026-07-18
> 状态：设计阶段

---

## 背景

现有架构中 server 列表存在浏览器 localStorage，跨设备不可见。
用户希望一个入口配置后所有设备可见，且不希望每个被控机器都有管理功能。

核心诉求：
- 网络入口部署一个 **Manager**，暴露到公网
- 被控机器部署 **Agent**，在内网只执行 PTY
- 浏览器只连 Manager，Manager 代理到 Agent
- 安全隔离：Manager 被攻破不能直接执行命令

---

## 包结构

```
@tired-agent/
  agent     ← PTY 执行器（部署在被控机器，无 Web 无 UI）
  manager   ← Web 门户 + 代理 + agent 管理（部署在入口机器）
  web       ← SPA（unchanged，由 manager 服务）
  protocol  ← 共享类型（unchanged）
```

**安全原则**：agent 和 manager 是不同的 npm 包、不同的二进制、不同的进程。
Manager 被攻破只能通过 token 访问 agent 的 API 接口（创建 session、发输入），不能直接在 agent 上执行任意命令。Agent 包不包含 manager 的代码。

---

## 架构拓扑

```
                    ┌── Computer 1 ──┐
                    │ tired-agent     │  ← 纯执行器
                    │ :8444           │    无 Web
                    └────────────────┘
                         ▲
                    HTTP │ internal LAN
                         │
┌──────────┐         ┌──┴── Manager ──┐         ┌── Computer 2 ──┐
│ 手机/PC  │── HTTPS─→│ tired-manager  │──HTTP──→│ tired-agent     │
│ 浏览器   │         │ :443           │         │ :8444           │
│ SPA      │         │ 代理 + web     │         │ ...             │
└──────────┘         └────────────────┘         └────────────────┘
```

**关键**：
- 用户只把 Manager 暴露到公网（443）
- Agent 在内网，只有 Manager 能访问
- SPA 只连 Manager，不直连 Agent
- 代理层由 Manager 的 HTTP fetch + SSE 透传实现

---

## 数据流

### 列出 sessions
```
Browser GET /v1/agents/:aid/sessions
  → Manager 查 agent 表找 URL+token
  → Manager GET http://agent:port/v1/sessions (带 agent token)
  → 返回给浏览器
```

### 创建 session
```
Browser POST /v1/agents/:aid/sessions { cmd: "claude", ... }
  → Manager 转发到 http://agent:port/v1/sessions
  → Agent 创建 PTY 返回 session
  → Manager 返回给浏览器
```

### SSE 流（关键）
```
Browser ── SSE ──→ Manager /v1/agents/:aid/sessions/:sid/stream
                      │
                 Manager open SSE to agent:
                   GET http://agent:port/v1/sessions/:sid/stream?access_token=xxx
                      │
                 Manager 逐事件转发:
                   output event → 推给浏览器
                   state event  → 推给浏览器
                   heartbeat    → 推给浏览器
```

### 发送输入
```
Browser POST /v1/agents/:aid/sessions/:sid/input { data: base64(...) }
  → Manager POST http://agent:port/v1/sessions/:sid/input { data: ... }
```

---

## Phase 1: Agent 包

从现有 `packages/server` 提取 PTY 执行能力。

**保留**：
- SessionManager / node-pty / PTY 生命周期
- SSE 流（`/v1/sessions/:id/stream`）
- REST 路由（`/v1/sessions` CRUD + input + resize + output）
- Auth（token 鉴权）
- SQLite storage（session 记录 + 日志文件）
- Config 加载（`--port`、`--token`、`--data`、`--host`）
- `/health` 端点

**删除**：
- 所有 manager 相关的代码
- Web SPA 静态文件托管
- CORS 中间件（Agent 只被 Manager 调用）

**端口**：默认 8444。

**依赖**：`@tired-agent/protocol`（不变）。

```
packages/agent/src/
  index.ts              ← 入口
  config.ts             ← 配置加载
  auth.ts               ← token 鉴权
  app.ts                ← Fastify 实例
  shutdown.ts           ← 优雅关闭
  session/
    manager.ts          ← PTY 管理
    storage.ts          ← SQLite / 日志
    types.ts            ← 内部类型
  routes/
    sessions.ts         ← /v1/sessions CRUD
    stream.ts           ← SSE 流
  util/
    log.ts              ← 日志
    hex-dump.ts         ← SSE 调试
```

**启动**：
```bash
cd packages/agent
npm run dev -- --port 8444 --token xxx --host 0.0.0.0
```

---

## Phase 2: Manager 包

**新建 `packages/manager`**。

### 2a: 登录鉴权

Manager 有自己的 token（`--token`/配置文件），用于管理员登录。

**登录流程**：
```
1. 浏览器访问 Manager → 未登录 → 重定向到 /login
2. 用户在登录页输入 Manager token
3. POST /v1/manager/auth/login { token: "xxx" }
4. Manager 验证 token == 配置的 token
5. 验证通过 → 返回 session token（JWT 或随机串）
6. 浏览器存储 session token（localStorage）
7. 后续请求带 Authorization: Bearer <session-token>
```

**端点**：
- `POST /v1/manager/auth/login` — 验证 token，返回 session
- `POST /v1/manager/auth/logout` — 注销 session
- `GET /v1/manager/auth/me` — 验证 session 是否有效（前端启动时调用）

**session 存储**：
- 简单方案：生成随机 token 存入 SQLite `manager_sessions` 表，设置过期时间
- 或 JWT（不依赖存储，自包含签名）

**前端**：
- `LoginPage` 改为真正的登录表单（输入 token）
- 登录成功后跳转到 agent 管理页
- 页面加载时检查 `/v1/manager/auth/me`，无效则跳回登录

### 2b: Agent 管理
- SQLite `manager_agents` 表：`id, name, baseUrl, token, enabled, createdAt`
- `GET /v1/manager/agents` — 列出
- `POST /v1/manager/agents` — 添加
- `PUT /v1/manager/agents/:id` — 编辑
- `DELETE /v1/manager/agents/:id` — 删除

### 2b: 代理转发
- `GET /v1/agents/:aid/sessions` → 转发到 agent
- `POST /v1/agents/:aid/sessions` → 转发创建
- `DELETE /v1/agents/:aid/sessions/:sid` → 转发结束
- `POST /v1/agents/:aid/sessions/:sid/input` → 转发输入
- `GET /v1/agents/:aid/sessions/:sid/stream` → SSE 透传

### 2c: SSE 透传

```typescript
app.get('/v1/agents/:aid/sessions/:sid/stream', async (req, reply) => {
  const agent = storage.getAgent(req.params.aid);
  const agentUrl = `${agent.baseUrl}/v1/sessions/${req.params.sid}/stream?access_token=${agent.token}`;
  const agentRes = await fetch(agentUrl);
  
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  // ReadableStream 透传
  for await (const chunk of agentRes.body!) {
    reply.raw.write(chunk);
  }
});
```

### 2d: SPA 托管
- Manager 静态文件托管 `packages/web/dist/`
- `GET /*` → `index.html`

```
packages/manager/src/
  index.ts              ← 入口
  config.ts             ← 配置加载
  auth.ts               ← token 鉴权
  storage.ts            ← SQLite 存储 agent 列表
  routes/
    agents.ts           ← /v1/manager/agents CRUD
    proxy.ts            ← /v1/agents/:aid/sessions/* 代理
  util/
    log.ts              ← 日志
```

**启动**：
```bash
cd packages/manager
npm run dev -- --port 8443 --token xxx --host 0.0.0.0
```

---

## Phase 3: 前端适配

### 3a: ServerContext 改造
- 从 localStorage 改为从 Manager API `GET /v1/manager/agents` 获取列表
- 新增、编辑、删除都走 Manager API
- 首次使用用户在 Manager UI 上手动添加 agent

### 3b: API 路径调整

现有前端调用：
```
transport.listSessions(ref)     → GET {ref.baseUrl}/v1/sessions
transport.createSession(ref,..) → POST {ref.baseUrl}/v1/sessions
transport.sendInput(ref,id,..)  → POST {ref.baseUrl}/v1/sessions/:id/input
transport.subscribe(ref,id,..)  → GET {ref.baseUrl}/v1/sessions/:id/stream
```

Manager 模式下：
```
transport.listSessions(ref, aid)     → GET {ref.baseUrl}/v1/agents/:aid/sessions
transport.createSession(ref, aid,..) → POST {ref.baseUrl}/v1/agents/:aid/sessions
transport.sendInput(ref, aid, id,..) → POST {ref.baseUrl}/v1/agents/:aid/sessions/:id/input
transport.subscribe(ref, aid, id,..) → GET {ref.baseUrl}/v1/agents/:aid/sessions/:id/stream
```

### 3c: ServerRef 含义变化
- `ServerRef.baseUrl` 现在指向 **Manager** 的地址
- `ServerRef.token` 现在是 **Manager** 的 token
- Agent 的 token 存在 Manager 的 SQLite 中，浏览器不需要知道

---

## 文件清单

| 操作 | 路径 | 说明 |
|------|------|------|
| **新建** | `packages/agent/` | Agent 包 |
| **新建** | `packages/agent/src/index.ts` | 入口 |
| **新建** | `packages/agent/src/session/manager.ts` | 从 server 复制 |
| **新建** | `packages/agent/src/session/storage.ts` | 从 server 复制 |
| **新建** | `packages/agent/src/routes/sessions.ts` | 从 server 复制 |
| **新建** | `packages/agent/src/routes/stream.ts` | 从 server 复制 |
| **新建** | `packages/agent/src/auth.ts` | 从 server 复制 |
| **新建** | `packages/agent/src/config.ts` | 精简 |
| **新建** | `packages/manager/` | Manager 包 |
| **新建** | `packages/manager/src/index.ts` | 入口 |
| **新建** | `packages/manager/src/routes/agents.ts` | Agent CRUD |
| **新建** | `packages/manager/src/routes/proxy.ts` | 转发 + SSE |
| **新建** | `packages/manager/src/storage.ts` | SQLite |
| **新建** | `packages/manager/src/auth.ts` | 鉴权 |
| **新建** | `packages/manager/src/config.ts` | 配置 |
| **删除** | `packages/server/` | 拆分为 agent + manager |
| **修改** | `packages/web/src/store/ServerContext.tsx` | API 获取列表 |
| **修改** | `packages/web/src/store/ServerEditPage.tsx` | API 创建/编辑 |
| **修改** | `packages/protocol/src/Transport.ts` | 加 agentId 参数 |
| **不变** | `packages/protocol/` | 类型定义 |
