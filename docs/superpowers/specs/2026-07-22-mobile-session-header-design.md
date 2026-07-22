# 移动端 session header 紧凑化 — 设计文档

- 日期：2026-07-22
- 分支：`fix/mobile-header-compact-20260722`
- 状态：已评审通过，待实现

## 背景与目标

`PtySessionViewMobile.tsx`（已通过 `fix/session-pc-mobile-split-20260722` 拆分出来）当前 header 区共占约 **76px 高度 + 46px 横向**：

| 元素 | 来源 | 尺寸 |
|---|---|---|
| `chat-header` 行 | styles.css:541 | 36px avatar + 10+10 padding = 56px |
| 圆形 PC 头像 `chat-avatar-pc` | line 52 | 36×36，仅显示 "PC" 文字 |
| `chat-title-host` 副标题 | line 55 | 11px，独立一行（<480px 才隐藏） |
| `chat-status` 整条状态栏 | line 60-69 | 单行 ~20px，**与 header 内的 status dot 重复** |
| 返回键 36×36 | styles.css:552 | 横向 +10px gap |

移动端屏幕上 xterm 可见区域被严重挤压（典型 iPhone SE 360×640：640 − 76 header − ~200 键盘 − IME 安全区 ≈ **340px 实际终端**）。

**本次目标**：仅改移动端（`<768px`），不动 PC 端任何样式或 JSX。把 header 区压到 **48px 高、46px 横向释放**。

## 决策记录

| 问题 | 决策 | 理由 |
|---|---|---|
| 是否改 desktop？ | ❌ 不改 | 用户明确约束；desktop 体验没抱怨 |
| `chat-avatar` 36×36 圆形头像 | 完全去掉 | 用户确认；无视觉信息量（只有 "PC" 文字） |
| `chat-title-host` 副标题 | 移动端全隐藏（`<768px`） | 用户确认；本来 `≤480px` 才隐藏是断点太宽 |
| `chat-status` 独立一行状态条 | 折到 header 内右侧 | 用户确认；状态文字比 2px color bar 信息密度高得多（"disconnected: <reason>" 用户能读到原因） |
| 返回键尺寸 | 32×32（原 36×36） | 用户确认；节省 8px 横向、不影响触控 |
| 状态可视化方式 | 文字 + color + animation（复用 `chat-pulse`） | 与现有 chat-status-* 调色板一致 |
| 状态文字截断策略 | `max-width: 50%` + ellipsis | 优先保护标题可见性，状态文字可截断 |
| 持久模式（persistent）差异化 | 否；用同一紧凑 header | 结构相同；mobile 上无论 process/persistent 都不需要 host 行 |

## 设计方案

### 1. JSX 改动 — `packages/web/src/components/pty/PtySessionViewMobile.tsx`

仅修改该文件一处 JSX（header 内三处删除 + 一处新增），其余 import / props / state 全部不变。

**删除**：
```tsx
<span className="chat-avatar chat-avatar-pc" aria-hidden>PC</span>
```

**删除**（整个 status row，line 60-69）：
```tsx
<div className={'chat-status chat-status-' + status} role="status">
  <span className="chat-status-bar" />
  <span className="chat-status-text">…</span>
</div>
```

**新增**（提取状态映射常量，逻辑分支不变，只换渲染位置）：
```tsx
const STATUS_LABEL: Record<typeof status, string> = {
  typing: 'typing…',
  live: 'live',
  connecting: 'connecting…',
  error: 'disconnected: ' + (transportError || 'unknown'),
  offline: 'session has exited',
};
```

**替换 header**：
```tsx
<header className="chat-header">
  {onBack && (
    <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
  )}
  <div className="chat-titles">
    <span className="chat-title-name">{sessionLabel || '…'}</span>
  </div>
  <span
    className={'chat-status-merged chat-status-merged-' + status}
    aria-label={'status: ' + STATUS_LABEL[status]}
  >
    {STATUS_LABEL[status]}
  </span>
  <span className={'chat-status-dot dot-' + sessionStatus} aria-hidden />
</header>
```

`status` / `sessionStatus` 计算逻辑保持原状（line 37-44），只在渲染位置变化。

### 2. CSS 改动 — `packages/web/src/styles.css`

所有 mobile 规则包在 `@media (max-width: 767px)`；desktop 既有 `@media (min-width: 768px)` 完全不动。

**新增**（插入 `styles.css` 中、`@media (hover: none)` 块之前，标注 `[mobile-only] session header compact`）：

```css
/* [mobile-only] Compact session header — no avatar, status merged into title row */
@media (max-width: 767px) {
  .chat-header  { padding: 8px 12px; gap: 8px; min-height: 44px; }
  .chat-back    { width: 32px; height: 32px; font-size: 18px; }
  .chat-avatar  { display: none; }
  .chat-title-host { display: none; }
  .chat-status  { display: none; }
}

.chat-status-merged {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50%;
  flex-shrink: 0;
  animation: chat-pulse 1s ease-in-out infinite;
}
.chat-status-merged.connecting { color: var(--connecting-color); }
.chat-status-merged.typing     { color: var(--typing-color); font-weight: 600; }
.chat-status-merged.live       { color: var(--live-color); }
.chat-status-merged.error      { color: var(--error-color); }
.chat-status-merged.offline    { color: var(--offline-color); }

@media (prefers-reduced-motion: reduce) {
  .chat-status-merged { animation: none; }
}
```

**不动**：
- 现有 `.chat-header` / `.chat-back` / `.chat-avatar` / `.chat-titles` / `.chat-title-name` / `.chat-title-host` / `.chat-status` / `.chat-status-dot` 的桌面规则
- 现有 `@media (max-width: 360px)` 和 `@media (max-width: 480px)` 旧 breakpoint（保留向下兼容）
- 现有 `@keyframes chat-pulse` / `chat-shimmer`（复用）
- `var(--text-dim)` / `var(--live-color)` / `var(--typing-color)` / `var(--connecting-color)` / `var(--error-color)` / `var(--offline-color)` 颜色变量

### 3. 高度 / 横向预算

| 维度 | 现状 | 优化后 | 节省 |
|---|---|---|---|
| Header 高度 | 56px | 48px | -8px |
| Status row | 20px | 0（折进 header） | -20px |
| 横向（avatar + gap） | 46px | 0 | -46px |
| **总减少** | 76px / 46px 横 | — | **-28px 高度 / -46px 横向** |

以 iPhone SE 360×640 为例：
- 移动前 xterm 可见区 ≈ 340px（640 − 76 header − ~200 keyboard − ~24 safe-area）
- 移动后 xterm 可见区 ≈ **368px**（+28px，+8.2% 可视区域），返回键和键盘不冲突，标题有更多横向空间

### 4. 数据流 & 状态计算

零变化。`status: 'typing' | 'live' | 'connecting' | 'error' | 'offline'` 计算逻辑保持原样（line 37-42），仅渲染位置从独立 row 变为 header 内 inline span。

`STATUS_LABEL` 映射和现有 inline switch 一一对应：
- `typing` → "typing…"
- `live` → "live"
- `connecting` → "connecting…"
- `error` → "disconnected: " + (transportError || 'unknown')
- `offline` → "session has exited"

### 5. 错误 & 边缘场景

| 场景 | 行为 |
|---|---|
| `disconnected: <reason>` 超长（>30 字符） | 状态文字按 `max-width: 50%` 截断，标题仍可见 |
| Resize mobile → desktop | `@media (max-width: 767px)` 不命中，desktop 既有规则生效，avatar/host/status row 自动恢复 |
| Resize desktop → mobile | mobile CSS 命中，结构切换 |
| 横屏 568px（iPhone 横屏） | 仍 <768px → mobile 紧凑布局；保留 `chat-back` 32×32 触控安全 |
| iPad 768px / 1024px | 768 ≥ 768 → `@media (min-width: 768px)` 命中 → 走 desktop 布局（不变） |
| sessionLabel 为空 | 显示 "…" 占位（已有逻辑） |
| `prefers-reduced-motion` | `.chat-status-merged { animation: none; }` 关闭 pulse |
| IME 系统键盘弹出 | 不影响 header（header 在 IME 之上的 fixed 布局上下文外 —— 由 `.chat-panel` flex 控制） |

### 6. 测试

本次纯样式/JSX 增量，不改 props/state/类型，无新逻辑路径 → **不需要新单元测试**。

**手动验证**（DevTools 移动端 + 真机）：

| 场景 | 期望 |
|---|---|
| iPhone SE 360×640 (mobile) | header ≈ 48px 高，无 PC 头像，无 serverRef 那行，标题 + 状态文字单行 |
| iPhone 14 Pro 393×852 (mobile) | 同上 |
| Desktop 1280×800 (`≥768px`) | 完全保留现有桌面布局（avatar 在、host 行在、控制条 toggle 在） |
| 连接中状态 | header 右侧 "connecting…" 蓝字 |
| typing (命令执行中) | "typing…" 橙色加粗 |
| 401 / 断网 | 红色 "disconnected: <reason>"，超长省略 |
| session exited | 灰色 "session has exited" |
| 横竖屏切换 | header 在 mobile/desktop 间正确切换无残留 |
| `npm run typecheck` | 零错误 |

### 7. 文件改动清单

| 文件 | 行数估算 |
|---|---|
| `packages/web/src/components/pty/PtySessionViewMobile.tsx` | -8 行（删 avatar span + 整个 chat-status row）/ +12 行（新增 STATUS_LABEL + merged span），净 +4 |
| `packages/web/src/styles.css` | +30 行（mobile-only block + chat-status-merged 类 + reduced-motion）/ -0 |
| `docs/superpowers/specs/2026-07-22-mobile-session-header-design.md` | 本文档（独立 commit） |

合计约 +34 行。

### 8. 不在范围

- ❌ 改 desktop / PC 任何样式或 JSX
- ❌ 改 status 文字措辞
- ❌ 改 status 计算逻辑 / 重命名 status 类型
- ❌ 改 `chat-status-*` 既有动画 keyframes
- ❌ 改 `PtySessionViewDesktop.tsx` / `PtySessionView.tsx` (entry)
- ❌ 改 `shared.ts`
- ❌ 引入新组件 / 新 CSS 文件
- ❌ 改 status 持久化或 reconnect 逻辑
- ❌ 重做 header backdrop blur / 玻璃特效

## 兼容 & 风险

- **向后兼容**：desktop 完全不动；mobile 老用户的视觉习惯会变（avatar 消失 + status row 不再独立），预期 1-2 次会话后适应
- **协议层**：零影响。`@tired-agent/protocol` 任何字段不变
- **CSS 优先级**：mobile-only 块使用 `@media (max-width: 767px)`，与既有 `<360px` / `<480px` 规则是包含关系（外层先命中），不会冲突
- **可回滚**：纯样式 + JSX 改 revert 即可
- **Animation 副作用**：复用 `chat-pulse` 不影响其它聊天页面（类名 `chat-status-merged` 是新类，原 `chat-status-text` 不再使用）
