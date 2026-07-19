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

### Token 管理

- **简要说明**：Manager 支持多 token 管理。启动时若未配置 token 则自动生成；Web UI 新增 token 管理页面，支持创建、重置、删除 token，并可设置每个 token 可访问的 agent 列表（admin token 拥有全部权限）。
- **设计文档**：[.claude/plans/packages-manager-token-manager-token-to-zesty-waffle.md](./docs/not-impl/packages-manager-token-manager-token-to-zesty-waffle.md)
- **状态**：📋 设计中
- **预估改动范围**：
  - Manager 后端：`storage.ts`（新表 + 迁移）、`config.ts`、`index.ts`、`auth.ts`、`routes/auth.ts`、`routes/tokens.ts`（新建）、`routes/proxy.ts`、`app.ts`
  - Protocol 共享层：`types.ts`、`Transport.ts`、`HttpSseTransport.ts`
  - Web 前端：`AuthContext.tsx`、`TokenListPage.tsx`（新建）、`App.tsx`、`styles.css`
