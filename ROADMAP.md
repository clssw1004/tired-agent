# tired-agent 功能规划路线图

## 规划中

### Persistent Mode（持久化聊天模式）

- **简要说明**：对话式 Claude 聊天界面，与 PTY/xterm 模式共存。每个消息启动短期 `claude -p` 进程，通过 SSE 流式返回 NDJSON，前端渲染为气泡式聊天时间轴。
- **设计文档**：[docs/not-impl/persistent-mode-roadmap.md](./docs/persistent-mode-roadmap.md)
- **状态**：✅ 完成（commit `0cff5b2` on `feat/structured-mode-20260719`）
- **关键决策**：
  - **非 TTY spawn**：`_spawnPersistentPty` 改用 `child_process.spawn`（管道 stdio）而非 `node-pty.spawn`。原 PTY 模式下 Claude 把 stdout 当 TTY，输出 ANSI 光标定位码（如 `\x1b[23;80H`）"原地更新"，导致 NDJSON 行内 `:`、`,` 被覆盖、字符串被截断，无法 JSON.parse。管道模式下 Claude 输出干净 NDJSON，前端简单 `\n` 切分即可解析。
  - **fake IPty 适配器**：`_handlePersistentInterrupt` 依赖 PTY 的 `pid` + `kill()` API。用一个 `IPty` 适配对象包装 `ChildProcess`，保留 `pid` 与 `kill(sig)` 方法，最小化对周边代码的影响。
  - **PTY/Chat 组件分离**：`TerminalPage` 按 `session.mode` 路由 — `process` → `PtySessionView`（xterm + Passthrough），`persistent` → `ClaudeChatView`（独立聊天组件）。
  - **思考中占位清除**：收到 `text` 块时移除之前推送的 `思考中…` streamEvent 避免 thinking 指示器卡住。
  - **组件命名规范化**：PTY 专属组件加 `Pty` 前缀（`PtySessionView`、`PtyInputBar`、`PtyInterventionBar`），共享组件保持中性（`ChatTimeline`）。
- **实施任务**：
  - P1 SSE 行缓冲对齐：✅ 通过切换到非 TTY spawn 一次性解决，无需额外缓冲逻辑
  - P2 组件重命名：✅ 4 个组件重命名 + imports 更新
  - P3 历史持久化：✅ 依赖 P1 修复后自然生效，replay 路径解析干净 NDJSON

### Session 持久化与 Agent 鲁棒性

- **简要说明**：解决 4 个老问题 —— persistent session 历史残缺（用户消息未落盘）、agent 重启后无法续接（`claudeSessionId` 未持久化 + `live` Map 为空）、session 元信息持久化归属确认（agent 侧）、agent 进程鲁棒性 + 平台服务脚本。附带修复 manager 重复注册同 `agentKey` 时 token 重生导致旧 manager 失联的 bug。
- **设计文档**：[docs/superpowers/specs/2026-07-20-session-persistence-robustness-design.md](./docs/superpowers/specs/2026-07-20-session-persistence-robustness-design.md)
- **状态**：✅ 完成（PR #11，`c8c2a2c` on `feat/session-persistence-robustness-20260720`）
- **关键决策**：
  - 用户消息以 `{"type":"tired-agent/user","content":...,"at":...}` NDJSON 事件 append 进同一个 `sessions/<id>.log`，加 `tired-agent/` 命名空间避免与 Claude 自身 `user` 事件冲突。`ClaudeRenderer._parseLine` 增加分支识别并复用现有 `userMessage` 渲染。
  - `claudeSessionId` 落库：SQLite 新增 `claude_session_id TEXT` 列 + 迁移 + `SessionRecord.claudeSessionId?: string`；启动时 `rehydrate()` 把所有 `mode='persistent'` 记录放回 `live` Map（不 spawn 进程），下一次消息自动带 `--resume <id>`，上下文延续。
  - SSE 双重回放修复：客户端 `HttpSseTransport.subscribe()` 在 SSE URL 上带 `?from=<当前 byteOffset>`，使 SSE 只推新增量，历史不再被灌两遍。
  - 进程鲁棒性：`uncaughtException`/`unhandledRejection` 提前到 `main()` 开头注册，`onData`/`onExit`/`stdout`/`stderr`/SSE handler 全部加 try/catch，`_killPty` 用顶层 `import { execSync }` 替换 ESM 下不规范的 `require(...)`。
  - 平台服务脚本：新增 `packages/agent/service/` —— Linux `systemd` unit（`Restart=always`、`WantedBy=multi-user.target`）和 Windows `install-service.ps1`（基于 nssm）+ 备选 `schtasks`；根 README 增补"部署 / 开机自启"章节。本次不做 macOS launchd。
  - token 重生修复：`manager.registerAgent` 命中同一 `agentKey` 时复用现有 token，仅 `UPDATE baseUrl, name`，不再 `randomBytes`。

### Session 创建快捷选项 / 远程目录选择

- **简要说明**：`SessionCreatePage` 新增命令参数 chips（Bash `-i` / `-l`、PowerShell `-NoLogo` / `-NoProfile`、Python/Node `-i`、cmd `/d` 等）和远程 Agent 目录浏览弹窗（`DirectoryPickerModal`：home 起点、上一级、收藏、最近 10 条 cwd）。数据持久化在 Agent data 目录的 `directories.json`，换浏览器/换 Manager 仍可见。完成 3 项功能：`SessionSpec.cwd` 全链路兼容、收藏/最近目录重启 Agent 不丢、Manager 仅透传不解路径。
- **设计文档**：[docs/superpowers/specs/2026-07-21-session-create-shortcuts-design.md](./docs/superpowers/specs/2026-07-21-session-create-shortcuts-design.md)
- **状态**：✅ 完成（PR #13，`943d774` on `feat/session-create-shortcuts-20260721`）
- **关键决策**：
  - 第一版用前端内置固定预设（Claude/Bash/Zsh/cmd/PowerShell/Python/Node），不做用户自定义命令模板管理。
  - 目录接口语义：API 只返回目录列表（不读文件内容），路径由服务端规范化为绝对路径；`parent` 在根目录返回 `null`，浏览器自己算的"上一级"不靠谱。
  - 数据归属：收藏目录 + 最近目录存放在 Agent 的 `<cfg.dataDir>/directories.json`，原子写（`tmp + rename`）+ Promise 串行化；最近上限 10 条按 `lastUsedAt` 倒序；Windows 大小写不敏感去重。
  - 写入时机：`recordRecent` 只在 session 创建成功之后调用，写入失败只记 warning、不能让已创建的 session 返回失败。
  - 不引入浏览器原生 `showDirectoryPicker`，避免混淆"本机目录"与"远程 Agent 目录"语义。

### Session 默认命名 + PTY tail 快速进入

- **简要说明**：未填 label 时自动生成 `8位字符_完整时间戳` 默认名（去掉 0/1/l/o 等易混字符，绝对唯一，~22 字符）。大输出 PTY session 首次进入支持 `?tail=N` 只读末尾 N 字节（默认 64KB）；UI 显示"已加载 X / 共 Y"banner + "加载完整历史"按钮。持久模式（NDJSON 解析）不启用 tail，避免破坏 JSON 边界。
- **设计文档**：[docs/superpowers/specs/2026-07-21-session-name-and-pty-tail-design.md](./docs/superpowers/specs/2026-07-21-session-name-and-pty-tail-design.md)
- **状态**：✅ 完成（PR #14，`37e2c12` on `feat/session-name-and-pty-tail-20260721`）
- **关键决策**：
  - `?tail` 与 `?from+limit` 互斥（zod `refine` 校验），tail 优先；老 agent 不返回 `truncated`/`totalBytes` 时前端用 `=== true` 判断，零回归。
  - `Storage.readOutputTail` 用 `openSync/readSync/closeSync` 倒序 seek，避免 `readFileSync` 整个日志；UTF-8 切在 tail 边界采用 fatal:false 解码 + U+FFFD 替换。
  - 默认名时区使用本地时间，与 SessionCard 的 "X minutes ago" 体验一致。

### Mobile PTY 键盘

- **简要说明**：移动端 PTY 模式新增可折叠 QWERTY 触控键盘（`PtyMobileKeyboard`），替代 `SpecialKeysBar + PtyInputBar`；修复 Safari xterm 横向滚动条（canvas `max-width: 100%`）、IME portal（`createPortal` 到 `document.body` 规避 `backdrop-filter` 破坏 `position:fixed` 的 Safari bug）、桌面 `display:none` 不可靠改为 JS 条件渲染（`isMobile`）。
- **状态**：✅ 完成（PR #16，`f904b1e` on `feat/mobile-pty-keyboard-20260721`）

### 长效登录（"记住我" + 15 天 TTL + 自动续期）

- **简要说明**：登录表单增加"记住我"勾选框（可选项，**默认不勾选**）。
  - **勾选时**：session token 持久化到 `localStorage`，TTL = 15 天，启动后客户端自动续期避免被动过期；TTL 默认值可由 ManagerConfig 覆盖。
  - **不勾选时**：session token 写入 `sessionStorage`（tab 关闭即失效），TTL 保留现有 24h，行为完全不变。
  - 升级兼容：未改动的旧 session 走原 24h 路径（无需迁移），新登录按新规则。
- **状态**：📋 设计中
- **预估改动范围**：
  - Manager 后端：`storage.ts`（`createSession` 接受 `ttlMs`）、`config.ts`、`index.ts`、`auth.ts`、`routes/auth.ts`、`app.ts`
  - Protocol 共享层：`types.ts`、`Transport.ts`、`HttpSseTransport.ts`
  - Web 前端：`AuthContext.tsx`、`LoginPage.tsx`、`App.tsx`
- **关键决策**：
  - **服务端 storage**：`createSession(ttlMs: number)` 接受任意 TTL；旧调用点显式传 `SESSION_TTL_MS` (24h)，新调用按 `remember` 传 `15 * 86400 * 1000`。`manager_sessions` 表结构不变。
  - **登录请求体**：`POST /v1/manager/auth/login` 接受 `{token, persist?: boolean}`，default false；返回 `{sessionToken, expiresAt, persist}`。
  - **自动续期接口**：新增 `POST /v1/manager/auth/refresh`（需要现有 session token 鉴权，401 不允许匿名刷新）。SQLite 事务里 "DELETE 旧 token + INSERT 新 token" 原子完成，避免并发 refresh 把同一个旧 token 续两次；返回新的 `{sessionToken, expiresAt}`。
  - **客户端续期触发**（按优先级）：
    1. **被动**：任意 2xx 响应后，"剩余有效期 < 7 天" 时静默触发 refresh（一次）；
    2. **主动**：mount 后起 timer 每 1h 检查一次 expiresAt；
    3. **被动**：401 收到时立即尝试一次 silent refresh；refresh 成功则重放原请求，refresh 失败 → 注销回登录页；
    4. **visibilitychange**：页面从 hidden 变 visible 时补一次检查（弥补 tab 长时间 sleep 后 timer 被节流的问题）。
  - **timer 清理**：timer / abort controller 必须在 unmount 时 clear；不允许 `setInterval` 在 `useEffect` 外裸跑。
  - **前端 storage 双路径**：
    - `localStorage`：key 仍 `tired-agent:manager-session-token`，勾选且 `persist=true` 时用；
    - `sessionStorage`：key 改为 `tired-agent:manager-session-token-session`（或独立前缀），勾选 false 时用；
    - 切换 baseUrl 时两种 key 都清。
  - **管理器配置**：新增 `ManagerConfig.sessionTtlMs`（持久模式 TTL，默认 `15 * 86400 * 1000`）、`sessionRefreshWindowMs`（"小于这个值就刷"，默认 `7 * 86400 * 1000`）、`sessionNonPersistTtlMs`（不持久模式 TTL，默认 `24 * 3600 * 1000`）。
- **实施任务**：
  - P1 Manager `storage.ts`：`createSession` 接受 `ttlMs`，旧 24h 调用点显式传原 TTL 常量。
  - P2 Manager `routes/auth.ts`：login schema 加 `persist` 字段；新 `POST /v1/manager/auth/refresh` 路由 + handler，事务内 delete+insert。
  - P3 Protocol `Transport.ts` / `HttpSseTransport.ts`：新增 `refreshSession(ref, currentToken)` 方法（用现有 token POST refresh，返回新 `{sessionToken, expiresAt}`）。
  - P4 Web `AuthContext.tsx`：存储路径按 `persist` 切换（`sessionStorage` vs `localStorage`）；`sessionToken` state 同时持有 `expiresAt`；新增 `refreshSession()` 内部方法；`connectAndLogin(url, token, remember)` 签名扩 `remember`。
  - P5 Web `LoginPage.tsx`：UI 增加"记住我" checkbox（默认 false），提交时把值传到 `connectAndLogin`；勾选后 placeholder hint 提示"可保持 15 天"。
  - P6 Web `App.tsx`：mount effect 起 refresh timer（1h）+ visibilitychange listener；任意 transport 调用 wrapper（fetch 拦截层或显式 refetch）做"剩余有效期 < 7d → 静默 refresh"；refresh 流程加防抖与并发合并（同一 token 在刷新中时复用进行中的 Promise）。
  - P7 测试：manager 测试覆盖 `createSession(ttlMs)`、refresh 并发安全（同 token 第二次 401）；web 类型检查 + 手动验证两个 storage 路径 + 401 后 silent refresh + 路径回退登录。
- **不在范围**：
  - 不做多 token 模型（`manager_tokens` 表、token CRUD UI、`TokenListPage`）——推迟到后续轮次；
  - 不做 token 级别的 ACL / scopes / 按 token 限定 agent 可见范围；
  - 不做跨设备同步、多设备并行登录提示、强制踢人；
  - "记住我" 的 UI 反馈条 / "N 天后过期" 系统通知延后。
