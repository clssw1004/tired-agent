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

### Token 管理

- **简要说明**：Manager 支持多 token 管理。启动时若未配置 token 则自动生成；Web UI 新增 token 管理页面，支持创建、重置、删除 token，并可设置每个 token 可访问的 agent 列表（admin token 拥有全部权限）。
- **设计文档**：[.claude/plans/packages-manager-token-manager-token-to-zesty-waffle.md](./docs/not-impl/packages-manager-token-manager-token-to-zesty-waffle.md)
- **状态**：📋 设计中
- **预估改动范围**：
  - Manager 后端：`storage.ts`（新表 + 迁移）、`config.ts`、`index.ts`、`auth.ts`、`routes/auth.ts`、`routes/tokens.ts`（新建）、`routes/proxy.ts`、`app.ts`
  - Protocol 共享层：`types.ts`、`Transport.ts`、`HttpSseTransport.ts`
  - Web 前端：`AuthContext.tsx`、`TokenListPage.tsx`（新建）、`App.tsx`、`styles.css`
