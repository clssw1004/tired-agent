# tired-agent — 系统架构

> 让你的电脑加班，你只管躺平。

tired-agent 是一个**可自托管的远程持久化交互会话系统**：把 `claude`、`aider`、`codex` 等交互式
CLI 工具跑在你控制的机器上，通过浏览器从任何地方接入。随时断开网络、随时再连，会话在服务端
持续运行，输出不丢，从断点续传。

---

## 1. 背景与目标

### 1.1 用户场景

> 我希望在外面能操控家里电脑跑 Claude（以及类似的 AI 编码工具）开发，又不想用远程桌面
> （移动端体验差）。我希望可以随时断开网络、再随时连上，从断开处继续。

家里电脑 = **AI 员工**，24h 待命。浏览器 = **远程指挥中心**。

### 1.2 核心问题

- 远程桌面（RDP / VNC / TeamViewer）移动端体验差、耗电、需要前台运行。
- SSH 客户端缺少会话管理（断线续传、状态可视化）。
- 需要一个可持续迭代的专用入口，叠加结构化渲染、移动端输入等高级能力。

### 1.3 目标

- 服务端跑在受控机器上，管理多个 PTY session（claude、aider、codex、bash 等）。
- 浏览器 Web SPA 作为统一客户端，无需安装原生 App。
- **即用即连**：客户端随时断开再连，输出不丢，从字节偏移续传。
- 协议层抽象，可扩展（结构化事件、持久化会话、目录浏览等已落地）。

---

## 2. 关键约束

| 维度 | 决定 | 影响 |
|------|------|------|
| 主要工具 | Claude CLI + 任意 vibe coding CLI（aider / codex 等） | PTY 通用方案，不绑死具体工具 |
| 服务端平台 | Windows + Linux + macOS 全平台 | node-pty 跨平台抽象 |
| 技术栈 | TypeScript + Node.js | monorepo，类型共享 |
| 客户端 | React + Vite Web SPA（由 Manager 静态托管） | 移动端友好，无需原生打包 |
| 数据库 | Storage 抽象接口，默认 SQLite（better-sqlite3） | 零依赖起步，MySQL/Postgres 预留 |
| 网络层 | 用户自管（ZeroTier / frp / VPN），系统不做穿透 | 只需能在 LAN / VPN 上跑通 |
| 鉴权 | Bearer Token；Manager 侧签发会话 token | 简单、有效 |
| 会话模型 | Manager 多 agent × 每 agent 多 session | Manager 维护 agent 注册表 |
| 会话可用性 | **必须支持"即用即连"** | 服务端独立维护 session 状态 + append-log |

---

## 3. 架构总览

系统分三个独立部署的角色：**Manager（控制面）**、**Agent（PTY 执行器）**、**Web SPA（浏览器客户端）**。

```
┌──────────┐    HTTPS   ┌───────────────────┐    HTTP+SSE   ┌───────────────┐
│  Phone / │───────────▶│  Manager (:8443)   │──────────────▶│  Agent (:8444) │
│  Browser │            │                    │  ?access_token │  (每台机器一个) │
│  (SPA)   │            │  Portal + Auth +   │               ├───────────────┤
└──────────┘            │  Proxy + Registry  │               │  spawn PTY     │
                        │  + 静态托管 SPA     │               │  sessions      │
                        └───────────────────┘               └───────────────┘
```

关键点：

- **浏览器只与 Manager 通信**，永不直连 Agent。Manager 是反向代理，把浏览器的会话 API 与 SSE
  流转发到目标 Agent，并在转发时注入该 Agent 的 bearer token —— 浏览器永远看不到 Agent 的密钥。
- **Manager 是唯一需要对外暴露的组件**（手机、平板、浏览器均连它）。
- Agent 在首次启动时自注册到 Manager（见 §7），之后按 `agentKey` 去重，重启无需手工重配。

### 3.1 Manager —— 控制面

Fastify HTTP 服务，集中枢纽：

- **Portal** —— 用 `@fastify/static` 托管 Web SPA（`web/dist`），并对非 `/v1/*`、非 `/health`
  的路径回退 `index.html`，支持 SPA 客户端路由深链接。
- **Auth** —— admin token 登录，签发 24h 会话 token，后续请求用会话 token 鉴权。
- **Agent 注册表** —— 在 SQLite 中记录已注册 Agent（name、baseUrl、token、agentKey）。
- **Proxy** —— 把 `/v1/agents/:aid/...` 反代到对应 Agent 的 `/v1/...`，注入其 token。
- **Onboarding** —— 生成 base64 注册串，供 Agent 零配置自注册。

### 3.2 Agent —— PTY 执行器

安装在每台受控机器上的 Node.js 守护进程，**无 Web UI**：

- **PTY 会话** —— 通过 node-pty spawn 交互式进程（bash、cmd、claude 等）。
- **输出流式化** —— 通过 SSE 推送 PTY 输出，支持按字节偏移重放以便重连。
- **Append-log 持久化** —— 所有输出写入磁盘日志，断线客户端可追赶。
- **自注册** —— 首次启动用 admin 生成的 base64 串向 Manager 注册，取得专属 token，并把身份
  （`agentKey`）持久化以便去重。

### 3.3 Web SPA —— 浏览器客户端

Manager 托管的 React + Vite 应用：

- **Login** —— 单表单填 Manager URL + admin token 登录。
- **Server / Session 列表** —— 浏览各 Agent 的运行 / 已退出会话。
- **Terminal** —— PTY 模式用 xterm.js 全终端 + 移动端键盘桥；持久化（chat）模式用结构化聊天视图。
- **Onboarding** —— 引导新增 Agent（自注册 / 手动添加）。

---

## 4. 项目结构

单 git 仓库，npm workspaces（`packages/*`）。

```
tired-agent/
├── packages/
│   ├── protocol/            # 共享类型 + Transport 接口 + HTTP+SSE 实现（npm 公开）
│   │   └── src/
│   │       ├── types.ts             # Session / SessionSpec / StreamEvent / StructuredContent 等
│   │       ├── Transport.ts         # Transport 接口
│   │       ├── HttpSseTransport.ts  # 客户端 HTTP+SSE 实现
│   │       └── index.ts
│   │
│   ├── agent/               # PTY 执行器（CLI + daemon，npm 公开）
│   │   └── src/
│   │       ├── cli.ts               # commander CLI 入口（start/register/stop/restart/status）
│   │       ├── index.ts             # 启动流程（注册 → storage → manager → listen）
│   │       ├── app.ts               # Fastify 装配 + /health
│   │       ├── config.ts            # CLI/env 配置解析
│   │       ├── auth.ts              # Bearer / ?access_token 鉴权
│   │       ├── register.ts          # 自注册 + .agent-credentials 持久化
│   │       ├── routes/
│   │       │   ├── sessions.ts      # 会话 REST 端点
│   │       │   ├── stream.ts        # SSE 端点
│   │       │   └── directories.ts   # 目录浏览 / 收藏 / 最近
│   │       ├── session/
│   │       │   ├── manager.ts       # SessionManager（node-pty + 内存索引 + 持久化模式）
│   │       │   ├── storage.ts       # Storage 抽象 + SQLite + append-log
│   │       │   └── types.ts
│   │       └── directory/           # 目录 store + service（directories.json）
│   │
│   ├── manager/             # Web 门户 + 代理 + 注册表（私有，Docker 镜像）
│   │   └── src/
│   │       ├── index.ts             # 启动流程
│   │       ├── app.ts               # Fastify 装配（cors → auth → 路由 → SPA）
│   │       ├── config.ts
│   │       ├── auth.ts              # 会话 token 鉴权中间件 + PUBLIC_PATHS
│   │       ├── storage.ts           # manager_agents / manager_sessions 两表
│   │       ├── web.ts               # SPA 静态托管 + index.html 回退
│   │       └── routes/
│   │           ├── auth.ts          # 登录 / 登出 / me
│   │           ├── agents.ts        # Agent CRUD + 自注册
│   │           └── proxy.ts         # /v1/agents/:aid/... 反代到 Agent
│   │
│   └── web/                 # React + Vite SPA（私有，内嵌进 manager 镜像）
│       └── src/
│           ├── main.tsx / App.tsx   # HashRouter
│           ├── pages/               # Login / ServerList / SessionList / SessionCreate / Terminal / Onboarding
│           ├── components/          # ChatTimeline / PtySessionView / DirectoryPickerModal / PtyMobileKeyboard …
│           ├── renderer/            # RendererRegistry + ClaudeRenderer + GenericPtyRenderer
│           └── store/               # AuthContext / ServerContext
│
└── docs/
    └── architecture/
        ├── architecture.md          # 本文件
        └── engineering.md           # 工程化（Docker / CLI / 登录 / 自注册）
```

---

## 5. 数据模型与存储

### 5.1 Agent 端 Storage 抽象

`agent/src/session/storage.ts` 定义 `Storage` 接口，默认 SQLite 实现（`tired-agent.db.sqlite`，WAL）。
会话元数据存表 `sessions`，PTY 原始输出以 append-only 日志存 `<dataDir>/sessions/<id>.log`。

`sessions` 表主要列：

```sql
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  cmd         TEXT NOT NULL,
  args        TEXT NOT NULL,          -- JSON
  cwd         TEXT,
  env         TEXT,                   -- JSON
  status      TEXT NOT NULL DEFAULT 'starting',
  pid         INTEGER,
  exitCode    INTEGER,
  createdAt   INTEGER NOT NULL,
  exitedAt    INTEGER,
  byteOffset  INTEGER NOT NULL DEFAULT 0,  -- 日志累计字节数，客户端续传游标
  cols        INTEGER NOT NULL DEFAULT 80,
  rows        INTEGER NOT NULL DEFAULT 24,
  label       TEXT,
  mode        TEXT DEFAULT 'process',      -- process | persistent
  claudeSessionId TEXT                     -- 持久化会话的 --resume 锚点
);
```

- `byteOffset` 是该会话日志文件的累计字节数，客户端以此为续传游标。
- 用户消息与 Claude 的 NDJSON 输出都写入同一份 `<id>.log`（用户消息以
  `{"type":"tired-agent/user",...}` 行内联），因此完整会话历史可从日志重建。
- `MySQL` / `PostgreSQL` 适配器接口预留（当前为占位实现）。可通过 `STORAGE_KIND` 等环境变量切换。
- 日志读取支持 `readOutput(from, limit)` 与 `readOutputTail(n)`（尾部反向读取）。

### 5.2 Manager 端存储

`manager/src/storage.ts`（`manager.sqlite`），两表：

- `manager_agents` —— Agent 注册表：`id`、`agent_key`、`name`、`baseUrl`、`token`、`enabled`、
  `createdAt`。`token` 是 Agent 自身 bearer，仅服务端持有，**从不返回浏览器**。
- `manager_sessions` —— 登录后签发的会话 token：`token`、`createdAt`、`expiresAt`（TTL 24h，
  过期惰性清理 + `pruneExpired()` 扫描）。

### 5.3 Agent 凭据文件

Agent 把 `{ agentKey, id, token }` 持久化到 `<dataDir>/.agent-credentials`，重启复用，避免重复注册。

---

## 6. API 协议

所有请求需鉴权。SSE 端点额外接受 `?access_token=` 查询参数（EventSource 无法发送 Header）。

### 6.1 Agent 端（`:8444`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/health` | 健康检查（免鉴权） |
| `GET`  | `/v1/sessions` | 列出会话（可 `?status=` 过滤） |
| `POST` | `/v1/sessions` | 创建会话（body 为 `SessionSpec`） |
| `GET`  | `/v1/sessions/:id` | 获取单个会话 |
| `DELETE` | `/v1/sessions/:id` | 杀掉 / 删除会话 |
| `DELETE` | `/v1/sessions/prune?olderThanHours=24` | 清理过期已退出会话（含日志） |
| `POST` | `/v1/sessions/:id/input` | 发送输入（body `{ data: <base64> }`） |
| `POST` | `/v1/sessions/:id/resize` | 调整 PTY 尺寸（`{ cols, rows }`） |
| `GET`  | `/v1/sessions/:id/output?from&limit&tail` | 拉历史输出（`tail` 与 `from/limit` 互斥） |
| `GET`  | `/v1/sessions/:id/stream?from=&access_token=` | **SSE** 实时流 |
| `GET`  | `/v1/directories?path=` | 浏览目录（默认 home） |
| `GET`  | `/v1/directories/shortcuts` | 收藏 + 最近目录 |
| `POST` | `/v1/directories/favorites` | 新增收藏（`{ path, name? }`） |
| `DELETE` | `/v1/directories/favorites/:id` | 删除收藏 |

鉴权：`Authorization: Bearer <token>` 或 `?access_token=<token>`；`/health` 与 `OPTIONS` 放行。

`SessionSpec`（`POST /v1/sessions` body）：

```ts
{ cmd, args?, cwd?, env?, cols?=80, rows?=24, label?,
  mode?='process',            // 'process' | 'persistent'
  executionMode?='auto' }     // 'auto' | 'manual' | 'plan'（持久化会话）
```

SSE 事件类型（`StreamEvent`）：

- `output` —— `{ offset, data }`，`data` 按 `CLSSW_SSE_FORMAT` 编码（默认 base64，可选 hex）。
- `state` —— 完整 `Session` 元数据。
- `heartbeat` —— `{ ts }`，每 15s 一次保活。

连接时若 `?from=` 小于当前 `byteOffset`，先重放 `[from, offset)` 区间的历史，再切入实时流。

### 6.2 Manager 端（`:8443`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/health` | 健康检查（公开） |
| `POST` | `/v1/manager/auth/login` | admin token → 会话 token（公开） |
| `POST` | `/v1/manager/auth/logout` | 注销当前会话 token |
| `GET`  | `/v1/manager/auth/me` | 校验会话 token |
| `GET`  | `/v1/manager/agents` | 列出 Agent（不含 token） |
| `POST` | `/v1/manager/agents` | 手动添加 Agent |
| `DELETE` | `/v1/manager/agents/:id` | 注销 Agent |
| `POST` | `/v1/manager/agents/register` | Agent 自注册（公开，见 §7） |
| `*`    | `/v1/agents/:aid/...` | 反代到 Agent 的 `/v1/...`（注入其 token） |

免鉴权路径（`PUBLIC_PATHS`）：`/health`、`/v1/manager/auth/login`、`/v1/manager/agents/register`；
非 `/v1/` 前缀的请求按 SPA 静态资源放行。

### 6.3 代理机制

浏览器请求 `/v1/agents/:aid/...`，Manager 用 `storage.getAgent(aid)` 查出目标 Agent，将路径改写为
`/v1/...` 并 `fetch(agent.baseUrl + path + ?access_token=<agent.token>)`。SSE 流以流式方式透传，
不缓存整段输出；并把浏览器带来的 `?from=` 转发给 Agent，避免每次重连都重放整段日志。

---

## 7. Agent 自注册

```
┌─ Admin（已在 UI 登录）──────────────────────────────────────────┐
│  在 Onboarding 页点击"生成注册命令"                                │
│  UI 构造 base64(json({ managerUrl[, agentName] }))                │
│  展示安装 + 启动一行命令                                           │
└──────────────────────────────────────────────────────────────────┘

┌─ Agent 启动 ──────────────────────────────────────────────────────┐
│  1. 解码 --register / CLSSW_REGISTER → { managerUrl }              │
│  2. 生成或复用 agentKey（存 .agent-credentials）                    │
│  3. host=0.0.0.0 时自动探测局域网 IPv4 作为 baseUrl                 │
│  4. POST {managerUrl}/v1/manager/agents/register                   │
│     body: { name, baseUrl, agentKey }                              │
│  5. Manager 按 agentKey（其次 baseUrl）去重：命中则复用既有 token、  │
│     刷新 name/baseUrl；否则创建新条目并生成随机 token               │
│  6. Agent 保存 { agentKey, id, token }，用该 token 继续启动         │
└──────────────────────────────────────────────────────────────────┘
```

安全说明：

- 注册端点**公开、无共享密钥、无 ticket**。base64 仅为便于复制粘贴，**不是安全措施**（等效明文）。
- 安全边界是**网络**：不要在没有反向代理 / 防火墙 / VPN 的情况下把 Manager 裸露到公网。
- 复用 token 而非每次重签，是为了避免 Agent 重启后把此前连接的客户端"锁死"。

---

## 8. 即用即连数据流

```
T1: 首次打开终端
    1. GET /v1/agents/:aid/sessions/:sid/output?from=0   ← 拉历史（或 ?tail=N 拉尾部）
    2. 写入 xterm.js / 结构化视图，记录 byteOffset
    3. 打开 SSE：/v1/agents/:aid/sessions/:sid/stream?from=<offset>

T2: 网络中断
    - SSE 断开 → 客户端重连（指数退避）
    - PTY 在 Agent 侧继续运行，输出持续 append 到日志

T3: 重新打开
    1. 用记录的 offset 重开 SSE：stream?from=<offset>
    2. Agent 重放 [offset, 当前) 的历史，再切入实时流
```

---

## 9. 会话生命周期与模式

状态机：`starting → running → exited`。会话退出后进入 60s 宽限期
（`CLEANUP_GRACE_MS`），若无订阅者则由每 60s 一次的清理定时器（`CLEANUP_INTERVAL_MS`）从内存
移除。服务端重启时 `reconcileWithStorage()` 把 SQLite 中的孤儿行标记为 `exited`。

两种模式：

- **`process`（默认）** —— 会话生命周期绑定单个进程：PTY 退出即会话终止。适合一次性命令与交互式 shell。
- **`persistent`** —— 会话是跨多轮的容器：每条用户消息 spawn 一个短命的
  `claude ... --output-format stream-json --verbose`（必要时带 `--resume <claudeSessionId>`）进程；
  进程结束后会话仍保持 `running`，等待下一条消息，只有用户显式 Kill 才移除。
  首次输出中解析出的 `session_id` 会被缓存并持久化为 `claudeSessionId`，供重启后
  `reconcileWithStorage()` 复活并续接对话。

持久化会话通过结构化输入（`StructuredInput`：`{type:'message', content, executionMode}` /
`{type:'interrupt'}`）交互，而非原始字节。

---

## 10. Web 渲染引擎

SPA 采用可插拔的 `AgentRenderer` 管线（`packages/web/src/renderer/`）：

- **`RendererRegistry`** —— 按 detector 优先级排序，逐个 `detect(cmd, args, preview)`，选出首个匹配的
  渲染器；无匹配时回退 `GenericPtyRenderer`。
- **`ClaudeRenderer`（priority 10）** —— 检测 Claude 的 stream-json 输出，逐行解析 NDJSON，产出
  `StructuredContent`（assistant 文本、思考占位、tool_use / tool_result、usage、result 等），
  并做去重与轮次重置。
- **`GenericPtyRenderer`（fallback）** —— 迁移到 xterm 直写后其 `processChunk` 为 no-op，原始字节由
  `TerminalView` 直接写入 xterm。

渲染器统一输出 `StructuredContent`（判别联合：`text` / `code` / `divider` / `status` / `table` /
`link` / `image` / `command` / `userMessage` / `toolUse` / `toolResult` / `streamEvent` / `usage`）。
`ChatTimeline` 把每个变体映射到对应 React 组件（气泡、代码块、工具卡片、状态指示、用量徽标等）。
UI 层从不直接处理原始 ANSI。

视图分流：`mode==='persistent'` 走 `ChatTimeline` 结构化聊天视图，否则走 `TerminalView`（xterm.js）。

---

## 11. 移动端与目录选择

- **`PtyMobileKeyboard`** —— PTY 模式移动端专用的可折叠自定义键盘（QWERTY + 方向 / Esc / Tab / Ctrl /
  Shift 等），支持系统 IME 输入；折叠态约 40px、展开态约 240px。
- **`SpecialKeysBar`** —— Ctrl / Shift（`off | oneShot | sticky`）等修饰键与方向键。
- **`DirectoryPickerModal`** —— 创建会话时浏览远端 Agent 文件系统，支持收藏 / 最近 / 浏览三种来源，
  数据由 Agent 的 `/v1/directories*` 提供、存于 Agent 侧 `directories.json`。

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `node-pty` 原生编译 | Windows 需 Python + build tools；Alpine 需 `build-base python3` |
| SSE 被代理缓冲 | `X-Accel-Buffering: no` + 15s heartbeat |
| SQLite 写并发 | better-sqlite3 同步 API，单 daemon 单写者，WAL 模式 |
| 日志文件无限增长 | `DELETE /v1/sessions/prune` + 定期清理已退出会话日志 |
| 注册端点公开 | 依赖网络边界（VPN / 反代 / 防火墙），勿裸露公网 |
| Agent 重启换 token | 按 `agentKey` 去重并复用 token，保持既有客户端可用 |
