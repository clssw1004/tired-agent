# tired-agent — 设计文档

> 日期：2026-07-15
> 项目名：tired-agent — "累趴下的电脑，但还被你远程压榨加班"
> 状态：已批准，进入实施阶段
> 关联 plan: `C:\Users\cuiwei\.claude\plans\mossy-weaving-badger.md`

---

## 1. 背景与目标

### 1.1 用户场景

> 我希望在外面能操控家里电脑跑 Claude（以及类似的 AI 编码工具）开发，又不想用远程桌面（移动端体验差）。我希望可以随时断开网络、再随时连上，从断开处继续。当 Claude 工作完成或需要我确认时，能有钩子通知我，让我能远程介入。

家里电脑 = **AI 员工**，24h 待命。App = **远程指挥中心**。

### 1.2 核心问题

- 远程桌面（RDP / VNC / TeamViewer）移动端体验差、耗电、需要前台运行
- SSH 客户端缺少会话管理（断线续传、状态可视化）
- 需要专用 App 持续迭代，叠加钩子通知等高级功能

### 1.3 目标

构建一个 **远程持久化交互会话系统**：
- 服务端跑在家里电脑上，管理多个 PTY session（claude、aider、codex 等）
- 客户端 App（iOS / Android / Web）通过自定义协议连接
- **即用即连**：客户端随时断开再连，输出不丢，从断点继续
- 协议层抽象，支持未来扩展（WebSocket、结构化事件、推送通知）

---

## 2. 关键约束（与用户对齐确认）

| 维度 | 决定 | 影响 |
|------|------|------|
| 主要工具 | Claude CLI + 任何 vibe coding CLI（aider / codex 等） | PTY 通用方案，不绑死具体工具 |
| 服务端平台 | Windows + Linux + macOS 全平台 | node-pty 跨平台抽象 |
| 后端技术栈 | TypeScript + Node.js | monorepo，类型共享 |
| 客户端 App | React Native + Expo（跨 iOS / Android / Web） | WebView 嵌入 xterm.js |
| 数据库 | Storage 抽象接口，默认 SQLite，可切 MySQL / PostgreSQL | Drizzle ORM 统一 SQL 抽象 |
| 网络层 | 用户自管（ZeroTier / frp），App 不做穿透 | 协议只需能在 LAN / VPN 上跑通 |
| 鉴权 | Bearer Token + TLS | 简单、有效 |
| 协议可用性 | **必须支持"即用即连"** | 服务端独立维护 session 状态 |
| Session 模型 | 多 server daemon × 多 session | client 维护 server 列表 |
| MVP 范围 | 原始 PTY 字节流（通知、结构化事件后续再加） | 简化首版，重点打通管道 |

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│           Client (Expo + RN, 跨 iOS/Android/Web)                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Server List  │  │ Session List │  │ Terminal View         │  │
│  │              │→ │              │→ │ (WebView + xterm.js)  │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         │                  │                    │               │
│         └──────────────────┴────────────────────┘               │
│                            │                                    │
│                  ┌─────────▼──────────┐                         │
│                  │  Transport 接口     │ ← HTTP+SSE / WS 实现    │
│                  └─────────▲──────────┘                         │
└────────────────────────────┼────────────────────────────────────┘
                             │  HTTPS + Bearer Token
┌────────────────────────────▼────────────────────────────────────┐
│           Server Daemon (Node.js, 跨平台)                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Transport 实现 (HTTP+SSE)                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐   │
│  │ Session Manager │  │  Storage (Pluggable)                │   │
│  │  + node-pty     │  │   ├─ SQLite (默认, 零依赖)          │   │
│  └─────────────────┘  │   ├─ MySQL 适配器                   │   │
│                        │   └─ PostgreSQL 适配器              │   │
│                        │   └─ Append-only log files (PTY)   │   │
│                       └─────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 项目结构

```
tired-agent/                    # 单 git repo，前后可独立构建交付
├── package.json             # workspaces: ["packages/*"]
├── tsconfig.base.json
├── .gitignore
├── README.md
├── packages/
│   ├── protocol/            # 共享类型 + Transport 接口 + HTTP+SSE 实现
│   │   ├── src/
│   │   │   ├── types.ts         # Session, OutputChunk, ServerRef 等
│   │   │   ├── Transport.ts      # Transport 接口 + Subscription
│   │   │   ├── HttpSseTransport.ts  # MVP 实现
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/              # Node.js daemon
│   │   ├── src/
│   │   │   ├── index.ts         # 入口：Fastify server
│   │   │   ├── config.ts        # CLI/env 配置解析
│   │   │   ├── auth.ts          # Bearer token 中间件
│   │   │   ├── session/
│   │   │   │   ├── types.ts     # SessionRecord 内部类型
│   │   │   │   ├── manager.ts   # SessionManager (node-pty + 内存索引)
│   │   │   │   └── storage.ts   # Storage 抽象 + SQLite/MySQL/PostgreSQL 适配器
│   │   │   ├── routes/
│   │   │   │   ├── sessions.ts  # REST 端点
│   │   │   │   └── stream.ts    # SSE 端点
│   │   │   └── util/
│   │   │       └── log.ts      # pino logger
│   │   ├── data/               # 运行时数据（.gitignored）
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── client/              # Expo App
│       ├── app/                # expo-router 路由
│       │   ├── _layout.tsx
│       │   ├── index.tsx        # Server List
│       │   ├── server/[id].tsx  # Session List
│       │   └── session/[serverId]/[sessionId].tsx  # Terminal View
│       ├── src/
│       │   ├── transports/      # 引用 @tired-agent/protocol
│       │   ├── store/
│       │   │   ├── servers.ts   # zustand + AsyncStorage
│       │   │   └── offsetTracker.ts  # 每个 session 的 lastOffset
│       │   ├── components/
│       │   │   ├── TerminalView.tsx  # WebView + xterm.js
│       │   │   ├── ServerCard.tsx
│       │   │   ├── SessionCard.tsx
│       │   │   └── InputBar.tsx      # 独立 TextInput
│       │   ├── webview/
│       │   │   └── terminal.html     # xterm.js HTML
│       │   └── utils/
│       │       └── reconnect.ts      # SSE 重连
│       ├── assets/              # App 图标等
│       ├── package.json
│       ├── app.json
│       ├── babel.config.js
│       ├── metro.config.js
│       └── tsconfig.json
│
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-07-15-tired-agent-design.md  (本文件)
```

---

## 5. Storage 抽象

```typescript
interface Storage {
  init(): Promise<void>;
  insert(session: SessionRecord): void;
  update(partial: Partial<SessionRecord> & { id: string }): void;
  list(): SessionRecord[];
  get(id: string): SessionRecord | undefined;
  appendOutput(id: string, data: Uint8Array): number;
  readOutput(id, fromOffset, limit?): { chunks: ...; upTo: number };
  close(): Promise<void>;
}
```

- **SQLite**（默认）：`createSqliteStorage(dataDir)`，用 `better-sqlite3`
- **MySQL**：环境变量 `STORAGE_KIND=mysql` + `MYSQL_*` 配置
- **PostgreSQL**：环境变量 `STORAGE_KIND=postgres` + `POSTGRES_CONNECTION_STRING`

---

## 6. API 协议

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/v1/sessions` | 列出所有 session |
| `POST` | `/v1/sessions` | 创建 session |
| `GET`  | `/v1/sessions/:id` | 获取单个 session |
| `DELETE` | `/v1/sessions/:id` | 杀掉 session |
| `POST` | `/v1/sessions/:id/resize` | 调整 PTY 尺寸 |
| `GET`  | `/v1/sessions/:id/output?from=N&limit=B` | 拉历史输出 |
| `POST` | `/v1/sessions/:id/input` | 发送输入到 PTY |
| `GET`  | `/v1/sessions/:id/stream` | **SSE** 实时流 |

所有请求需 `Authorization: Bearer <token>`。SSE 端点也接受 `?access_token=` 查询参数（EventSource 无法发送 header）。

---

## 7. 即用即连数据流

```
T1: 首次打开 TerminalScreen
    1. offsetTracker.get(serverId, sessionId) → 0
    2. GET /v1/sessions/:id/output?from=0  ← 拉历史
    3. xterm.js 写入
    4. offsetTracker.set(totalBytes)
    5. EventSource(/v1/sessions/:id/stream) 打开

T2: 网络中断
    - EventSource 断开 → reconnect loop 触发（指数退避）
    - PTY 在 server 继续跑，输出 append 到 log 文件

T3: 重新打开 app
    1. 读 offsetTracker → 100KB
    2. GET /v1/sessions/:id/output?from=100KB → 拉漏掉的部分
    3. xterm.js 追加
    4. 重开 EventSource
```

---

## 8. MVP 范围之外（明确不做）

- 推送通知（ntfy / 邮件 / Pushover 等）
- 结构化事件识别（工具调用、确认提示）
- WebSocket transport（Transport 接口预留）
- Log 文件轮转
- 用户管理 / 多用户 / 权限分级
- 服务端本地管理 UI
- 终端 resize 精细同步
- 跨平台打包发布（MVP 跑源码）

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `node-pty` native 编译问题 | 用 prebuilt binaries；README 注明系统依赖 |
| Android WebView IME 问题 | MVP 用独立 InputBar 绕过 |
| SSE 被代理缓冲 | `X-Accel-Buffering: no` + 定期 heartbeat |
| SQLite 写并发 | better-sqlite3 同步 API，单 daemon 单写者 |
| Log 文件无限增长 | README 注明定期清理 `data/sessions/*.log` |
