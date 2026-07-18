# tired-agent ChatContainer 架构重新设计

> 日期：2026-07-18
> 状态：设计阶段
> 关联：tired-agent Agent Rendering Engine (2026-07-18-agent-renderer-design.md)

---

## 1. 背景与动机

### 1.1 问题

现有 `ChatView` 采用**强制对话轮次模式**（user 气泡 ↔ PC 气泡交替），这是早期"对话形式"决策的产物。实践中发现：

| 问题 | 表现 | 原因 |
|------|------|------|
| **气泡约束** | 所有输出必须塞进"PC 回复"气泡 | `displayMode` 的 `chat/replace-last/snapshot` 是在气泡框架内打补丁 |
| **渲染僵化** | 每段输出在 `.chat-row-pc > .chat-bubble` 中渲染 | 无法支持 canvas、xterm.js 等非 DOM 渲染 |
| **Claude 体验差** | Claude Code 的 TUI 输出被强行拆成气泡，效果很差 | 气泡模型不是为 TUI 输出设计的 |
| **干预困难** | 无法展示确认按钮、选择器 | 气泡内无法嵌入交互组件 |

### 1.2 新方向

> **下方输入框 + 上方自由渲染区**

- **输入框始终在底部**：固定的 `<InputBar>`，独立于内容渲染
- **上方渲染区由当前 renderer 控制**：不限定于气泡容器，renderer 决定自己的展示方式
- **Renderer 可自带 View**：简单 renderer 用 StructuredContent 列表，复杂 renderer 用自定义 React 组件甚至 Canvas

---

## 2. 整体架构

```
┌─────────────────────────────────────────┐
│ ChatContainer                            │
│                                          │
│  ┌─── Header ─────────────────────────┐  │
│  │  ‹  PC  · tired-host:8443    ●    │  │  ← 不变
│  └────────────────────────────────────┘  │
│                                          │
│  ┌─── RenderArea ─────────────────────┐  │
│  │                                     │  │  ← 自由渲染区
│  │  ┌──────────────────────────────┐  │  │     renderer 控制
│  │  │   (renderer-specific view)   │  │  │
│  │  │                               │  │  │
│  │  │  Claude 示例:                  │  │  │
│  │  │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │  │  │
│  │  │  │ ✻ 思考中…               │  │  │  │  ← 无气泡边框
│  │  │  │                           │  │  │  │
│  │  │  │ ● 你好！我是 Claude Code   │  │  │  │  ← 无气泡边框
│  │  │  │    有什么我可以帮你的？     │  │  │  │
│  │  │  │                           │  │  │  │
│  │  │  │ ───────────────────────── │  │  │  │
│  │  │  │                           │  │  │  │
│  │  │  │ 需要确认 [y/N]            │  │  │  │  ← 可交互
│  │  │  │ [确认] [拒绝]            │  │  │  │
│  │  │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │  │  │
│  │  │                               │  │  │
│  │  │  Bash/通用示例:               │  │  │
│  │  │  ┌──────────────────────────┐  │  │  │
│  │  │  │ C:\> cd wspec            │  │  │  │  ← 带 ANSI 颜色的
│  │  │  │ C:\> npm run build       │  │  │  │     终端文本区
│  │  │  │ building...              │  │  │  │
│  │  │  │ ✓ built                  │  │  │  │
│  │  │  └──────────────────────────┘  │  │  │
│  │  └──────────────────────────────┘  │  │
│  │                                     │  │
│  └─────────────────────────────────────┘  │
│                                          │
│  ┌─── InterventionBar (可选) ──────────┐  │
│  │  Claude is asking: "确认执行吗?"    │  │  ← 需要干预时出现
│  │  [允许一次] [始终允许] [拒绝]       │  │     支持多种操作
│  └────────────────────────────────────┘  │
│                                          │
│  ┌─── InputBar ────────────────────────┐  │
│  │  ❯ 输入消息...                   [→]│  │  ← 始终在底部
│  └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 2.1 关键变化

| 概念 | 旧 (ChatView) | 新 (ChatContainer) |
|------|--------------|-------------------|
| **内容容器** | `Segment[]` (user/assistant 交替) | `RenderArea` (renderer 控制) |
| **交互位置** | 输入框在内容流底部 | 输入框固定底部，独立于内容区 |
| **渲染方式** | 气泡列表 (`.chat-row > .chat-bubble`) | 按 renderer 切换视图组件 |
| **输出流** | `processChunk` → `RenderOutput` → `applyRender` | `processChunk` → 更新 contents state → View 重渲染 |
| **用户输入** | 追加到 segments 最后 | 直接写入 PTY，View 自行响应 |
| **干预机制** | 无 | `ContentPrompt` + InterventionBar |

---

## 3. 组件设计

### 3.1 ChatContainer（主组件）

```tsx
function ChatContainer(props: {
  serverRef: ServerRef;
  sessionId: string;
  sessionStatus: SessionStatus;
  sessionCmd: string;
  sessionArgs: string[];
  onBack?: () => void;
}) {
  // Renderer 实例 (useRef, 同现)
  const rendererRef = useRef<AgentRenderer>(new GenericPtyRenderer());
  
  // Renderer 输出的结构化内容
  const [contents, setContents] = useState<StructuredContent[]>([]);
  
  // 渲染状态
  const [status, setStatus] = useState<'connecting' | 'live' | 'typing' | 'error' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  
  // SSE 订阅 → processChunk → setContents
  // 与当前 ChatView 类似，但不再维护 segments
  
  // Renderer 刷新
  const detectedId = useRef<string | null>(null);
  
  return (
    <div className="chat-panel">
      <Header ... />
      
      {/* 渲染区 */}  
      <div className="render-area">
        <RendererView
          rendererId={rendererRef.current.id}
          contents={contents}
          status={status}
        />
      </div>
      
      {/* 干预按钮区（按需显示） */}
      <InterventionBar contents={contents} onResponse={handleIntervention} />
      
      {/* 底部输入栏 */}
      <InputBar
        disabled={status === 'offline' || sending}
        placeholder={status === 'offline' ? 'Session exited' : '输入指令…'}
        onSubmit={sendInput}
      />
    </div>
  );
}
```

### 3.2 RendererView（视图路由）

```tsx
// 视图组件注册表
const VIEW_REGISTRY: Record<string, React.ComponentType<ViewProps>> = {
  'claude':      ClaudeView,
  'generic-pty': PtyView,
};

function RendererView({ rendererId, contents, status }: ViewProps) {
  const ViewComponent = VIEW_REGISTRY[rendererId] ?? PtyView;
  return <ViewComponent contents={contents} status={status} />;
}
```

### 3.3 ClaudeView（Claude 专属视图）

不做气泡，不做用户/PC 交替。直接渲染 Claude 输出的内容块：

```tsx
function ClaudeView({ contents, status }: ViewProps) {
  return (
    <div className="claude-view">
      {contents.map((c, i) => {
        switch (c.type) {
          case 'text':
            return <ClaudeAnswer key={i} text={c.text} />;
          case 'status':
            return <ThinkingBlock key={i} text={c.text} status={c.status} ephemeral={c.ephemeral} />;
          case 'prompt':
            return <ClaudePrompt key={i} prompt={c} onResponse={handleResponse} />;
          case 'divider':
            return <ClaudeDivider key={i} />;
        }
      })}
    </div>
  );
}
```

**视觉特征**：
- 无气泡边框：内容直接从左侧边缘开始
- 思考块左侧用颜色条或动画标识
- 回答块（`●`）以较大字号、白/浅色文本展示
- 分隔线用半透明细线

### 3.4 PtyView（通用终端视图）

```tsx
function PtyView({ contents, status }: ViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // auto-scroll to bottom on new content
  
  return (
    <div className="pty-view" ref={scrollRef}>
      {contents.map((c, i) => (
        c.type === 'text' 
          ? <span key={i} style={contentStyleToCss(c.style)}>{c.text}</span>
          : c.type === 'divider'
          ? <hr key={i} />
          : null
      ))}
    </div>
  );
}
```

**视觉特征**：
- 等宽字体，深色背景
- ANSI 颜色保留
- 可滚动，自动滚到底部
- 无气泡，无时间戳

### 3.5 InterventionBar

```tsx
function InterventionBar({ contents, onResponse }: InterventionBarProps) {
  // 检测 contents 中是否有 ContentPrompt
  const prompt = contents.findLast(c => c.type === 'prompt');
  if (!prompt) return null;
  
  return (
    <div className="intervention-bar">
      <span className="intervention-text">{prompt.text}</span>
      <div className="intervention-actions">
        {prompt.options?.map(opt => (
          <button key={opt} onClick={() => onResponse(opt)}>{opt}</button>
        ))}
      </div>
    </div>
  );
}
```

---

## 4. 类型扩展

### 4.1 新增 ContentPrompt

```typescript
// packages/protocol/src/types.ts

export interface ContentPrompt {
  type: 'prompt';
  /** 提示文本，如 "Are you sure [y/N]?" */
  text: string;
  /** 预期输入类型 */
  kind: 'yesno' | 'text' | 'selection';
  /** 选项列表（yesno / selection 模式） */
  options?: string[];
}

// StructuredContent union 新增成员
export type StructuredContent =
  | ContentText
  | ContentCode
  | ContentDivider
  | ContentStatus
  | ContentTable
  | ContentLink
  | ContentImage
  | ContentCommand
  | ContentPrompt;  // ← 新增
```

### 4.2 Renderer 接口简化

```typescript
// packages/web/src/renderer/types.ts

export interface AgentRenderer {
  readonly id: string;
  readonly name: string;

  /** 处理一段新的 PTY 输出 */
  processChunk(chunk: string, ctx: RenderContext): void;
  
  /** 用户发送输入时调用：刷新 buffer，把残余内容输出 */
  flush(): RenderOutput;
  
  /** 重置内部状态 */
  reset(): void;
  
  /** 获取当前全部结构化内容（视图层使用） */
  getContents(): StructuredContent[];
  
  /** 是否检测到用户输入等待（如 ❯ 提示符、[y/N]） */
  awaitingInput(): boolean;
}
```

### 4.3 RenderOutput 简化

```typescript
export interface RenderOutput {
  /** 新增或变更的内容 */
  contents: StructuredContent[];
  /** 只保留 snapshot（全量替换）和 append（追加）两种模式 */
  mode: 'append' | 'snapshot';
  snapshotTag?: string;
}
```

去掉了 `chat`、`replace-last`、`dashboard`。这些都被视图组件自身处理。

---

## 5. ClaudeRenderer 改进

### 5.1 屏幕缓冲区

新增简单的 2D 行缓冲区（不是完整 VT100 实现）：

```typescript
interface ScreenState {
  lines: string[];      // 屏幕行
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
}
```

处理逻辑：
1. 收到 chunk：提取 ANSI 序列 + 文本
2. 应用 cursor 移动到缓冲区
3. 写入文本到缓冲区对应位置
4. 提取"新增的对话行"（变化部分）

### 5.2 输入等待检测

检测 Claude 等待用户输入的模式：

```typescript
function detectAwaitingInput(lines: string[]): boolean {
  const lastNonEmpty = lines.findLast(l => l.trim());
  if (!lastNonEmpty) return false;
  
  // Claude 输出 ❯ 后开始等待输入
  if (/^❯ /.test(lastNonEmpty)) return true;
  
  // 确认提示
  if (/\[y\/N\]|\[Y\/n\]|\(y\/n\)/.test(lastNonEmpty)) return true;
  
  return false;
}
```

### 5.3 内容提取

从屏幕缓冲区提取干净的对话内容：

```typescript
function extractConversation(screen: ScreenState): StructuredContent[] {
  const contents: StructuredContent[] = [];
  
  // 遍历屏幕行
  for (const line of screen.lines) {
    if (line.startsWith('●')) {
      contents.push({ type: 'text', text: line.slice(1).trim() });
    } else if (isSpinnerLine(line)) {
      contents.push({ type: 'status', status: 'working', text: line.trim(), ephemeral: true });
    } else if (line.startsWith('─')) {
      contents.push({ type: 'divider' });
    } else if (isThinkingLine(line)) {
      contents.push({ type: 'status', status: 'thinking', text: line.trim(), ephemeral: true });
    } else if (isHeaderLine(line)) {
      // 跳过顶部的 banner/header
    } else if (isPromptLine(line)) {
      // 跳过 ❯ 行，但记录 awaitingInput
    }
  }
  
  return contents;
}
```

---

## 6. 历史回放（Session Restore）

### 6.1 恢复逻辑

与现有方案一致：replay 原始 PTY log 通过 renderer：
1. `GET /v1/sessions/:id/output?from=0`
2. 把 chunks 拼接成完整文本
3. 完整跑一遍 renderer（包括屏幕缓冲区）
4. Renderer 产生最终 contents
5. View 渲染最终 contents

### 6.2 进度指示

对于超长历史，显示恢复进度：
```tsx
{restoring && <div className="restore-progress">恢复历史记录… {pct}%</div>}
```

---

## 7. 文件改动清单

### 新增文件

| 文件 | 说明 |
|------|------|
| `packages/web/src/components/ChatContainer.tsx` | 主容器组件（替换 ChatView） |
| `packages/web/src/components/render-views/ClaudeView.tsx` | Claude 专用视图 |
| `packages/web/src/components/render-views/PtyView.tsx` | 通用终端文本视图 |
| `packages/web/src/components/render-views/index.ts` | 视图注册表 |
| `packages/web/src/components/InterventionBar.tsx` | 干预操作栏 |
| `packages/web/src/components/InputBar.tsx` | 底部输入栏 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/protocol/src/types.ts` | 新增 `ContentPrompt` 类型 |
| `packages/web/src/renderer/types.ts` | 简化 `RenderOutput`、新增 `getContents()`、`awaitingInput()` |
| `packages/web/src/renderer/builtins/claude.ts` | 屏幕缓冲区、输入等待检测 |
| `packages/web/src/renderer/builtins/generic-pty.ts` | 实现 `getContents()` |
| `packages/web/src/styles.css` | 新增 `.render-area`、`.claude-view`、`.pty-view`、`.intervention-bar` 等样式，移除气泡相关样式 |
| `packages/web/src/pages/TerminalPage.tsx` | ChatView → ChatContainer |

### 删除文件

| 文件 | 说明 |
|------|------|
| `packages/web/src/components/ChatView.tsx` | 由 ChatContainer 替代 |
| `packages/web/src/components/StructuredBlock.tsx` | 由各 View 内部处理 |

---

## 8. 实施顺序

### Step 1: 类型准备
- `ContentPrompt` 新增到 protocol types
- `AgentRenderer` 接口新增方法
- 简化 `RenderOutput.mode`（去掉 chat/replace-last/dashboard）

### Step 2: InputBar 独立组件
- 从 ChatView 提取 InputBar 为独立组件
- 保持功能不变

### Step 3: ChatContainer 骨架
- 新建 ChatContainer（布局：header + render-area + input-bar）
- 暂时使用 DefaultView（简单列表 StructuredContent）
- 功能与 ChatView 等价的替换

### Step 4: PtyView
- 从 GenericPtyRenderer 提取文本渲染逻辑
- 滚动文本区，ANSI 颜色保留
- 用于 bash/cmd 等通用命令

### Step 5: ClaudeView + 屏幕缓冲区
- ClaudeRenderer 增加屏幕缓冲区
- 输入等待检测
- ClaudeView 渲染思考/回答/分隔线

### Step 6: InterventionBar
- ContentPrompt 检测
- 确认按钮/选择器
- 输入回写到 PTY

### Step 7: CSS 清理
- 移除 `.chat-row`、`.chat-bubble` 等气泡样式
- 新增 `.claude-view`、`.pty-view`、`.intervention-bar` 样式

---

## 9. 不变的部分

| 部分 | 原因 |
|------|------|
| `packages/server/` | 完全不变：仍然 PTY → SSE |
| `packages/protocol/src/HttpSseTransport.ts` | 不变 |
| SSE 事件格式 | 不变 |
| Session 创建/管理/清理 | 不变 |
| RendererRegistry / AgentDetector | 不变（仍用检测→选择模式） |
| StructuredContent 类型系统 | 扩展（新增 ContentPrompt），不变的类型保留 |
