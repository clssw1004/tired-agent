# 结构化聊天模式设计 —— Claude 的 Chat/Timeline 模式

> 日期：2026-07-19
> 状态：设计阶段
> 关联：Agent Rendering Engine (2026-07-18-agent-renderer-design.md)、ChatContainer 重新设计 (2026-07-18-chat-container-redesign.md)

---

## 1. 背景与动机

### 1.1 现状

目前项目只支持 **PTY 模式**：通过 node-pty 启动 Claude CLI，原始终端字节流通过 SSE 传输，最终在 xterm.js 中渲染。所有输出（代码、文本、工具调用）都以终端文本展示，无法结构化呈现。

### 1.2 目标

参考 Anthropic 官方 VS Code Extension 的做法，增加 **结构化模式（Structured Mode）**：

- 以 `--output-format stream-json` 启动 Claude CLI，输出 NDJSON 流
- 解析每个 JSON 事件（message、tool_use、tool_result 等）
- 用 React 组件渲染为时间轴聊天界面
- **与现有的 PTY/xterm 模式共存**，用户在创建 session 时选择

### 1.3 原则

| 原则 | 说明 |
|------|------|
| **共存不取代** | 两种模式各自独立，用户自由选择。PTY 模式完全不变 |
| **最小改动** | Agent 端几乎不改——仍是"哑管道"（bytes in → bytes out）。所有智能在 Web 端 |
| **增量落地** | 先基础结构化渲染，再逐步增加交互功能 |

---

## 2. 整体架构

### 2.1 两种模式对比

```
PTY 模式（现有）:
  Claude CLI (TUI 模式)
    ↓ PTY stdout: ANSI 终端文本 + 转义序列
  node-pty
    ↓ bytes
  SSE: event=output, data=base64(bytes)
    ↓ bytes
  Web: xterm.js 渲染（canvas/WebGL）
    ↓
  用户看到: 终端界面

结构化模式（新增）:
  Claude CLI (stream-json 模式)
    ↓ PTY stdout: NDJSON 行
  node-pty
    ↓ bytes（仍是字节，但内容是 JSON）
  SSE: event=output, data=base64(bytes)
    ↓ bytes → 按行分割 → JSON parse
  Web: StructuredRenderer 解析
    ↓ StructuredContent[]
  React 组件渲染: 时间轴聊天
    ↓
  用户看到: VS Code Extension 风格的对话界面
```

### 2.2 核心架构决策

**Agent 是"哑管道"**：Agent 不需要理解 JSON 格式。两种模式下 Agent 的行为完全一致：
- 创建 PTY 进程（参数不同）
- PTY stdout → append log → SSE broadcast
- SSE input → PTY stdin

**Web 端负责解析**：SSE 流是一样的 `event: output`，Web 端根据 session 的 `mode` 字段决定如何解析和渲染。

**NDJSON 边界安全**：PTY 的 `onData` 可能在行中间切分。Web 端维护一个行缓冲区，不完整的行等待下一个 chunk 补齐。

---

## 3. 协议层变更

### 3.1 SessionSpec 加 mode 字段

```typescript
// packages/protocol/src/types.ts

export type SessionMode = 'pty' | 'structured';

export interface SessionSpec {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  label?: string;
  /** @default 'pty' — 向后兼容 */
  mode?: SessionMode;
}
```

### 3.2 Session / SessionRecord 加 mode 字段

```typescript
export interface Session {
  id: string;
  cmd: string;
  args: string[];
  // ... 现有字段不变 ...
  mode: SessionMode;  // 新增
}

// SessionRecord 同理
```

### 3.3 StructuredContent 扩充

当前 `StructuredContent` 类型已经定义了 text、code、divider、status 等变体。结构化模式下需要新增：

```typescript
// 用户消息气泡
export interface ContentUserMessage {
  type: 'userMessage';
  text: string;
}

// 工具调用卡片
export interface ContentToolUse {
  type: 'toolUse';
  name: string;
  /** JSON 格式的工具参数 */
  input: string;
  /** 工具调用唯一 ID，用于关联结果 */
  toolUseId: string;
  /** 是否已完成（可折叠） */
  completed?: boolean;
}

// 工具调用结果
export interface ContentToolResult {
  type: 'toolResult';
  toolUseId: string;
  /** 结果内容（可以是文本、diff、错误等） */
  content: string;
  /** 结果的 MIME 类型提示 */
  mimeType?: string;
  /** 是否出错 */
  isError?: boolean;
}

// 思考/流式增量文本
export interface ContentStreamEvent {
  type: 'streamEvent';
  text: string;
  /** true = 追加到上一条 assistant 消息，false = 新消息 */
  append: boolean;
}

// Token 用量
export interface ContentUsage {
  type: 'usage';
  inputTokens: number;
  outputTokens: number;
}
```

完整 union 更新：

```typescript
export type StructuredContent =
  | ContentText
  | ContentCode
  | ContentDivider
  | ContentStatus
  | ContentTable
  | ContentLink
  | ContentImage
  | ContentCommand
  | ContentUserMessage    // 新增
  | ContentToolUse        // 新增
  | ContentToolResult     // 新增
  | ContentStreamEvent    // 新增
  | ContentUsage;         // 新增
```

### 3.4 无需新增 SSE 事件类型

保持现有 SSE 格式不变：

```
event: output\ndata: {"offset": N, "data": "<base64-encoded-bytes>"}
event: state\ndata: { ...session-with-mode... }
event: heartbeat\ndata: {"ts": N}
```

Web 端通过 `state` 事件中的 `session.mode` 字段区分处理逻辑。

---

## 4. Agent 端变更

### 4.1 Session 创建 —— 注入 stream-json 参数

`packages/agent/src/session/manager.ts` 中，`create()` 方法在 `spec.mode === 'structured'` 时，自动在 args 前插入 stream-json 参数：

```typescript
// manager.ts — create 方法
async create(spec: SessionSpec): Promise<SessionRecord> {
  const id = randomUUID();

  // 构建最终的 cmd + args
  let cmd = normalizeCmd(spec.cmd);
  let args = [...(spec.args ?? [])];

  if (spec.mode === 'structured') {
    // 结构化模式：注入 stream-json 参数
    // --output-format stream-json 让 CLI 输出 NDJSON 行
    // --input-format stream-json 让 CLI 从 stdin 读取 JSON 消息
    // --include-partial-messages 让流事件（打字机效果）也能输出
    args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      ...args,  // 用户自定义参数在最后
    ];
  }

  const record = createSessionRecord(id, { ...spec, args });
  this.storage.insert(record);

  // 后续 spawn、onData、onExit 等逻辑完全不变
  // ...
}
```

### 4.2 完全不变的部分

| 模块 | 不变原因 |
|------|---------|
| `storage.ts` | 日志文件仍然是字节序列，内容变为 JSON 行但不影响存储 |
| `routes/sessions.ts` | REST 接口不变，`SessionSpec` 多加一个字段而已 |
| `routes/stream.ts` | SSE 事件格式不变，`output` 事件传输的仍然是 base64 字节 |
| `auth.ts` | 无变化 |
| `config.ts` | 无变化 |

### 4.3 注意点

- 当 `spec.mode === 'structured'` 时，`spec.cols` / `spec.rows` 对结构化模式无意义（不需要终端尺寸），但仍传入 PTY 防止报错
- PTY 的 `name: 'xterm-256color'` 不影响 NDJSON 输出

---

## 5. Web 端：传输层

### 5.1 Session 创建时传递 mode

`HttpSseTransport.createSession()` 已经将 `SessionSpec` 序列化为 JSON 发送，无需修改：

```typescript
// 创建结构化 session（调用方传入 mode）
const session = await transport.createSession(serverRef, {
  cmd: 'claude',
  mode: 'structured',
  label: 'Structured Chat',
});
```

### 5.2 订阅时获取 mode

SSE 连接后收到的第一个 `state` 事件中会包含 `mode` 字段。ChatContainer 通过 `session.mode` 决定渲染路径：

```typescript
// ChatContainer.tsx
const [mode, setMode] = useState<'pty' | 'structured'>('pty');

// 在 SSE subscribe 的 onState 回调中：
onState: (session) => {
  setMode(session.mode ?? 'pty');
  // ...
}
```

---

## 6. Web 端：渲染管线

### 6.1 ClaudeRenderer 重构 —— 真正的 NDJSON 解析器

当前 `ClaudeRenderer` 是空实现。结构化模式下，它需要：

```typescript
// packages/web/src/renderer/builtins/claude.ts

export class ClaudeRenderer implements AgentRenderer {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  private _contents: StructuredContent[] = [];
  /** 行缓冲区 — PTY 可能在行中间切分 */
  private _lineBuffer = '';
  /** 当前 assistant 消息的累积文本（用于 stream_event append） */
  private _currentAssistantText = '';

  processChunk(chunk: string, ctx: RenderContext): RenderOutput | void {
    // 1. 追加到行缓冲区
    this._lineBuffer += chunk;

    // 2. 按 \n 分割完整行
    const lines = this._lineBuffer.split('\n');
    // 最后一段可能是未完成的行，保留到下一个 chunk
    this._lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed);
        this._handleEvent(event);
      } catch {
        // 非 JSON 行：可能是 CLI 的启动输出、警告等
        // 尝试当作普通文本处理
        if (trimmed.length > 0) {
          this._contents.push({
            type: 'text',
            text: trimmed,
          });
        }
      }
    }

    // 3. 返回 current contents（完整列表，UI 做 diff）
    return {
      contents: this._contents,
      displayMode: 'chat',
    };
  }

  private _handleEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message':
        this._handleMessage(event as ClaudeMessage);
        break;
      case 'tool_use':
        this._handleToolUse(event as ClaudeToolUse);
        break;
      case 'tool_result':
        this._handleToolResult(event as ClaudeToolResult);
        break;
      case 'stream_event':
        this._handleStreamEvent(event as ClaudeStreamEvent);
        break;
      case 'control_request':
        this._handleControlRequest(event as ClaudeControlRequest);
        break;
      case 'usage':
        this._handleUsage(event as ClaudeUsage);
        break;
      default:
        // 未知事件类型 — 版本兼容，静默忽略
        break;
    }
  }

  private _handleMessage(msg: ClaudeMessage): void {
    if (msg.role === 'user') {
      this._contents.push({ type: 'userMessage', text: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      this._contents.push({ type: 'text', text: msg.content ?? '' });
      this._currentAssistantText = msg.content ?? '';
    }
  }

  private _handleToolUse(tool: ClaudeToolUse): void {
    this._contents.push({
      type: 'toolUse',
      name: tool.name,
      input: JSON.stringify(tool.input, null, 2),
      toolUseId: tool.id,
      completed: false,
    });
  }

  private _handleToolResult(result: ClaudeToolResult): void {
    this._contents.push({
      type: 'toolResult',
      toolUseId: result.tool_use_id,
      content: result.output ?? result.content ?? '',
      isError: result.is_error ?? false,
    });
    // 标记对应的 toolUse 为已完成
    for (const c of this._contents) {
      if (c.type === 'toolUse' && c.toolUseId === result.tool_use_id) {
        c.completed = true;
      }
    }
  }

  private _handleStreamEvent(ev: ClaudeStreamEvent): void {
    // stream_event 是打字机效果的增量文本
    // 如果 append=true，追加到上一条 assistant 消息
    this._contents.push({
      type: 'streamEvent',
      text: ev.delta ?? '',
      append: this._currentAssistantText.length > 0,
    });
    this._currentAssistantText += ev.delta ?? '';
  }

  private _handleControlRequest(req: ClaudeControlRequest): void {
    // 权限请求、确认等 → 留给 InterventionBar
    this._contents.push({
      type: 'status',
      status: 'thinking',
      text: `需要确认: ${req.description ?? '权限请求'}`,
    });
  }

  private _handleUsage(usage: ClaudeUsage): void {
    this._contents.push({
      type: 'usage',
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    });
  }

  flush(): RenderOutput | void {
    // 处理行缓冲区中残留的最后一个 chunk
    if (this._lineBuffer.trim()) {
      try {
        const event = JSON.parse(this._lineBuffer.trim());
        this._handleEvent(event);
      } catch { /* ignore */ }
    }
    this._lineBuffer = '';
    if (this._contents.length > 0) {
      return { contents: this._contents, displayMode: 'chat' };
    }
  }

  getContents(): StructuredContent[] { return this._contents; }
  awaitingInput(): boolean { return false; }
  reset(): void { this._contents = []; this._lineBuffer = ''; this._currentAssistantText = ''; }
}
```

### 6.2 ChatContainer 分叉渲染

```typescript
// ChatContainer.tsx — 核心改动

// 新增状态
const [mode, setMode] = useState<'pty' | 'structured'>('pty');
const [structuredContents, setStructuredContents] = useState<StructuredContent[]>([]);

// SSE 订阅时区分 mode
onState: (session) => {
  setMode(session.mode ?? 'pty');
}

onChunk: (chunk) => {
  const text = decodeText(chunk.data);
  if (!text) return;

  if (mode === 'pty') {
    // PTY 模式：现有逻辑 — 写入 xterm
    const wasAtBottom = termRef.current?.isAtBottom() ?? true;
    termRef.current?.write(text);
    if (wasAtBottom) termRef.current?.scrollToBottom();
  } else {
    // 结构化模式：交给 renderer 解析
    const output = rendererRef.current.processChunk(text, {
      session: sessionRef.current,
      streaming: true,
      segmentContent: [],
    });
    if (output && output.contents.length > 0) {
      setStructuredContents([...output.contents]);
    }
  }
}
```

### 6.3 RenderArea 分叉

```tsx
// ChatContainer.tsx — render 方法
<div className="render-area">
  {mode === 'pty' ? (
    <TerminalView
      ref={termRef}
      onReady={() => setTermReady(true)}
      onUserInput={(data) => void writeBytes(data)}
      onSelectionChange={(text) => setSelection(text)}
      onScroll={(ab) => setAtBottom(ab)}
    />
  ) : (
    <ChatTimelineView contents={structuredContents} />
  )}
</div>
```

### 6.4 ChatTimelineView 组件

新增组件 `packages/web/src/components/ChatTimelineView.tsx`，将 `StructuredContent[]` 渲染为时间轴 UI：

```tsx
// ChatTimelineView.tsx
function ChatTimelineView({ contents }: { contents: StructuredContent[] }) {
  return (
    <div className="chat-timeline">
      {contents.map((c, i) => (
        <TimelineItem key={i} content={c} />
      ))}
    </div>
  );
}

function TimelineItem({ content }: { content: StructuredContent }) {
  switch (content.type) {
    case 'userMessage':
      return <UserBubble text={content.text} />;
    case 'text':
      return <AssistantBubble text={content.text} />;
    case 'code':
      return <CodeBlock code={content.code} language={content.language} />;
    case 'toolUse':
      return <ToolUseCard name={content.name} input={content.input}
                completed={content.completed} toolUseId={content.toolUseId} />;
    case 'toolResult':
      return <ToolResultCard content={content.content}
                isError={content.isError} />;
    case 'streamEvent':
      return <StreamingText delta={content.text} />;
    case 'status':
      return <StatusIndicator status={content.status} text={content.text} />;
    case 'usage':
      return <UsageBadge input={content.inputTokens} output={content.outputTokens} />;
    default:
      return null;
  }
}
```

---

## 7. 输入处理

### 7.1 结构化模式下的输入格式

PTY 模式下，用户按 Enter 发送 `\r`。结构化模式下，用户输入整条消息后按 Enter 发送 JSON 消息：

| 动作 | PTY 模式 | 结构化模式 |
|------|---------|-----------|
| 输入 "Hello" 后回车 | `Hello\r` | `{"type":"message","content":"Hello"}\n` |
| Ctrl+C | `\x03` | `{"type":"control","command":"interrupt"}\n` |
| Tab 补全 | `\t` | （无 — 结构化模式下不需要） |

### 7.2 InputBar 适配

```typescript
// ChatContainer.tsx
const writeBytes = useCallback(async (data: string) => {
  if (disabled || !data) return;
  try {
    const transport = createHttpSseTransport();
    if (mode === 'structured') {
      // 结构化模式：将输入格式化为 JSON 消息
      const msg = JSON.stringify({ type: 'message', content: data }) + '\n';
      await transport.sendInput(serverRef, sessionId, ENCODER.encode(msg), agentId);
    } else {
      // PTY 模式：现有逻辑
      await transport.sendInput(serverRef, sessionId, ENCODER.encode(data), agentId);
    }
  } catch (err) {
    setTransportError((err as Error).message);
  }
}, [disabled, serverRef, sessionId, agentId, mode]);
```

### 7.3 SpecialKeysBar 适配

结构化模式下，SpecialKeysBar 的按键映射需要调整：

| 按键 | PTY 模式 | 结构化模式 |
|------|---------|-----------|
| Ctrl+C | `\x03` | `{"type":"control","command":"interrupt"}\n` |
| Ctrl+D | `\x04` | 忽略（结构化模式下无意义） |
| 方向键↑↓ | `\x1b[A` / `\x1b[B` | 忽略（由聊天历史替代） |

---

## 8. Session 创建 UI

### 8.1 模式选择器

`SessionCreatePage` 增加模式切换：

```tsx
// SessionCreatePage.tsx — 新增
const [mode, setMode] = useState<'pty' | 'structured'>('pty');

// 当选择 Claude 预设时，自动切换到 structured 模式
const applyPreset = (p: Preset) => {
  setCmd(p.cmd);
  setArgs(p.args);
  setLabel('');
  if (p.cmd === 'claude') setMode('structured');
};

// 表单中增加模式切换
<div className="form-section">
  <div className="form-section-label">Display mode</div>
  <div className="mode-toggle">
    <button
      className={mode === 'pty' ? 'is-active' : ''}
      onClick={() => setMode('pty')}
    >
      ⬛ Terminal
    </button>
    <button
      className={mode === 'structured' ? 'is-active' : ''}
      onClick={() => setMode('structured')}
      disabled={cmd !== 'claude'}  // 仅 Claude 支持
    >
      💬 Chat
    </button>
  </div>
  {mode === 'structured' && (
    <div className="field-hint">
      Chat mode renders Claude's output as a structured timeline
      with code highlighting, tool cards, and diffs.
    </div>
  )}
</div>
```

### 8.2 预设默认模式

| 预设 | 默认 mode |
|------|-----------|
| Claude | `structured`（用户可手动切回 `pty`） |
| Bash / Zsh / cmd | `pty`（禁用 structured） |
| Python / Node | `pty`（禁用 structured） |

---

## 9. 数据流总览

### 9.1 创建会话

```
用户点击 "Create session" (mode=structured)
  → SessionCreatePage 组装 SessionSpec { cmd:'claude', mode:'structured', ... }
  → HttpSseTransport.createSession() → POST /v1/sessions
  → Agent: manager.create(spec)
    → 识别 mode='structured'
    → args = ['--output-format','stream-json','--input-format','stream-json','...']
    → spawn('claude', args)
    → 返回 Session { mode:'structured', ... }
  → Web: TerminalPage 接收 session
  → 渲染 ChatContainer (mode='structured')
```

### 9.2 流式输出

```
Claude CLI → stdout → NDJSON 行
  → node-pty onData
  → storage.appendOutput(bytes)     ← 存到 .log 文件
  → SSE event: output (base64 bytes)
  → Web SSE 订阅 → onChunk
  → decodeText(bytes) → 文本
  → ClaudeRenderer.processChunk(text)
    → 缓冲区按 \n 分割
    → 每行 JSON.parse → _handleXxx()
    → 产出 StructuredContent[]
  → setStructuredContents([...])
  → React diff → 更新 DOM
```

### 9.3 用户输入

```
用户在 InputBar 输入消息后按 Enter
  → ChatContainer.writeBytes("帮我写个API")
  → mode === 'structured':
    → msg = JSON.stringify({type:"message",content:"帮我写个API"}) + '\n'
    → transport.sendInput(serverRef, sessionId, encode(msg))
    → POST /v1/sessions/:id/input { data: base64(msg) }
    → Agent: manager.write(id, bytes)
    → PTY stdin: {"type":"message","content":"帮我写个API"}\n
  → Claude CLI 处理 → 开始输出 NDJSON 响应
```

### 9.4 重连重放

```
Web 断开后重连
  → transport.subscribe(serverRef, sessionId, { ... }, agentId)
  → SSE 连接
  → ?from=lastKnownOffset
  → Agent 重放 .log 文件中从该偏移量开始的所有字节
  → 结构化模式下，这些字节是 NDJSON 行
  → ClaudeRenderer 逐行解析
  → 恢复完整的历史结构内容
```

---

## 10. CSS 样式指南

### 10.1 时间轴容器

```css
/* styles.css — 新增 */

.chat-timeline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  overflow-y: auto;
  flex: 1;
}

.user-bubble {
  align-self: flex-end;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 12px 12px 4px 12px;
  padding: 8px 14px;
  max-width: 80%;
  color: #e0e0e0;
}

.assistant-bubble {
  align-self: flex-start;
  color: #e0e0e0;
  line-height: 1.6;
  max-width: 100%;
}

.code-block {
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
  padding: 12px 16px;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  overflow-x: auto;
  white-space: pre;
}

.tool-use-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.tool-use-card.is-completed {
  opacity: 0.7;
}

.tool-result-card {
  border-left: 3px solid rgba(255, 255, 255, 0.15);
  padding-left: 12px;
  margin-left: 8px;
  font-size: 13px;
}

.tool-result-card.is-error {
  border-left-color: #f14c4c;
}

.streaming-text {
  opacity: 0.7;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.7; }
  50% { opacity: 0.4; }
}

.usage-badge {
  align-self: flex-end;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
  padding: 2px 8px;
}
```

---

## 11. Claude JSON 事件类型参考

Claude CLI 的 stream-json 输出格式（基于公开文档和 VS Code 扩展逆向）：

```typescript
// Claude CLI NDJSON 事件类型（参考）

interface ClaudeMessage {
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  id?: string;
  model?: string;
}

interface ClaudeToolUse {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  id: string;
}

interface ClaudeToolResult {
  type: 'tool_result';
  tool_use_id: string;
  output?: string;
  content?: string;
  is_error?: boolean;
}

interface ClaudeStreamEvent {
  type: 'stream_event';
  event: string;  // e.g. "text_delta"
  delta?: string;
}

interface ClaudeControlRequest {
  type: 'control_request';
  kind: string;  // e.g. "permission"
  description?: string;
  tool_use_id?: string;
}

interface ClaudeUsage {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
}

interface ClaudeError {
  type: 'error';
  error: {
    type: string;
    message: string;
  };
}
```

> **注意**：这些类型基于社区观察，Claude CLI 的具体输出格式可能会有变化。实现时应做版本容错（未知事件静默忽略，解析失败回退到文本渲染）。

---

## 12. 实现阶段

### Phase 1: 基础骨架（预计 1-2 天）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1.1 | `packages/protocol/types.ts` | 加 `SessionMode` 类型、`mode` 字段、新的 `StructuredContent` 变体 |
| 1.2 | `packages/agent/src/session/manager.ts` | `create()` 中识别 `mode === 'structured'`，注入 stream-json 参数 |
| 1.3 | `packages/agent/src/session/types.ts` | `SessionRecord` 加 `mode` 字段 |
| 1.4 | `packages/agent/src/session/storage.ts` | DB schema 加 `mode` 列 |
| 1.5 | `packages/web/src/renderer/builtins/claude.ts` | 实现 `ClaudeRenderer` 为 NDJSON 解析器 |
| 1.6 | `packages/web/src/components/ChatTimelineView.tsx` | 新建——基础时间轴组件 |
| 1.7 | `packages/web/src/components/ChatContainer.tsx` | 根据 `mode` 分叉渲染输入输出 |
| 1.8 | `packages/web/src/pages/SessionCreatePage.tsx` | 加 mode 选择器 |

### Phase 2: 交互增强（预计 2-3 天）

| 步骤 | 改动 |
|------|------|
| 2.1 | 工具卡片可折叠（`ToolUseCard` 展开/收起） |
| 2.2 | 代码块语法高亮（集成 shiki 或 highlight.js） |
| 2.3 | Diff 视图组件（解析 `toolResult` 中的 diff） |
| 2.4 | 流式打字机效果（`streamEvent` 逐渐显示文本） |
| 2.5 | 复制代码块按钮 |

### Phase 3: 体验完善（预计 2-3 天）

| 步骤 | 改动 |
|------|------|
| 3.1 | 会话历史保留（从 replay 恢复结构化内容） |
| 3.2 | 权限请求处理（`control_request` → InterventionBar） |
| 3.3 | 自动滚动到底部 |
| 3.4 | 输入框适配（按 Enter 发送整条消息） |
| 3.5 | Ctrl+C 中断（SpecialKeysBar 适配结构化模式） |

---

## 13. 边界情况处理

### 13.1 非 JSON 输出

Claude CLI 在启动时可能会输出非 JSON 文本（如授权提示、更新通知）。处理方式：

- 尝试解析每一行 JSON，失败则按纯文本渲染
- 前几行可能是 CLI 的 banner 文本，渲染为普通文本

### 13.2 行缓冲

PTY 的 `onData` 可能在任意位置切分数据。Web 端的 NDJSON 解析器必须处理：

```
Chunk 1: {"type":"message","role":"a
Chunk 2: ssistant","content":"Hello"}
```

处理方式：维护一个行缓冲区，`this._lineBuffer += chunk`，然后按 `\n` 分割。不完整的最后一段保留到下一个 chunk。

### 13.3 模式切换安全

- 用户不能在 session 运行中切换模式。`mode` 在创建时确定，不可变
- 如果 `mode: 'structured'` 但 `cmd` 不是 `claude`，Agent 仍然注入 stream-json 参数（Claude CLI 会忽略它不认识的 flag 并报错，所以 UI 层面应该禁止非 claude 命令使用 structured 模式）

### 13.4 向后兼容

- 现有 .log 文件不受影响（它们存储的是 PTY 模式的 ANSI 字节）
- 旧版 web 客户端加载的新 session：不识别 `mode` 字段 → 默认 `'pty'` → xterm 渲染 NDJSON → 显示为纯 JSON 文本（可接受的后备行为）
- 旧版 Agent 不认识 `mode` 字段：`SessionSpec` 中忽略额外字段 → 默认 PTY 行为

---

## 14. 未涉及的范围（后续版本）

| 功能 | 说明 |
|------|------|
| WebSocket 传输 | 结构化模式下 SSE 仍然适用，未来可换 |
| 并行工具调用 | Claude 支持多个 tool_use 并发，后续增强渲染 |
| 会话编辑 | VS Code 扩展支持编辑已发送消息 |
| Checkpoint / Rewind | Claude 的 checkpoint 功能，Web 端暂不实现 |
| 图片渲染 | `ContentImage` 类型已定义，但 Claude 的 tool_result 可能包含 base64 图片，后续支持 |

---

## 15. 参考

- [Claude Code VS Code Extension 文档](https://code.claude.com/docs/zh-CN/vs-code)
- [Anthropic Claude Code Extension 市场页面](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
- [ChatContainer 重新设计 (2026-07-18)](2026-07-18-chat-container-redesign.md)
- [Agent Rendering Engine 设计 (2026-07-18)](2026-07-18-agent-renderer-design.md)
