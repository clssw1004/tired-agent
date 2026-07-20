# PTY 模式独立 Ctrl/Shift 修饰键 —— 设计文档

- 日期：2026-07-20
- 分支：`feat/pty-modifier-toggles-20260720`
- 状态：已评审通过，待实现

## 背景与目标

`packages/web` PTY 模式的功能键由 `SpecialKeysBar.tsx` 提供。三个现状问题：

1. **`Shift` modifier 完全没实现**。全项目搜 `shift|Shift|Shift+`，唯一命中是 `ClaudeChatView.tsx` 的 `e.shiftKey`（只用于结构化模式的 Enter 行为分支）。PTY 链路没有 Shift 状态，Shift+Tab / Shift+方向键 / 大写字母触发都缺失。
2. **组合键被打包成单个按钮**。`C-c` 按钮永远发 `\x03`，`C-d` 永远发 `\x04`。无法拆出"Ctrl 修饰状态"再与 `c` / `d` 解耦，违背"modifier 应独立存在"的设计意图。
3. **`<input>` 只识别物理 Ctrl**。`PtyInputBar.tsx:144-151` 通过 `e.ctrlKey` 处理物理键盘 Ctrl+字母；但点击式 toggle 修饰键完全不影响系统键盘输入。

本次改动把 Ctrl 和 Shift 提升为独立 toggle 按钮，**短按一次性 / 长按 sticky**；激活时影响 (a) `SpecialKeysBar` 其他按钮的字节序列、(b) `PtyInputBar` 原生 `<input>` 的按键事件。组合键从"硬编码按钮"改为"modifier + 普通键"两段式。

## 决策记录（已确认）

| 问题 | 决策 |
|---|---|
| 释放策略 | 短按 one-shot / 长按 sticky（双态合一） |
| 系统键盘联动 | 按钮栏 + 输入框联动：toggle 状态影响 `<input>` 输入 |
| 现有 `C-c` / `C-d` 按钮 | 降级为字母键 `c` / `d`；不另加完整字母行（依赖系统键盘） |

## 现状调查结论（关键事实）

- **SpecialKeysBar**（`packages/web/src/components/SpecialKeysBar.tsx`）：用 `KeyDef[]` 写 9 个键（Esc / Tab / 4 方向键 / C-c / C-d / Brk）。每个按钮 `bytes: string` 直送。
- **PtyInputBar**（`packages/web/src/components/PtyInputBar.tsx`）：通过原生 `<input>`；`handleKeyDown` (line 115-152) 单独处理 Enter/Tab/Esc/方向键和 `e.ctrlKey` 的物理 Ctrl。
- **宿主** `PtySessionView.tsx:117-125` 有 `writeBytes(data)` 单一漏斗，被三个上游（xterm input、`SpecialKeysBar.onKey`、`PtyInputBar.onChange`）共享。
- **后端** `packages/agent/src/routes/sessions.ts:183-218` 收 base64，调 `manager.write()`（`manager.ts:84-97`）→ `pty.write()`。链路不动。
- **样式** `styles.css:1118-1164` 仅 `.special-keys` 容器与 `.special-key` 默认态。**没有任何 modifier 激活态选择器**。
- **状态管理** 全在组件本地（`useState`/`useRef`），无 Zustand、无 Context、无 modifier 锁。

## 设计方案

### 1. 修饰键状态模型

```ts
type ModifierKey = 'ctrl' | 'shift';
type ModifierMode = 'off' | 'oneShot' | 'sticky';

interface ModifierState {
  ctrl: ModifierMode;
  shift: ModifierMode;
}
```

- `off` — 未激活
- `oneShot` — 短按触发的一次性，下次消费后转 `off`
- `sticky` — 长按触发的锁存，需再点按钮才回 `off`

### 2. 状态托管位置

把状态提升到 `PtySessionView`（宿主）。理由：

- `SpecialKeysBar` 和 `PtyInputBar` 都需要读（按钮栏 + 输入框联动）
- 两者共同父组件就是宿主，不需要 Context / 全局 store
- 单一 `setModifiers` 更新点好维护

`PtySessionView` 向下传递两个 prop：

```ts
{ modifiers, onToggleModifier, onConsumeModifier }
```

### 3. 按钮栏布局（PTY 模式）

11 个键水平滚动：

```
[Ctrl] [Shift] [Esc] [Tab] [c] [d] [↑] [↓] [←] [→] [Brk]
```

- `Ctrl` / `Shift` — 新增 modifier 按钮
- `Esc` / `Tab` — modifier-aware：Shift+Tab → `\x1b[Z`（back-tab）
- `c` / `d` — 替代旧 `C-c` / `C-d`：默认 `'c'` / `'d'`；Ctrl 激活时发 `\x03` / `\x04`；Shift 激活时发 `'C'` / `'D'`
- `↑↓←→` — modifier-aware：Shift+方向键 → `\x1b[1;2A/B/C/D`；Ctrl+方向键 → `\x1b[1;5A/B/C/D`
- `Brk` — `\x1c` 不变（保留 raw break 字节）

### 4. 字节解析算法

中心化函数 `resolveBytes(specs, m)`，按当前 `ModifierState` 返回应发送字节：

```ts
function resolveBytes(
  specs: { base: string; shift?: string; ctrl?: string; ctrlShift?: string },
  m: ModifierState,
): string {
  const anyOn = m.ctrl !== 'off' || m.shift !== 'off';
  if (!anyOn) return specs.base;
  if (m.ctrl !== 'off' && m.shift !== 'off') return specs.ctrlShift ?? specs.ctrl ?? specs.shift ?? specs.base;
  if (m.ctrl !== 'off') return specs.ctrl ?? specs.base;
  return specs.shift ?? specs.base;
}
```

放在 `SpecialKeysBar.tsx` 文件顶部（私有）。

### 5. `KeyButton` 数据结构扩展

```ts
type KeyButton =
  | {
      kind: 'modifier';
      modifier: 'ctrl' | 'shift';
      label: string;      // 'Ctrl' / 'Shift'
      title?: string;
    }
  | {
      kind: 'special';
      label: string;
      bytes: string;            // 基准字节（无 modifier）
      ctrlBytes?: string;
      shiftBytes?: string;
      ctrlShiftBytes?: string;
      longPressBytes?: string;  // 长按 ~500ms（非 modifier 按钮专用）
      title?: string;
    };
```

### 6. `<input>` 拦截（PTY 模式）

`PtyInputBar.handleKeyDown` 现有两段：special key map + `e.ctrlKey` 物理 Ctrl。在两段中间插入 modifier 拦截：

```ts
// toggle modifier 状态触发的组合
if (modifiers.ctrl !== 'off' || modifiers.shift !== 'off') {
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    let bytes: string;
    if (modifiers.ctrl !== 'off') {
      const code = e.key.toUpperCase().charCodeAt(0);
      bytes = (code >= 0x40 && code <= 0x5f)
        ? String.fromCharCode(code - 0x40)
        : e.key;
    } else {
      bytes = e.key;
    }
    if (modifiers.shift !== 'off') bytes = bytes.toUpperCase();
    onChange(bytes);
    onConsumeModifier('ctrl');     // oneShot 时清掉
    onConsumeModifier('shift');
    return;
  }
}
```

物理 Ctrl（`e.ctrlKey`）路径不变。

### 7. Modifier 按钮交互

复用 `KeyButton` 现有的 `timerRef` + `firedLongRef`，但语义改为：

| 用户操作 | 结果 |
|---|---|
| `pointerdown` | 启动 400ms 计时器，记录起始 |
| 400ms 内 `pointerup` | **短按**：进入 `oneShot` |
| 计时器先 fire 再 `pointerup` | **长按**：进入 `sticky`（持续高亮） |
| 已激活（任意 mode）再点一次 | 再次点击 = 关闭：转回 `off` |
| `pointercancel` / `pointerleave` | 取消计时器 |

非 modifier 按钮继续原 long-press 语义（`longPressBytes`），单独路径。

### 8. 视觉态（styles.css）

```css
.special-key.modifier.is-one-shot {
  border-color: var(--accent);
  background: rgba(51,154,240,0.18);
  animation: mod-pulse 1.2s ease-in-out infinite;
}
.special-key.modifier.is-sticky {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
  font-weight: 700;
}
.special-key.modifier.is-sticky:active { transform: scale(0.96); }
@keyframes mod-pulse { 0%,100% { opacity: 0.6; } 50% { opacity: 1; } }
```

桌面端 `display: none` 沿用现状。

### 9. 改动文件清单

| 文件 | 行 | 改动 |
|---|---|---|
| `packages/web/src/components/SpecialKeysBar.tsx` | 30-89 | 加 `ModifierKey` / `ModifierMode` / `ModifierState` 类型与 props；`KeyButton` 扩为 union；新增 `MODIFIER_BUTTONS` |
| `packages/web/src/components/SpecialKeysBar.tsx` | 91-154 | `KeyButton` 按 `kind` 分叉：modifier 跑 toggle，special 跑原 long-press + `resolveBytes` |
| `packages/web/src/components/PtySessionView.tsx` | 84-117 | 新增 `useState<ModifierState>(...)`；新增 `toggleModifier` / `consumeModifier` 回调；透传给两个子组件 |
| `packages/web/src/components/PtyInputBar.tsx` | 30-40, 115-152 | 新增 `modifiers` / `onConsumeModifier` props；`handleKeyDown` 中插入 modifier 拦截 |
| `packages/web/src/styles.css` | 1141-1164 | 新增 `.special-key.modifier` 三态样式 |

后端 `packages/agent/src/routes/sessions.ts` 与 `packages/protocol/src/types.ts` **完全不动**。

## 验收

### 功能验证表

| 场景 | 期望 |
|---|---|
| 点 Ctrl（短按），再点 `c` | 发 `\x03`；Ctrl 自动回 off |
| 点 Ctrl（短按）+ 输入框按物理 `a` | 发 `\x01`；Ctrl 自动回 off |
| 长按 Ctrl（≥ 400ms） | sticky 高亮；点 3 次 `c` 都带 Ctrl |
| sticky 状态再点 Ctrl | Ctrl 回 off |
| 点 Shift + 输入框按 `a` | 发 `'A'`；Shift 自动回 off |
| 长按 Shift + 点 `Tab` | 发 `\x1b[Z`（back-tab） |
| 点 `↑`（无 modifier） | 发 `\x1b[A` |
| 点 `↑` 时 Ctrl 激活 | 发 `\x1b[1;5A` |
| 点 `↑` 时 Shift 激活 | 发 `\x1b[1;2A` |
| Ctrl+Shift 同时点 `↓` | 发 `\x1b[1;6B` |
| 点 `Esc`（Ctrl 激活） | 发 `\x1b`（Esc 不变） |
| 桌面端 Chrome | `.special-keys` 隐藏 |

### 兼容性

- 长按 `c` / `d` 仍发 `\x03\x03` / `\x04\x04`（旧语义保留）
- 物理 Ctrl+字母仍走 `e.ctrlKey` 旧路径，与 toggle 并行
- IME 合成期间 `composingRef` 在 `PtyInputBar.tsx:120` 早返，modifier 不消费
- `.special-keys-structured`（结构化模式 `中断` 单键）不受影响

### 编译 / 自测

```bash
npm run build:protocol
npm run build:web
npm run typecheck
npm run dev:web        # 浏览器打开 :5173，Chrome DevTools 切到手机视图
```

DevTools 模拟移动端，验证 `.special-keys` 显示，点击 modifier 高亮、对照 PTY 回显观察 `^C`、`^D`、`^?`、`ESC[Z` 等字节。

## 实现顺序（建议）

```
1. PtySessionView 提升 modifier 状态
2. SpecialKeysBar 加 Ctrl/Shift modifier 按钮
3. SpecialKeysBar 旧 C-c/C-d 降级为 c/d，方向键/Tab modifier-aware
4. PtyInputBar handleKeyDown 加 modifier 拦截
5. styles.css modifier 三态样式
6. 编译验证
```

PR target = main；标题：`feat(web): PTY 模式独立 Ctrl/Shift toggle 修饰键`。
