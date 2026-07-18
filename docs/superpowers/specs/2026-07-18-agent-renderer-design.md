# tired-agent Agent Rendering Engine — 设计文档

> 日期：2026-07-18
> 状态：设计阶段
> 关联：tired-agent 前端渲染层重构

---

## 1. 背景与目标

### 1.1 问题

tired-agent 的核心就是一个远程 PTY 执行器：接收输入 → 传送到远程 PTY → 传出输出。但在实际使用中，**同一个 PTY 管道里跑的程序不同，用户期望的展示方式完全不同**：

| 程序 | 输出特征 | 期望展示方式 |
|------|----------|-------------|
| `cmd.exe` / `bash` | 纯文本 + 少部分 SGR 颜色 | 简单终端输出，monospace |
| `claude` | 重度 TUI：spinner、状态栏、分隔线、cursor 定位重画、多行回答 | 聊天式：保留分隔线 + 状态标签 + 对话文本 |
| `aider` | 颜色 diff、文件树、进度条 | 结构化：diff 高亮 + 文件列表 + 状态 |
| `git log` | 格式化时间线 | 列表式：commit 条目 + SHA 摘要 |
| `htop` / `top` | 实时刷新，cursor 重画整屏 | 快照式：周期抓取最新帧 |

### 1.2 目标

设计一个**可扩展的渲染引擎**，核心约束：

1. **I/O 与渲染解耦**：后端（server）不做任何渲染决策 —— 只传原始字节。渲染全是客户端的事。
2. **Agent 自动检测**：不要求用户手动选择模式。系统根据 `cmd` + 输出特征自动匹配合适的 renderer。
3. **Renderer 可插拔**：新增一个 renderer = 实现一个接口 + 注册一个 detector。不改现有代码。
4. **结构化内容**：renderer 的输出是类型化数据（text / code / divider / status / table / diff …），UI 层按类型渲染。不泄漏字节级解析逻辑到组件。
5. **流式友好**：renderer 能增量处理（每个 SSE chunk 调用一次），也能最终集总输出。

---

## 2. 整体架构

```
┌────────────────────────────────────────────────────┐
│                    ChatView                        │
│  ┌────────────┐    ┌────────────┐    ┌──────────┐  │
│  │ Agent      │───▶│ Agent      │───▶│ React    │  │
│  │ Detector   │    │ Renderer   │    │ UI       │  │
│  └────────────┘    └────────────┘    └──────────┘  │
│         ▲                ▲                         │
│         │                │                          │
│  ┌──────┴────────────────┴──────┐                   │
│  │        Registry              │                   │
│  │  (detector → renderer)      │                   │
│  └──────────────────────────────┘                   │
│         ▲                                           │
│         │  registers                               │
│  ┌──────┴──────────────────┐                        │
│  │  Plugin modules        │                        │
│  │  (claude/ / aider/ /   │                        │
│  │   generic-pty/)        │                        │
│  └─────────────────────────┘                        │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │  StructuredContent[]                         │   │
│  │  [{ type: 'text' }, { type: 'code' }, ...]   │   │
│  └──────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────┘
         ▲
         │ raw bytes (SSE)
┌────────┴────────┐
│   Server PTY    │  ← 完全不变，只管传字节
└─────────────────┘
```

### 2.1 数据流

```
SSE chunk → appendOutput() → raw text accumulator（按 session 累积）
                                   │
                           Agent Detector（检测 cmd + output 特征）
                                   │
                           选择 Agent Renderer
                                   │
                           processChunk(chunk)
                                   │
                           StructuredContent[]
                                   │
                           React 渲染
```

### 2.2 关键解耦点

- **Server** 不知道也不关心渲染 —— 传原始二进制 bytes
- **Protocol** 不知道渲染 —— 只传 `StreamEvent`（base64 bytes + state）
- **Transport** 不知道渲染 —— 只传 `OutputChunk { offset, data: Uint8Array }`
- **ChatView** 只集成 registry —— 不直接操作任何 renderer
- **Renderer** 不知道 React —— 输出 `StructuredContent[]`（纯数据）
- **UI Components** 不知道 ANSI —— 只渲染结构化数据

---

## 3. 核心接口定义

### 3.1 StructuredContent 类型

所有 renderer 的输出统一为以下 union 类型：

```typescript
// packages/protocol/src/types.ts 新增

export interface ContentText {
  type: 'text';
  text: string;
  style?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    color?: string;        // CSS color value
    background?: string;   // CSS background-color
    fontSize?: number;
    monospace?: boolean;   // 默认为 true（PTY 输出）
  };
}

export interface ContentCode {
  type: 'code';
  code: string;
  language?: string;       // 即或检测到的语言
  /** 行内（inline）还是块级（block） */
  display: 'inline' | 'block';
}

export interface ContentDivider {
  type: 'divider';
  /** optional label in the divider, e.g. "thinking" */
  label?: string;
}

export interface ContentStatus {
  type: 'status';
  status: 'thinking' | 'working' | 'done' | 'error' | 'idle';
  text: string;
  /** 如果是 spiner 帧，hidePrevious 告诉 UI 替换上一个 status */
  hidePrevious?: boolean;
}

export interface ContentTable {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export interface ContentLink {
  type: 'link';
  url: string;
  text: string;
}

export interface ContentImage {
  type: 'image';
  alt: string;
  /** base64 data URL 或 外部 URL */
  url: string;
}

export interface ContentCommand {
  type: 'command';
  /** 用户输入的命令原文 */
  raw: string;
  /** 解析后的命令名（去 prompt prefix） */
  parsed: string;
}

export type StructuredContent =
  | ContentText
  | ContentCode
  | ContentDivider
  | ContentStatus
  | ContentTable
  | ContentLink
  | ContentImage
  | ContentCommand;
```

### 3.2 时间线与"段"

> **对话（时间线）是容器，渲染模式决定段落内的表现。**

整个 session 视图是一条时间线（timeline），时间线上每个"段"（segment）代表一轮交互：
```
[用户输入] → [renderer 输出段 A] → [renderer 输出段 B] → [下一个用户输入] → ...
```

段的表现形式由 renderer 的 `displayMode` 控制：

| displayMode | 含义 | 典型场景 |
|-------------|------|---------|
| `chat` | 追加内容到当前段的累积输出中（默认） | claude 回答、bash 命令输出 |
| `replace-last` | 替换当前段的最后一个内容块（不创建新段） | spinner 帧、进度条 |
| `snapshot` | 当前段是一个独立快照，覆盖前一个同段快照 | htop/top 实时刷新 |
| `dashboard` | 当前段渲染为一个独立面板（非气泡） | htop 的进程表、文件浏览器 |

`displayMode` 由 renderer 自身声明，UI 层根据它选择布局：

```
时间线（timeline）
├── [段 1] user: "ls -la"
│     └── [renderer(chat)]  ← 正常累积输出气泡
│           ├── ContentText "total 24"
│           └── ContentText "drwxr-xr-x ..."
│
├── [段 2] user: "htop"
│     └── [renderer(snapshot)]  ← 隐藏上一个 htop 段，替换为新快照
│           ├── ContentTable [进程表]
│           └── ContentStatus "CPU 12%"
│
├── [段 3] user: "claude"
│     └── [renderer(chat)]  ← 普通聊天气泡
│           ├── ContentDivider "thinking"
│           └── ContentText "你好！XXXX"
│
└── [段 4] user: "top -b -n1"
      └── [renderer(snapshot)]
            └── ContentText "top - 14:32:01 ..."
```

### 3.3 RenderOutput + AgentRenderer 接口

```typescript
// packages/web/src/renderer/types.ts

import type { StructuredContent } from '@tired-agent/protocol';

export type DisplayMode = 'chat' | 'replace-last' | 'snapshot' | 'dashboard';

export interface RenderOutput {
  /** 本段的结构化内容 */
  contents: StructuredContent[];
  /**
   * 显示模式：
   *   chat         → 追加到当前段的输出中（默认）
   *   replace-last → 替换段内最后一个内容块（spinner、进度条）
   *   snapshot     → 当前段整体替换上一个同 renderer 的段（htop）
   *   dashboard    → 当前段渲染为非气泡面板（预留）
   */
  displayMode: DisplayMode;
  /** 
   * 快照标签：snapshot/dashboard 模式下，相同 tag 的旧段会被替换。
   * 例如 htop renderer 产生 tag='htop' 的 snapshot，
   * 下次 htop 输出会覆盖前一个 htop 段。
   */
  snapshotTag?: string;
}

export interface RenderContext {
  /** session 元信息 */
  session: {
    cmd: string;
    args: string[];
    label?: string;
  };
  /** 是否仍在流式接收中 */
  streaming: boolean;
  /** 当前段内已输出的结构化内容（用于 accumulator 合并） */
  segmentContent: StructuredContent[];
}

export interface AgentRenderer {
  /** renderer 的唯一标识 */
  id: string;
  /** 人类可读名称 */
  name: string;

  /**
   * 处理一段新字节（UTF-8 decoded string），返回渲染输出。
   * 在流式模式（streaming=true）下每次 SSE chunk 都会调用。
   * 建议实现方用内部 accumulator 管理跨 chunk 的状态。
   */
  processChunk(chunk: string, ctx: RenderContext): RenderOutput;

  /**
   * 用户发送了新命令（当前段结束），renderer 应 flush 内部 buffer。
   */
  flush(): RenderOutput;

  /**
   * 重置 renderer 内部状态（用于模式切换或新 session 开始）。
   */
  reset(): void;
}
```

### 3.3 AgentDetector 接口

```typescript
// packages/web/src/renderer/types.ts

export interface AgentDetector {
  /** detector 唯一标识 */
  id: string;

  /**
   * 检测应该使用哪个 renderer。
   * @param cmd 创建 session 时指定的命令
   * @param args session 参数
   * @param previewOutput 前 N 个输出字节（用于基于 output 模式的检测）
   * @returns renderer id（匹配）或 null（不匹配）
   */
  detect(cmd: string, args: string[], previewOutput: string): string | null;

  /** 检测优先级（越高越先检查）。默认 0 */
  priority: number;
}
```

### 3.4 Registry

```typescript
// packages/web/src/renderer/registry.ts

export interface RendererRegistration {
  detector: AgentDetector;
  createRenderer: () => AgentRenderer;
}

class RendererRegistry {
  private entries: RendererRegistration[] = [];

  register(entry: RendererRegistration): void {
    this.entries.push(entry);
    // 按 priority 降序排列
    this.entries.sort((a, b) => b.detector.priority - a.detector.priority);
  }

  detect(cmd: string, args: string[], previewOutput: string): AgentRenderer {
    for (const entry of this.entries) {
      const id = entry.detector.detect(cmd, args, previewOutput);
      if (id) return entry.createRenderer();
    }
    // fallback：默认 generic-pty renderer
    return new GenericPtyRenderer();
  }
}
```

---

## 4. 内置 Renderer 模块

### 4.1 `generic-pty`（默认 renderer）

| 项目 | 值 |
|------|-----|
| id | `generic-pty` |
| detector priority | `-1`（最低，作为 fallback） |
| detect 逻辑 | 总是返回 true（兜底） |
| 行为 | 对文本做 stripAnsi（只保留 SGR），然后 merge 成少量 ContentText |

### 4.2 `claude`（TUI 重）

| 项目 | 值 |
|------|-----|
| id | `claude` |
| detector priority | `10` |
| detect 逻辑 | cmd 包含 `claude`，或输出包含 `✽ Cultivating` / `CSI ? 2026` / `⏸ manual mode` |
| 行为 | 见下方详细描述 |

**处理管道**：
1. 识别并丢弃 spinner 帧（`\r` 覆盖的帧只保留最后一个 non-empty 文本）
2. 提取关键行：
   - 对话行（`● 你好…`）→ `ContentText`
   - 思考行（`Thinking for 2s…`）→ `ContentStatus { status: 'thinking' }`
   - 分隔线（`────────────────────`）→ `ContentDivider`
   - 完成状态（`Sautéed for 2s`）→ `ContentStatus { status: 'done' }`
   - 模式提示（`⏸ manual mode on`）→ `ContentStatus { status: 'idle' }`
   - 命令提示符（`❯`）→ 丢弃
3. 输出按对话轮次分组，每轮一个 bubble

### 4.3 `aider`（MPL-licensed AI pair programming，支持结构化 diff 提取）

| 项目 | 值 |
|------|-----|
| id | `aider` |
| detector priority | `10` |
| detect 逻辑 | cmd 包含 `aider`，或输出包含 `─  file changes ─` / `─────── diff ───────` |
| 行为 | TODO（后续实现）|

### 4.4 扩展新 renderer

新增一个 renderer 只需：

```typescript
// packages/web/src/renderer/registry.ts
import { gitRenderer, gitDetector } from './builtins/git';

registry.register({
  detector: gitDetector,
  createRenderer: () => gitRenderer(),
});
```

在 `ChatView` 初始化时导入 registry 即可。Renderer 文件全部在 `packages/web/src/renderer/` 目录下，不和 UI 组件混在一起。

---

## 5. ChatView 集成方案

`ChatView.tsx` 需要做的改动：

```typescript
// 新增状态
const [currentRenderer, setCurrentRenderer] = useState<AgentRenderer>(() => new GenericPtyRenderer());
const [structuredContents, setStructuredContents] = useState<StructuredContent[]>([]);
const [agentDetected, setAgentDetected] = useState(false);

// 检测逻辑（appendOutput 中调用）
function appendOutput(chunk: Uint8Array) {
  const text = DECODER.decode(chunk);
  if (!agentDetected) {
    const renderer = registry.detect(session.cmd, session.args, text);
    setCurrentRenderer(renderer);
    setAgentDetected(true);
  }
  const ctx: RenderContext = { session, streaming: true, previousContent: structuredContents };
  const contents = currentRenderer.processChunk(text, ctx);
  if (contents.length > 0) {
    setStructuredContents(prev => [...prev, ...contents]);
  }
}

// 用户发送新命令时
function handleUserSend() {
  const flushed = currentRenderer.flush();
  if (flushed.length > 0) setStructuredContents(prev => [...prev, ...flushed]);
  setAgentDetected(false);  // 下一轮重新检测
}
```

---

## 6. 渲染展示层

每个 `StructuredContent` 类型对应一个 React 组件：

```tsx
function StructuredBlock({ content }: { content: StructuredContent }) {
  switch (content.type) {
    case 'text':
      return <span className="ct-text" style={...}>{content.text}</span>;
    case 'code':
      return <pre className="ct-code">{content.code}</pre>;
    case 'divider':
      return <div className="ct-divider">{content.label && <span>{content.label}</span>}</div>;
    case 'status':
      return <div className={`ct-status ct-${content.status}`}>{content.text}</div>;
    case 'table':
      return <table className="ct-table">...</table>;
    case 'link':
      return <a className="ct-link" href={content.url}>{content.text}</a>;
    case 'image':
      return <img className="ct-image" src={content.url} alt={content.alt} />;
    case 'command':
      return <div className="ct-command">{content.raw}</div>;
  }
}
```

每个气泡的 body 从 `<pre>{m.text}</pre>` 改为：

```tsx
<div className="chat-bubble-body">
  {currentContent.map((c, i) => <StructuredBlock key={i} content={c} />)}
</div>
```

样式在 `styles.css` 中以 `.ct-*` 为前缀独立命名空间，不冲突。

---

## 7. 文件目录结构

```
packages/web/src/
  ├── renderer/
  │   ├── types.ts              # AgentRenderer / AgentDetector / RenderContext
  │   ├── registry.ts           # RendererRegistry
  │   ├── builtins/
  │   │   ├── generic-pty.ts    # GenericPtyRenderer（默认 fallback）
  │   │   ├── claude.ts         # ClaudeRenderer（TUI 检测 + 解析）
  │   │   └── aider.ts          # AiderRenderer（预留）
  │   └── __tests__/
  │       ├── claude.test.ts
  │       └── generic-pty.test.ts
  ├── components/
  │   ├── ChatView.tsx          # 渲染引擎集成点
  │   ├── StructuredBlock.tsx   # content → React 渲染 switch
  │   └── ...
  └── styles.css
```

---

## 8. 实施计划

### Phase A（当前）
1. 设计文档定稿 ✓（本文）
2. 实现 `renderer/types.ts`、`registry.ts` 
3. 实现 `generic-pty.ts`（从现有 `renderAnsi` + `AnsiBody` 迁移）
4. 修改 `ChatView.tsx` 集成 registry
5. 实现 `StructuredBlock.tsx` 渲染组件
6. 类型检查通过

### Phase B
7. 实现 `claude.ts`（Claude TUI parsing）
8. 手机端 Claude 展示优化
9. 新增 `.ct-*` CSS 类

### Phase C
10. aider renderer（预留）
11. 定制化扩展机制（外部注册）

---

## 9. 不变的部分（No-Change）

- `packages/server/` → 完全不变
- `packages/protocol/src/types.ts` → `StructuredContent` 类型新增，已有类型不变
- `packages/web/src/styles.css` → `.chat-bubble-body` 改为渲染 `StructuredBlock`，已有样式不变
- `packages/web/src/pages/TerminalPage.tsx` → 不变
- SSE 协议（event stream 格式）→ 不变
- `Transport` 接口 → 不变
