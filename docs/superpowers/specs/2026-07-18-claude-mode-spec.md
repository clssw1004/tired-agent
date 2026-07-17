# Claude 模式具体实现（修订版）

基于 xterm.js 完整终端渲染

## 核心思路

**不解析 Claude 的 TUI，直接用 xterm.js 完整渲染终端输出。**

由于渲染区不再限制为气泡，xterm.js 可以直接渲染 Claude 的真实 TUI 界面——spinner、分隔线、`●` 标记、状态栏、全部正确显示。

```
SSE chunk ─→ xterm.write(chunk) ─→ xterm 渲染完整终端
                                         │
                                    （必要时）读最后一行检测输入等待
                                         │
                                 InterventionBar（确认按钮）
                                         │
                                 InputBar（底部输入框）
```

---

## 组件结构

```
ChatContainer
├── Header
├── RenderArea
│   └── ClaudeView            ← xterm.js 直接渲染终端
│       ├── <div ref={termRef} />  ← DOM 挂载点
│       └── terminal.write()       ← 所有 CSI 给 xterm
│
├── InterventionBar            ← 检测到 [y/N]/❯ 时出现
└── InputBar                   ← 始终底部固定
```

---

## 具体实现

### 1. xterm.js 终端实例

```tsx
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

function ClaudeView({ stream }: { stream: Observable<Uint8Array> }) {
  const termRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      theme: {
        background: 'transparent',     // 背景透明，跟随页面主题
        foreground: '#e0e0e0',
        cursor: 'transparent',          // 隐藏光标
      },
      cursorBlink: false,
      disableStdin: true,              // 只读——不接受键盘输入
      fontSize: 12,
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    });

    terminalRef.current = term;
    term.open(termRef.current!);

    // 隐藏光标（xterm 默认显示光标）
    term.element?.classList.add('xterm-readonly');

    return () => term.dispose();
  }, []);

  // 接收 SSE chunks 写入终端
  useEffect(() => {
    const sub = stream.subscribe(chunk => {
      terminalRef.current?.write(chunk);
    });
    return () => sub.unsubscribe();
  }, [stream]);

  return <div ref={termRef} className="claude-terminal" />;
}
```

**关键配置**：
- `disableStdin: true` — 不从 xterm 接收键盘输入（输入走我们的 InputBar）
- `cursor: transparent` — 隐藏闪烁光标
- `background: transparent` — 透明背景，用页面主题

### 2. 输入处理

**不走 xterm 的键盘**。用户通过底部 InputBar 输入：

```
用户打字 → InputBar → transport.sendInput(text + '\r') → PTY
```

PTY 把输入回显给 xterm，xterm 自然显示在终端里。不需要额外处理。

### 3. 干预检测（InterventionBar）

不解析 ANSI，而是**读 xterm 终端的最后几行**来检测是否需要干预：

```tsx
function usePromptDetection(terminal: Terminal | null): ContentPrompt | null {
  const [prompt, setPrompt] = useState<ContentPrompt | null>(null);

  useEffect(() => {
    if (!terminal) return;
    
    const check = () => {
      const buf = terminal.buffer.active;
      const lines = [];
      for (let y = Math.max(0, buf.length - 4); y < buf.length; y++) {
        const line = buf.getLine(y);
        if (line) lines.push(line.translateToString().trim());
      }
      
      const lastLine = lines[lines.length - 1] ?? '';
      
      // Claude 的 ❯ 提示符
      if (lastLine.startsWith('❯') || lastLine.startsWith('$')) {
        setPrompt(null); // Claude 在等输入，但不显示确认
        return;
      }
      
      // 确认模式：[y/N]
      if (/\[y\/N\]|\[Y\/n\]|\(y\/n\)/.test(lastLine)) {
        setPrompt({
          type: 'prompt', kind: 'yesno',
          text: lastLine, options: ['y', 'n']
        });
        return;
      }
      
      // 行末是问号且输出停止
      if (lastLine.endsWith('?') && !lastLine.startsWith('●')) {
        setPrompt({
          type: 'prompt', kind: 'yesno',
          text: lastLine, options: ['y', 'n']
        });
        return;
      }
    };
    
    // 每次 chunks 写入后检查
    const observer = new MutationObserver(check);
    // 或者用自定义事件
  }, [terminal]);

  return prompt;
}
```

### 4. 干预操作

```tsx
function InterventionBar({ prompt }: { prompt: ContentPrompt }) {
  if (prompt.kind === 'yesno') {
    return (
      <div className="intervention-bar">
        <span>{prompt.text}</span>
        <div className="intervention-actions">
          <button onClick={() => send(prompt.options![0])}>确认</button>
          <button onClick={() => send(prompt.options![1])}>拒绝</button>
        </div>
      </div>
    );
  }
}

function send(response: string) {
  // 把响应写入 PTY
  transport.sendInput(serverRef, sessionId, 
    new TextEncoder().encode(response + '\n')
  );
}
```

---

## 数据流总结

```
SSE (原始字节)
  │
  ├→ xterm.write()           → xterm 渲染完整终端
  │                              └─ 用户看到 spinner / ●回答 / 分隔线 / 状态栏
  │
  ├→ 干预检测（读 buffer 最后行）
  │     └─ 检测到 [y/N] 或 ? → 显示 InterventionBar
  │                              └─ 用户点击确认 → PTY write("y\n")
  │
  └→ InputBar（底部）
       └─ 用户输入 → PTY write(text + "\r")
```

**优势**：
- 不需要任何 ANSI 解析代码——xterm.js 全部处理
- Claude 的所有 TUI 细节正确显示（包括未来的版本更新）
- 输入不经过终端，用原生 input 组件（手机键盘友好）
- 干预检测直接从 xterm buffer 读文本，不需要解析 ANSI
- 代码量最小化

**唯一的场景需要解析**：如果你需要把 Claude 回答以**纯文本形式复制/sharing**，可以从 xterm buffer 读文本。但展示层面不需要。

---

## 文件改动

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/components/render-views/ClaudeView.tsx` | 新建 | xterm.js 终端渲染 + 干预检测 |
| `src/components/InterventionBar.tsx` | 新建 | 确认按钮 |
| `src/components/InputBar.tsx` | 新建 | 从现有 ChatView 提取 |
| `src/components/ChatContainer.tsx` | 新建 | 主容器 |
| `src/renderer/builtins/claude.ts` | 保留 | 仅用于检测（cmd→claude），不做解析 |
| `src/styles.css` | 修改 | xterm 样式适配 + 移除气泡样式 |
| `package.json` | 修改 | 加 `xterm` 依赖 |

**不再需要**：手写 ScreenBuffer、ANSI 解析、ContenPrompt 类型（如果要复用结构化数据才需要）。
