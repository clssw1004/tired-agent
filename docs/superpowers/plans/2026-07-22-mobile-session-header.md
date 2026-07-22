# 移动端 Session Header 紧凑化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把移动端 session 页面顶部从 ~76px / 含冗余 6 个元素，压缩到 ~48px / 单行 header 配状态文字。仅改 mobile（<768px），desktop 完全不动。

**Architecture:** PtySessionViewMobile.tsx 删除 PC 头像 span 和独立 chat-status row，新增 STATUS_LABEL 映射与 chat-status-merged span（折到 header 右侧）；styles.css 新增一段 `@media (max-width: 767px)` 规则 + `.chat-status-merged` 系列类（复用现有 `--typing-color` / `--live-color` 等变量与 `chat-pulse` 关键帧）。

**Tech Stack:** TypeScript、React 18、纯 CSS、现有 CSS 变量（`var(--text-dim)` / `var(--typing-color)` 等）、现有 `@keyframes chat-pulse`。无新依赖。

## Global Constraints

- 仅修改 mobile 端。desktop 既有 `@media (min-width: 768px)` 与默认规则一行不动。
- 所有 mobile 改动包在 `@media (max-width: 767px)` 块内，绝不污染 desktop。
- JSX 只改 `packages/web/src/components/pty/PtySessionViewMobile.tsx`。`PtySessionViewDesktop.tsx` / `PtySessionView.tsx` / `shared.ts` 不动。
- CSS 只追加（不删除既有规则）。新增段标 `[mobile-only] session header compact`。
- 状态文字映射必须覆盖全部 5 个状态（`typing` / `live` / `connecting` / `error` / `offline`），无遗漏。
- 不新增单元测试（纯样式 + JSX 增量，无新逻辑路径）。验证靠 DevTools 手动 + `npm run typecheck`。
- 实施分支 `fix/mobile-header-compact-20260722`，必须从最新的 main 切出（fetch + rebase 后切）。
- 不修改 `status` 状态类型、`STATUS_LABEL` 字段外的 status 计算逻辑（line 37-42）。

---

## 文件结构与职责映射

| 文件 | 操作 | 职责 |
| --- | --- | --- |
| `packages/web/src/components/pty/PtySessionViewMobile.tsx` | 修改 | 删除 avatar span + chat-status row；新增 STATUS_LABEL 映射 + chat-status-merged span |
| `packages/web/src/styles.css` | 修改（仅追加） | 新增 `@media (max-width: 767px)` 块（header/back/avatar/host/status 压缩规则）+ `.chat-status-merged` 系列类（5 个状态色 + reduced-motion 降级） |
| `docs/superpowers/specs/2026-07-22-mobile-session-header-design.md` | 已存在 | 需求 / 决策 / 方案 / 范围 / 风险（commit `3b81722`） |

无新组件、无新测试文件、无新协议字段。

---

### Task 1: 切出实施分支

**Files:**
- 仅 git 操作，无文件改动。

- [ ] **Step 1: 确认 main 是最新的**

```bash
cd C:\wspec\tired-agent
git switch main
git pull --ff-only
git log --oneline -1
```

预期：`docs(spec): 移动端 session header 紧凑化设计` 出现且 HEAD 是它（commit `3b81722`）。

- [ ] **Step 2: 切出实施分支**

```bash
git switch -c fix/mobile-header-compact-20260722
git branch --show-current
```

预期输出：`fix/mobile-header-compact-20260722`。

- [ ] **Step 3: 确认工作树干净**

```bash
git status
```

预期输出：`nothing to commit, working tree clean`。若有未提交内容，先 `git stash` 或 `git checkout --` 清理。

---

### Task 2: 改 PtySessionViewMobile.tsx 的 JSX

**Files:**
- Modify: `packages/web/src/components/pty/PtySessionViewMobile.tsx`

**Interfaces:**
- 不消费其他 task 的接口（纯 JSX 增量）。
- 产出 `STATUS_LABEL` 常量（5 个键）和新 span（className `chat-status-merged chat-status-merged-{status}`）。
- 后续 Task 3 的 CSS 类名必须与此对齐：`chat-status-merged` / `chat-status-merged-typing` / `chat-status-merged-live` / `chat-status-merged-connecting` / `chat-status-merged-error` / `chat-status-merged-offline`。

- [ ] **Step 1: 读取当前 line 27-69 区域确认结构**

```bash
sed -n '27,70p' packages/web/src/components/pty/PtySessionViewMobile.tsx
```

预期输出：line 48-58 是 `<header className="chat-header">` 块（含 back / avatar / titles / status-dot），line 60-69 是 `<div className="chat-status chat-status-{status}">` 块。

- [ ] **Step 2: 在 `status` 计算后（line 44 后）插入 STATUS_LABEL 常量**

定位：`PtySessionViewMobile.tsx` line 43 `const disabled = sessionStatus === 'exited';` 之后、`return (` 之前（即 line 44-46 之间）。

替换为：

```tsx
  const disabled = sessionStatus === 'exited';

  const STATUS_LABEL: Record<typeof status, string> = {
    typing: 'typing…',
    live: 'live',
    connecting: 'connecting…',
    error: 'disconnected: ' + (transportError || 'unknown'),
    offline: 'session has exited',
  };

  return (
```

注意：
- `STATUS_LABEL` 用 `Record<typeof status, string>` 类型锁定 5 键全覆盖；漏一个 TypeScript 会报"Property X is missing"。
- `transportError` 已有 fallback `|| 'unknown'`，与现状对齐。
- 不要改变 status 计算逻辑（line 37-42）。

- [ ] **Step 3: 替换 header JSX**

定位：`PtySessionViewMobile.tsx` line 48-58 整个 `<header className="chat-header">`...</header>` 块。

将：

```tsx
      <header className="chat-header">
        {onBack && (
          <button type="button" className="chat-back" onClick={onBack} aria-label="Back">‹</button>
        )}
        <span className="chat-avatar chat-avatar-pc" aria-hidden>PC</span>
        <div className="chat-titles">
          <span className="chat-title-name">{sessionLabel || '…'}</span>
          <span className="chat-title-host">{serverRef.name} · {serverRef.baseUrl}</span>
        </div>
        <span className={'chat-status-dot dot-' + sessionStatus} aria-label={'session ' + sessionStatus} />
      </header>
```

替换为：

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

注意：
- 删除 `<span className="chat-avatar chat-avatar-pc">`。
- 删除 `<span className="chat-title-host">`。
- 新增 `<span className={'chat-status-merged chat-status-merged-' + status}>`（折到 title 后面）。
- `<span className="chat-status-dot">` 保留但 `aria-label` 改 `aria-hidden`（语义由 chat-status-merged 接管，dot 仅作装饰）。

- [ ] **Step 4: 删除整个 chat-status row**

定位：`PtySessionViewMobile.tsx` line 60-69 整个 `<div className="chat-status chat-status-{status}">` 块（包括 chat-status-bar 和 chat-status-text 两个 span）。

将：

```tsx
      <div className={'chat-status chat-status-' + status} role="status">
        <span className="chat-status-bar" />
        <span className="chat-status-text">
          {status === 'typing' && 'typing…'}
          {status === 'live' && 'live'}
          {status === 'connecting' && 'connecting…'}
          {status === 'error' && 'disconnected: ' + transportError}
          {status === 'offline' && 'session has exited'}
        </span>
      </div>
```

整段删除（含周围的空行）。

- [ ] **Step 5: typecheck 验证**

```bash
cd C:\wspec\tired-agent
npm run typecheck
```

预期：4 个 workspace（protocol / agent / manager / web）全部 `> tsc --noEmit` 退出 0，零 error。

如果 typecheck 报 `Property 'X' is missing in type '...'` —— 检查 `STATUS_LABEL` 是否漏键。

- [ ] **Step 6: 提交 JSX 改动**

```bash
git add packages/web/src/components/pty/PtySessionViewMobile.tsx
git commit -m "fix(web): 移动端 session header 紧凑化 — 干掉 avatar/host/status row

- 删除 <span className=\"chat-avatar chat-avatar-pc\"> 与 chat-title-host
- 删除整个 <div className=\"chat-status\"> 行（与 header dot 重复）
- 提取 STATUS_LABEL 映射；新增 <span className=\"chat-status-merged\"> 折到 header 右侧
- 仅动 PtySessionViewMobile.tsx，desktop 既有规则不动

下一个 commit 加 CSS。"
```

预期：`fix/mobile-header-compact-20260722` 分支多 1 个 commit。

---

### Task 3: 追加 styles.css 的 mobile-only 规则

**Files:**
- Modify: `packages/web/src/styles.css`（仅追加，不删不改既有规则）

**Interfaces:**
- 消费 Task 2 的类名：`chat-status-merged` / `chat-status-merged-typing` / `chat-status-merged-live` / `chat-status-merged-connecting` / `chat-status-merged-error` / `chat-status-merged-offline`。

- [ ] **Step 1: 定位插入点**

```bash
cd C:\wspec\tired-agent
grep -n "^@media (hover: none)" styles.css | head -3
```

预期找到 line 1438（紧跟在 PtyMobileKeyboard 桌面隐藏规则之后的 `@media (hover: none)` 块）。在它之前插入即可（即 line 1436 之后）。

也可以选更上面的位置（紧跟在 line 1434 `.pty-keyboard { display: none; }` 的 `@media (min-width: 768px)` 之后），更符合"compact session header"的语义分组。

- [ ] **Step 2: 追加 mobile-only 块**

定位：`styles.css` line 1434 的 `@media (min-width: 768px) { .pty-keyboard { display: none; } }` 块结束后的空行之前。

在该块**闭合后**插入：

```css

/* [mobile-only] Compact session header — no avatar, status merged into title row */
@media (max-width: 767px) {
  .chat-header       { padding: 8px 12px; gap: 8px; min-height: 44px; }
  .chat-back         { width: 32px; height: 32px; font-size: 18px; }
  .chat-avatar       { display: none; }
  .chat-title-host   { display: none; }
  .chat-status       { display: none; }
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

注意：
- 5 个状态色必须用现有 CSS 变量（`--text-dim` / `--connecting-color` / `--typing-color` / `--live-color` / `--error-color` / `--offline-color`），不引入新色值。
- `chat-pulse` 是 line 668 既有 keyframes，不重写。
- 移动规则全部包在 `@media (max-width: 767px)` —— desktop ≥768px 完全不受影响。
- reduced-motion 块单独处理（不嵌套在 mobile media query 内，因为它是全局降级）。

- [ ] **Step 3: 验证 CSS 不污染 desktop**

```bash
cd C:\wspec\tired-agent
grep -n "chat-header\|chat-back\|chat-avatar\|chat-title-host\|chat-status\|chat-status-merged" styles.css | head -30
```

预期：
- 既有 `chat-header` / `chat-back` / `chat-avatar` / `chat-titles` / `chat-title-host` / `chat-status` / `chat-status-dot` 块全部保留原 line（不被删除）。
- 新增 `chat-status-merged` 系列 6 行（base + 5 状态色）。
- `@media (max-width: 767px)` 块出现 1 次。

如果既有规则缺失 → 编辑错误，立刻 `git diff styles.css` 检查回滚。

- [ ] **Step 4: typecheck 再次确认**

```bash
cd C:\wspec\tired-agent
npm run typecheck
```

预期：零 error。CSS 改动理论上不影响 TS，但保险跑一次。

- [ ] **Step 5: 提交 CSS 改动**

```bash
git add packages/web/src/styles.css
git commit -m "fix(web): 移动端 session header CSS — 紧凑布局 + chat-status-merged

- @media (max-width: 767px) 块：header padding 8px/12px、back 32×32、
  avatar/host/status row display:none
- .chat-status-merged 系列：12px tabular-nums，max-width:50% ellipsis
  5 个状态色复用现有 --typing-color/--live-color/--connecting-color/
  --error-color/--offline-color；typing/live 复用 @keyframes chat-pulse
- prefers-reduced-motion 降级：animation:none

桌面 @media (min-width: 768px) 既有规则完全不动。"
```

预期：`fix/mobile-header-compact-20260722` 分支再 +1 commit（共 2 个）。

---

### Task 4: 手动验证（DevTools 移动端模拟 + 桌面回归）

**Files:**
- 无文件改动，仅做视觉与功能验证。

- [ ] **Step 1: 启动 dev 服务器**

```bash
cd C:\wspec\tired-agent
npm run build:protocol
npm run dev:web
```

预期：Vite dev server 起在 :5173，输出：
```
  VITE vX.X.X  ready in XXX ms
  ➜  Local:   http://localhost:5173/
```

后台运行这个命令（用 `run_in_background: true`），验证完成后单独 stop。

- [ ] **Step 2: 桌面回归（≥768px）**

1. 浏览器打开 `http://localhost:5173/`，登录进入 agent
2. 进入任意 PTY session
3. **预期**：header 仍显示 PC 圆形头像、显示 `serverRef.name · baseUrl` 副标题、独立 chat-status 行、控制条 toggle 按钮（process 模式）
4. **不应**有 32×32 返回键、不应有 chat-status-merged 文字横排

- [ ] **Step 3: 移动端验证（375×667 iPhone SE / 360px 边界）**

1. Chrome DevTools → Toggle Device Toolbar (Ctrl+Shift+M) → 选 iPhone SE 375×667
2. 进入任意 PTY session
3. **验证清单**：
   - [ ] header 高度目测 ~48px（比优化前明显小）
   - [ ] 无 PC 圆形头像
   - [ ] 无 `serverRef · baseUrl` 副标题
   - [ ] 无独立的 "typing…/live/connecting…" 整行
   - [ ] header 单行排列：`[‹] sessionLabel  status-text ●`
   - [ ] status-text 默认灰色 "live"
   - [ ] 返回按钮 `‹` 32×32，比桌面版略小

- [ ] **Step 4: 状态变化验证（移动端）**

在移动端 view 下，让 session 处于不同状态：

| 状态 | 操作 | 期望 |
|---|---|---|
| connecting | 刷新页面 / 新建 session | header 右侧 "connecting…" 蓝色字 |
| live | session 跑通、终端空闲 | "live" 绿色字 |
| typing | 让 Claude 执行命令 | "typing…" 橙色加粗 + 圆点 pulse |
| error | 拔网线 / agent down / 模拟 401 | 红色 "disconnected: <reason>"，超长省略 |
| offline | 关闭 session | 灰色 "session has exited" |

- [ ] **Step 5: Resize 切换验证（关键）**

1. 桌面（1280px）打开 session → DevTools 拉到 767px
2. **预期**：header 切换到紧凑布局，PC 头像消失，独立 status row 消失
3. 继续拉窄到 360px
4. **预期**：进一步紧凑（padding 8/10 来自 line 1444 既有 breakpoint）
5. 拉回 ≥768px
6. **预期**：恢复桌面布局（avatar / host / status row / 控制条 toggle 全部回来）

如果任意一步切换出现残留元素或白屏 → 检查 `@media (max-width: 767px)` 块是否有 typo。

- [ ] **Step 6: 横屏验证（iPhone 568×320 横屏）**

DevTools 设 iPhone 横屏 568×320（仍 <768px）：
- [ ] header 紧凑布局生效
- [ ] chat-back 32×32 仍可点
- [ ] 不出现 desktop 元素

- [ ] **Step 7: typecheck 最终确认**

```bash
cd C:\wspec\tired-agent
npm run typecheck
```

预期：零 error。

---

### Task 5: 推送与 PR

**Files:**
- 无文件改动，git 操作。

- [ ] **Step 1: 检查最终 git 状态**

```bash
cd C:\wspec\tired-agent
git status
git log --oneline main..HEAD
```

预期：
- `nothing to commit, working tree clean`
- 看到 2 个新 commit 在 `fix/mobile-header-compact-20260722` 分支上（Task 2 + Task 3）
- HEAD 在第 2 个 commit（CSS 改动）

- [ ] **Step 2: 推送分支**

```bash
git push -u origin fix/mobile-header-compact-20260722
```

预期：远程分支创建成功，输出 `* [new branch]      fix/mobile-header-compact-20260722 -> fix/mobile-header-compact-20260722`。

- [ ] **Step 3: 用 gh 创建 PR**

```bash
gh pr create \
  --base main \
  --head fix/mobile-header-compact-20260722 \
  --title "fix(web): 移动端 session header 紧凑化（<768px）" \
  --body "## 背景

移动端 session 页面顶部 ~76px 高，含冗余元素：PC 圆形头像（无信息量）、chat-title-host 副标题、独立 chat-status 行（与 header dot 重复）。挤压 xterm 可视区域。

## 改动

- **PtySessionViewMobile.tsx**（+13 / -10）：
  - 删除 `<span className=\"chat-avatar chat-avatar-pc\">` 与 `<span className=\"chat-title-host\">`
  - 删除整个 `<div className=\"chat-status\">` 行
  - 新增 STATUS_LABEL 映射常量（5 状态全覆盖）
  - 新增 `<span className=\"chat-status-merged\">` 折到 header 右侧
- **styles.css**（+30 行，仅追加）：
  - `@media (max-width: 767px)` 块：header padding 8/12、back 32×32、avatar/host/status row `display:none`
  - `.chat-status-merged` 系列：12px tabular-nums + max-width:50% ellipsis，5 个状态色复用现有变量
  - `prefers-reduced-motion` 降级

## 约束

- **仅改 mobile**（<768px）。desktop ≥768px 既有规则一行不动。
- 不动 PtySessionViewDesktop.tsx / PtySessionView.tsx / shared.ts。
- 不引入新依赖、不动 protocol。
- 不新增单元测试（纯样式 + JSX 增量）。

## 验证

- npm run typecheck 零 error
- 手动 DevTools：iPhone SE 375×667 / 360px 边界 / 横屏 568×320
- Resize 切换 mobile↔desktop 无残留
- 5 个状态（typing/live/connecting/error/offline）颜色与文字映射正确

## 收益

iPhone SE 屏幕 xterm 可视区域 +28px（从 ~340px 到 ~368px）；header 横向释放 46px（avatar+gap）。

## 设计文档

\`docs/superpowers/specs/2026-07-22-mobile-session-header-design.md\`"
```

预期：PR 创建成功，输出 PR URL（如 `https://github.com/.../pull/NN`）。

- [ ] **Step 4: 等待 CI / 等用户确认**

CI 跑过 typecheck + build 后回报用户，由用户决定是否 merge 或继续迭代。

---

## 自审（Spec 覆盖检查）

- ✅ 决策表 5 项（avatar 去 / host 隐藏 / status 折入 / back 32×32 / 不动 PC） → Task 2 + 3
- ✅ 高度预算 76→48 / 横向释放 46px → Task 4 验证
- ✅ JSX 改动（删除 avatar/host/status-row + 新增 STATUS_LABEL + merged span） → Task 2
- ✅ CSS mobile-only 块 + chat-status-merged 系列 → Task 3
- ✅ Resize 切换 / 横屏 / 5 状态颜色 → Task 4
- ✅ typecheck / 不动 desktop / 不动 entry → Task 4 step 7 + Global Constraints
- ✅ 推送与 PR → Task 5

无遗漏项。