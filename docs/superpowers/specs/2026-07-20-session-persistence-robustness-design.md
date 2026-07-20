# Session 持久化与 Agent 鲁棒性 —— 设计文档

- 日期：2026-07-20
- 分支：`feat/session-persistence-robustness-20260720`
- 状态：已评审通过，待实现

## 背景与目标

针对 tired-agent 当前四个问题给出修复设计：

1. **持久（Claude 对话）会话的历史上下文不完整**：重开会话看不到"用户问了什么"。
2. **agent 重启后 persistent 会话无法访问**：发消息 / 连 SSE 报 `Session not found`，且 Claude 上下文断裂。
3. **确认 session 信息的持久化归属**：应在 agent 侧，换 manager 仍可见。
4. **提升 agent 进程鲁棒性**：异常不应直接拖垮进程；补齐各平台服务管理脚本。

## 现状调查结论（关键事实）

- **Session 元信息**持久化在 **agent 侧** SQLite：`~/.tiredagent/tired-agent.db.sqlite`（`packages/agent/src/session/storage.ts`）。
- **PTY / Claude 输出**以原始字节 append-log 到 `~/.tiredagent/sessions/<id>.log`（`storage.ts` `appendOutput`）。
- **Manager 是纯代理**（`packages/manager/src/routes/proxy.ts`），不持久化任何 session 数据；只维护 `manager_agents`（agent 注册表 + token）和 `manager_sessions`（浏览器登录态）。因此 session 列表数据源在 agent，换 manager 连同一 agent 仍可见（问题 3 基本已满足）。
- **persistent 模式机制**（`manager.ts` `_handlePersistentMessage` / `_spawnPersistentPty`）：**无常驻进程**；每轮用户消息 spawn 一个短命 `claude -p <content> --output-format stream-json --verbose [--resume <claudeSessionId>]`，输出 NDJSON，进程跑完即退。上下文靠 `--resume <claudeSessionId>` 维持，`claudeSessionId` 从 NDJSON 的 `session_id` 抓取。
- 前端重开会话时，`ClaudeChatView` / `PtySessionView` 挂载即 `fetchOutput(0)` 拉全量历史喂 renderer，随后 `subscribe()` 开 SSE；由于客户端 SSE URL **不带 `from`**，服务端默认 `from=0`，导致历史被**回放两遍**。

### 问题根因定位

- **问题 1 根因**：`_handlePersistentMessage` 拿到用户 `content`，但只把 claude 进程 stdout/stderr 落盘，**从不把用户 prompt 写进 `<id>.log`**（`manager.ts:272-295`）。所以回放时间线缺"用户气泡"，看起来是残缺的单边对话。
- **问题 2 根因**：
  - `claudeSessionId` 仅存于内存 `LiveSession.claudeSessionId`，**从不落库**（DB schema 与 `SessionRecord` 均无此字段）→ 重启后丢失 → 下一条消息不带 `--resume` → Claude 上下文断裂。
  - 重启后 `live` Map 为空，而 `subscribe()` / `write()` 只认 `live`，不在其中即 `throw Session not found`（`manager.ts:145-150, 85-97`）。`reconcileWithStorage` 对 persistent 记录仅跳过"标记 exited"，不做 rehydrate。
- **问题 4 根因**：`uncaughtException`/`unhandledRejection` 注册时机偏晚（`index.ts:118-123`，启动阶段抛错无兜底）且只 log；PTY/child_process 回调（`onData`/`onExit`、`stdout`/`stderr`/`exit`）与 SSE stream handler 无 try/catch；`_killPty` 在 ESM 下用 `require('node:child_process')`；仓库**无任何平台服务脚本**。

## 设计方案

### 工作流 A —— 完整对话历史（问题 1）

存储原则：**一个 session 一个文件，按对话时间线存储在 agent 数据目录 `sessions/` 下**（复用现有 `<id>.log`，随 `storage.delete(id)` 一起删除，不入 DB）。

- **写入用户消息**：`_handlePersistentMessage` 在 spawn claude **之前**，先把用户输入作为一条带时间戳、带命名空间类型的 NDJSON 事件 append 进同一个 `sessions/<id>.log`：

  ```json
  {"type":"tired-agent/user","content":"<用户输入>","at":<epoch_ms>}
  ```

  - 通过 `storage.appendOutput(id, bytes)` 写入（保证 byteOffset 更新一致），并 `broadcast` 给在线订阅者，使正在观看的客户端也能即时看到自己的消息气泡。
  - 类型加 `tired-agent/` 命名空间前缀，避免与 Claude 自身 `{"type":"user",...}`（tool_result）冲突。

- **回放渲染**：`ClaudeRenderer._parseLine` 增加分支识别 `type === 'tired-agent/user'`，push 一个用户消息气泡（复用现有 `userMessage` StructuredContent / `addUserMessage` 逻辑）。历史与实时走同一 `processChunk` 入口，重开会话即可看到完整双向对话。

- **消除双重回放**：客户端 `HttpSseTransport.subscribe()` 在 SSE URL 上带 `?from=<当前 byteOffset>`（挂载时 `fetchOutput` 已拿到 `upTo`/session.byteOffset），使 SSE 只推新增量，历史不再被灌两遍。
  - 服务端 `stream.ts` 已支持 `from` 参数，无需改动服务端逻辑。

**验收**：重开一个已有对话，能按时间线看到"用户提问 → Claude 回复/工具调用"完整交替；历史不重复出现。

### 工作流 B —— 重启后 persistent 会话可用（问题 2）

- **持久化 `claudeSessionId`**：
  - agent SQLite `sessions` 表新增列 `claude_session_id TEXT`（`CREATE TABLE` + 迁移 `ALTER TABLE ... ADD COLUMN`，与现有 `mode` 列迁移风格一致）。
  - `SessionRecord`（`types.ts`）新增可选字段 `claudeSessionId?: string`；`Storage` 的 insert/update/get/list 映射该列。
  - `extractClaudeSessionId` 抓到 id 后，除写内存 `s.claudeSessionId` 外，同时 `storage.update({ id, claudeSessionId })` 落库。
- **启动 rehydrate**：在 `reconcileWithStorage`（或新增 `rehydratePersistent()`，在 `index.ts` 启动时调用）中，把所有 `mode='persistent'` 的记录重新放回 `live` Map：新建 `LiveSession { record, pty: null, subscribers: new Set(), claudeSessionId: record.claudeSessionId }`，**不 spawn 任何进程**。
- 效果：重启后 `subscribe()` / `write()` 不再抛 `Session not found`；下一条消息自动带 `--resume <claudeSessionId>`，Claude 上下文延续。

**验收**：创建 persistent 会话并对话若干轮 → 重启 agent → 重开该会话 → 历史完整可见 → 继续发消息，Claude 记得先前上下文。

### 工作流 C —— 进程鲁棒性（问题 4 上半）

- 全局 `process.on('uncaughtException')` / `process.on('unhandledRejection')` handler **提前到 `main()` 最开始**注册（消除启动窗口），保持"记录但不退出"策略。
- 给以下回调补 try/catch，防止磁盘满 / DB 锁把回调异常升级为 uncaughtException：
  - `_spawnAndAttach` 的 `pty.onData` / `pty.onExit`；
  - `_spawnPersistentPty` 的 `proc.stdout/stderr/on('exit')`。
- 给 `stream.ts` 的 SSE handler 外层加 try/catch（`readOutput` I/O、`writeHead`/`flushHeaders` 抛错兜底）。
- `_killPty` 改用顶层 `import { execSync } from 'node:child_process'`，移除 ESM 下不规范的 `require(...)`。

**验收**：模拟回调内抛错（如注入 storage 异常）不致进程退出；启动阶段异常有日志且不裸崩。

### 工作流 D —— 平台服务脚本（问题 4 下半）

目录 `packages/agent/service/`：

- **Linux systemd**：`tired-agent.service` 模板（`Restart=always`、`RestartSec`、`WantedBy=multi-user.target` 开机自启）+ `README`/安装说明（`systemctl enable --now`）。
- **Windows**：`install-service.ps1`（基于 nssm 将 `tired-agent start` 包装为 Windows 服务，配置崩溃自动重启）+ 说明；对无 nssm 场景提供 schtasks 开机自启的备选说明。
- 根 `README.md` 增补"部署 / 开机自启"章节，链接到上述脚本。

（本次不做 macOS launchd。）

**验收**：Linux 上 `systemctl` 可启停并崩溃自动重启；Windows 上服务可安装、开机自启、崩溃重启。

### 工作流 E —— token 重生修复（问题 3）

- `packages/manager/src/storage.ts` `registerAgent`：命中同一 `agentKey` 的已存在 agent 时，**复用现有 token**，仅 `UPDATE baseUrl, name`，不再 `randomBytes` 重生 token。
- 效果：agent 重复自动注册不再使旧 manager 失联。问题 3 现状 + 此修复即满足"换 manager 仍可见 session"。

**验收**：同一 agent 重复注册后，用旧 token 的 manager 仍能代理成功。

## 影响范围（文件清单，预估）

| 包 | 文件 | 变更 |
|---|---|---|
| agent | `src/session/manager.ts` | 用户消息写日志、claudeSessionId 落库、回调 try/catch、`_killPty` import、rehydrate |
| agent | `src/session/storage.ts` | `claude_session_id` 列 + 迁移 + 映射 |
| agent | `src/session/types.ts` | `SessionRecord.claudeSessionId` |
| agent | `src/index.ts` | 全局 handler 提前、启动时 rehydrate |
| agent | `src/routes/stream.ts` | SSE handler try/catch |
| agent | `service/*` | 新增 systemd unit + Windows 脚本 + 说明 |
| protocol | `src/HttpSseTransport.ts` | `subscribe()` 带 `?from=` |
| protocol | `src/types.ts` | `Session.claudeSessionId`（如需透出） |
| web | `src/renderer/builtins/claude.ts` | 解析 `tired-agent/user` 事件 → 用户气泡 |
| web | `ClaudeChatView.tsx` | 传入 `from` 给 subscribe（配合 protocol） |
| manager | `src/storage.ts` | `registerAgent` 复用 token |
| root | `README.md` | 部署章节 |

## 非目标（YAGNI）

- 不做 macOS launchd 脚本。
- 不改 persistent 为常驻进程模型。
- 不引入历史消息的 DB 存储（保持文件、随 session 删除）。
- 不做 `readOutput` 大文件流式优化（本次范围外）。

## 构建 / 验证

- protocol 必须先 build（web Vite alias 指向 protocol src）：`npm run build:protocol` → `npm run build:agent` → `npm run build:web`。
- `npm run typecheck` 全量通过。
- 手动验证：重开会话历史完整、重启后可续、崩溃注入不裸崩、服务脚本可用、旧 token manager 可用。

## 分支与合并

- 开发分支：`feat/session-persistence-robustness-20260720`（从最新 main 签出）。
- 完成后 PR → main。版本号修改在 main 上单独进行。
