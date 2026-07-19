# tired-agent 功能规划路线图

## 规划中

### Persistent Mode（持久化聊天模式）

- **简要说明**：对话式 Claude 聊天界面，与 PTY/xterm 模式共存。每个消息启动短期 `claude -p` 进程，通过 SSE 流式返回 NDJSON，前端渲染为气泡式聊天时间轴。
- **设计文档**：[docs/not-impl/persistent-mode-roadmap.md](./docs/persistent-mode-roadmap.md)
- **状态**：✅ 完成
  - P1 SSE 行缓冲：`manager.ts` 源头缓冲，存储 + broadcast 均为完整 NDJSON 行
  - P2 组件重命名：ChatContainer→PtySessionView，ChatTimelineView→ChatTimeline，InputBar→PtyInputBar，InterventionBar→PtyInterventionBar
  - P3 历史持久化：依赖 P1 修复后自然生效

### Token 管理

- **简要说明**：Manager 支持多 token 管理。启动时若未配置 token 则自动生成；Web UI 新增 token 管理页面，支持创建、重置、删除 token，并可设置每个 token 可访问的 agent 列表（admin token 拥有全部权限）。
- **设计文档**：[.claude/plans/packages-manager-token-manager-token-to-zesty-waffle.md](./docs/not-impl/packages-manager-token-manager-token-to-zesty-waffle.md)
- **状态**：📋 设计中
- **预估改动范围**：
  - Manager 后端：`storage.ts`（新表 + 迁移）、`config.ts`、`index.ts`、`auth.ts`、`routes/auth.ts`、`routes/tokens.ts`（新建）、`routes/proxy.ts`、`app.ts`
  - Protocol 共享层：`types.ts`、`Transport.ts`、`HttpSseTransport.ts`
  - Web 前端：`AuthContext.tsx`、`TokenListPage.tsx`（新建）、`App.tsx`、`styles.css`
