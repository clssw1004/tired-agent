# Persistent Mode 路线图

## 当前状态

Persistent mode（`mode: 'persistent'`）已完成 protocol/agent/web 基本架构：session 创建、Claude PTY 启动、SSE 流式输出。但前端时间轴不显示内容。

## 遗留问题

### P1：SSE 行缓冲（chunk 切碎 JSON）

**问题：** `node-pty` 的 `onData` 可能在 NDJSON 行中间截断。SSE 直接转发这些截断的 chunk，导致客户端 renderer 收到不完整 JSON，`JSON.parse` 失败，整条消息丢失。

**方案：** 在 `packages/agent/src/routes/stream.ts` 的 SSE handler 中，对 `persistent` 模式做行缓冲：

```
收到 output event → decode bytes 为文本 → 追加到行 buffer
→ 按 \n 切分 → 完整行作为独立 event: output 发出
→ 不完整行留在 buffer 等下一个 chunk
→ process 模式保持原样（二进制 passthrough）
```

**文件：** `packages/agent/src/routes/stream.ts`

**关键点：**
- 通过 `session.mode` 判断是否缓冲
- replay 路径（初次连接历史回放）同样需要行缓冲
- offset 用原始 chunk offset（近似值，客户端不依赖精确 seek）

---

### P2：组件重命名

PTY 专属组件改名以区分 persistent 模式：

| 当前 | 改为 | 文件 |
|------|------|------|
| `ChatContainer` | `PtySessionView` | `packages/web/src/components/ChatContainer.tsx` |
| `ChatTimelineView` | `ChatTimeline` | `packages/web/src/components/ChatTimelineView.tsx` |
| `InputBar` | `PtyInputBar` | `packages/web/src/components/InputBar.tsx` |
| `InterventionBar` | `PtyInterventionBar` | `packages/web/src/components/InterventionBar.tsx` |

同时更新 `TerminalPage.tsx` 中的 import 和引用。

---

### P3：历史持久化

再次进入 persistent session 时时间轴不显示上次对话。修复 replay 路径即可：

1. `fetchOutput` 获取全部历史 PTY 输出
2. renderer 重新解析 NDJSON → `StructuredContent[]`
3. 时间轴渲染

前提是 P1 修复后 replay 路径同样受益。

---

## 测试验证

1. 创建 persistent session，发消息 → 时间轴正确渲染 assistant 回复
2. 刷新页面/重新进入 session → 上次对话可见
3. process 模式的 PTY session 不受影响
