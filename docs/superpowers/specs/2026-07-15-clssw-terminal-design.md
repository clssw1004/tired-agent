# clssw-terminal — 设计文档

> 日期：2026-07-15
> 状态：已批准，进入实施阶段
> 关联 plan: `C:\Users\cuiwei\.claude\plans\mossy-weaving-badger.md`

---

## 1. 背景与目标

### 1.1 用户场景

> 我希望在外面能操控家里电脑跑 Claude（以及类似的 AI 编码工具）开发，又不想用远程桌面（移动端体验差）。我希望可以随时断开网络、再随时连上，从断开处继续。当 Claude 工作完成或需要我确认时，能有钩子通知我，让我能远程介入。

### 1.2 核心问题

- 远程桌面（RDP / VNC / TeamViewer）方案在移动端体验差，耗电、延迟高、需要前台运行
- 远程 SSH 客户端虽然轻量，但缺少针对 Claude / AI coding 工具的会话管理（断线续传、状态可视化、通知）
- 用户希望使用"专用 App"持续迭代，逐步加上钩子通知等高级功能

### 1.3 目标

构建一个 **远程持久化交互会话系统**：
- 服务端运行在用户家里的电脑上，管理多个 PTY session（跑 claude、aider、codex 等 CLI 工具）
- 客户端 App（iOS / Android / Web）通过自定义协议连接服务端
- 客户端可随时断开再连上，**不丢失任何输出**，可从断点继续
- 协议层抽象，允许未来扩展（WebSocket transport、结构化事件、推送通知）

---

## 2. 关键约束（与用户对齐确认）

| 维度 | 决定 | 影响 |
|------|------|------|
| 主要工具 | Claude CLI（以及任何 vibe coding CLI：aider / codex 等） | PTY 通用方案，不绑死 claude |
| 服务端平台 | Windows + Linux + macOS 都要支持 | node-pty 跨平台抽象 |
| 后端技术栈 | TypeScript + Node.js | monorepo 友好，类型共享 |
| 客户端 App | React Native + Expo（跨 iOS / Android / Web） | WebView 嵌入 xterm.js |
| 网络层 | 用户自管（ZeroTier / frp），App 内不做穿透 | 协议只要能在 LAN / VPN 上跑通即可 |
| 鉴权 | Bearer Token + TLS | 简单、有效 |
| 协议可用性 | **必须支持"即用即连"** | 不能依赖客户端长连接；服务端必须独立维护 session 状态 |
| Session 模型 | 多个 server daemon，每个 daemon 多个 session | client 维护 server 列表 |
| MVP 范围 | 原始 PTY 字节流（不做结构化事件 / 通知） | 简化首版，重点是打通管道 |
| 未来扩展 | WebSocket transport、结构化事件、推送通知 | 架构必须留好接口 |

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│           Client (Expo + RN, 跨 iOS/Android/Web)                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ Server List  │  │ Session List │  │ Terminal View         │  │
│  │  (多服务器)  │─→│ (per server) │─→│ (WebView + xterm.js)  │  │
│  └──────────────┘  └──────────────┘  └───────────────────────┘  │
│         │                  │                    │               │
│         └──────────────────┴────────────────────┘               │
│                            │                                    │
│                  ┌─────────▼──────────┐                         │
│                  │ Transport 接口     │ ← HTTP+SSE / WS 实现    │
│                  └─────────▲──────────┘                         │
└────────────────────────────┼────────────────────────────────────┘
                             │  HTTPS + Bearer Token
┌────────────────────────────▼────────────────────────────────────┐
│           Server Daemon (Node.js, 跨平台)                       │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Transport 实现 (HTTP+SSE)                                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌─────────────────┐  ┌─────────────────────────────────────┐   │
│  │ Session Manager │  │  Session Store                      │   │
│  │  + node-pty     │  │   ├─ SQLite (元数据)                 │   │
│  └─────────────────┘  │   └─ Append-only log (PTY 输出)      │   │
│                       └─────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.1 核心抽象：`Transport` 接口

这是 MVP 与未来扩展的关键边界。客户端 UI 代码只依赖此接口，不感知底层是 HTTP+SSE 还是 WebSocket。

```typescript
interface Transport {
  listSessions(ref: ServerRef): Promise<Session[]>;
  createSession(ref: ServerRef, spec: SessionSpec): Promise<Session>;
  killSession(ref: ServerRef, id: string): Promise<void>;
  resizeSession(ref: ServerRef, id: string, cols: number, rows: number): Promise<void>;

  fetchOutput(ref: ServerRef, id: string, fromOffset: number, limit?: number)
    : Promise<{ chunks: OutputChunk[]; upTo: number }>;

  subscribe(ref: ServerRef, id: string, handlers: SubscribeHandlers): Subscription;

  sendInput(ref: ServerRef, id: string, data: Uint8Array): Promise<void>;
}
```

### 3.2 为什么是这个架构？

- **HTTP + SSE 优于 WebSocket**：
  - 移动网络（4G/5G、WiFi 切换）对 HTTP 比 WebSocket 友好，WS 易被系统休眠断开
  - 调试方便（curl 就能测），client 集成简单
  - "即用即连"天然契合 —— 断线续传只是 `GET /output?from=N` 一个请求
  - SSE 心跳保活、状态事件和输出可以走同一通道
- **每个 server 独立 daemon**：避免引入注册中心，单机部署零依赖
- **Append-only log 文件**：写快、读用 `fs.createReadStream(path, { start: offset })` 极简
- **SQLite 仅存元数据**：synchronous API（better-sqlite3）单写者零并发问题

---

## 4. 数据模型

```typescript
// packages/protocol/src/types.ts

export type SessionStatus = 'starting' | 'running' | 'exited';

export interface Session {
  id: string;           // uuid
  cmd: string;          // e.g. "claude"
  args: string[];       // e.g. []
  cwd?: string;
  env?: Record<string, string>;
  status: SessionStatus;
  pid?: number;         // PTY pid
  exitCode?: number | null;
  createdAt: number;    // unix ms
  exitedAt?: number;
  byteOffset: number;   // 当前 log 文件总字节数（用于客户端断点续传）
  cols: number;         // PTY 列数
  rows: number;         // PTY 行数
}

export interface OutputChunk {
  offset: number;       // chunk 在 log 文件中的起始 offset
  data: Uint8Array;     // 原始 PTY 字节
}

export interface ServerRef {
  id: string;           // 客户端本地 uuid
  name: string;         // 用户起的别名，如"家里台式机"
  baseUrl: string;      // e.g. "https://192.168.x.x:8443"
  token: string;        // Bearer token
}

export interface SessionSpec {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;        // default 80
  rows?: number;        // default 24
}
```

---

## 5. 协议 API（HTTP + SSE）

所有端点需带 `Authorization: Bearer <token>`，无认证返回 401。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET`  | `/v1/sessions` | 列出所有 session |
| `POST` | `/v1/sessions` | 创建 session，body = `SessionSpec` |
| `GET`  | `/v1/sessions/:id` | 获取单个 session 元数据 |
| `DELETE` | `/v1/sessions/:id` | 杀掉 session（PTY 进程） |
| `POST` | `/v1/sessions/:id/resize` | body `{cols, rows}`，调整 PTY 尺寸 |
| `GET`  | `/v1/sessions/:id/output?from=N&limit=B` | 拉取历史输出，返回 `{chunks: [{offset, data(base64)}], upTo}` |
| `POST` | `/v1/sessions/:id/input` | body `{data: base64}`，写入 PTY |
| `GET`  | `/v1/sessions/:id/stream` | **SSE**，事件流（见下） |

### 5.1 SSE 事件格式

```
event: output
data: {"offset":1234,"data":"aGVsbG8gd29ybGQK"}

event: state
data: {"id":"...","status":"running","byteOffset":5678,...}

event: heartbeat
data: {"ts":1721000000000}
```

- `output`：PTY 新输出到达
- `state`：session 状态变化（starting → running → exited）
- `heartbeat`：每 15s 一次，防中间代理超时

---

## 6. 断线续传数据流

```
T1: 首次打开 TerminalScreen
    1. offsetTracker.get(serverId, sessionId) → 0 (首次)
    2. GET /v1/sessions/:id/output?from=0&limit=102400  ← 拉最近 100KB
    3. 解码 chunks → postMessage 给 WebView → xterm.js 写入
    4. offsetTracker.set(totalBytes)
    5. EventSource(/v1/sessions/:id/stream) 打开

T2: 网络中断
    1. EventSource.onerror → reconnect.ts 触发指数退避
    2. PTY 在 server 继续跑，输出持续 append 到 log 文件

T3: 重新打开 app (几小时后)
    1. 读 offsetTracker → 100KB
    2. GET /v1/sessions/:id/output?from=100KB → 拉取断开期间所有输出
    3. xterm.js 追加显示
    4. 重开 EventSource

T4: 用户关闭 app / 退出 screen
    1. Subscription.close() → EventSource.close()
    2. PTY 继续在 server 运行
```

**关键不变量**：offsetTracker 是 client 本地状态；丢失则重置 0（重新拉历史）。服务端不依赖任何客户端连接状态。

---

## 7. 项目结构

```
clssw-terminal/
├── package.json                 # workspaces: ["packages/*"]
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── README.md
├── packages/
│   ├── protocol/                # 共享类型 + Transport 接口 + HTTP+SSE 实现
│   ├── server/                  # Node.js daemon
│   └── client/                  # Expo App
└── docs/
    └── superpowers/
        └── specs/
            └── 2026-07-15-clssw-terminal-design.md  (本文件)
```

详细文件清单见 plan 文档。

---

## 8. 实施阶段

| 阶段 | 内容 | 验证方式 |
|------|------|----------|
| 1. 脚手架 | monorepo + protocol 接口 | `pnpm -r build` |
| 2. Server | PTY + 存储 + REST + SSE | curl 冒烟测试 |
| 3. Client | Expo 路由 + 列表页 + Terminal View | Expo DevTools 启动 |
| 4. SSE + 重连 | stream 端点 + offsetTracker | 手动断网测试 |
| 5. 跨平台 | macOS/Linux/Windows server 真机测试 | claude session E2E |
| 6. 打包 + 文档 | 构建脚本 + EAS + README | EAS Build |

---

## 9. MVP 范围之外（明确不做）

- 推送通知（邮件 / ntfy / Pushover 等）
- 结构化事件识别（"claude 在等用户确认" / "工具调用完成"）
- WebSocket transport（接口预留，不实现）
- Log 文件轮转 / 压缩
- 用户管理 / 多用户 / 权限分级
- 服务端 CLI / 本地管理 UI
- 终端 resize 的精细同步（MVP 只在创建时指定 cols/rows）
- 跨平台打包发布（MVP 跑源码即可）

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `node-pty` native 编译在 Windows / ARM Linux 出问题 | 用 prebuilt 二进制；README 注明系统依赖 |
| WebView 在某些 Android 设备的 IME 问题 | MVP 用独立 InputBar，绕过 xterm 内部键盘 |
| SSE 在某些代理下被缓冲 | server 端禁用缓冲（`X-Accel-Buffering: no`），定期 heartbeat |
| SQLite 写并发问题 | better-sqlite3 同步 API，单写者 |
| Log 文件无限增长 | MVP 不做轮转；README 注明定期清理 |

---

## 11. 总结

- **单一可执行的实施方案**：monorepo 三包（protocol / server / client）
- **MVP 用 HTTP + SSE 实现 `Transport`**，未来加 WebSocket 实现无需改 client/server 业务代码
- **数据持久化**：SQLite（元数据）+ append-only log 文件（PTY 字节流），简单可靠
- **断线续传**：client 端 offset 跟踪 + server 端 `from` 参数拉历史，天然支持"即用即连"
- **分 6 个阶段实施**，每个阶段可独立验证
