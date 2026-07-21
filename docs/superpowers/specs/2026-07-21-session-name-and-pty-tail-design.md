# session 默认命名 + PTY 大输出 tail 快速进入 —— 设计文档

- 日期：2026-07-21
- 分支：`feat/session-name-and-pty-tail-20260721`
- 状态：已评审通过，待实现

## 背景与目标

两块独立但同 PR 的小需求，都集中在用户体验：

1. **session 默认命名**：当前 `SessionCreatePage` 已有 Label 输入框（`packages/web/src/pages/SessionCreatePage.tsx:65,293-299`），用户不填时回退显示 `cmd`（`SessionCard.tsx:34`、`TerminalPage.tsx:68,77`）。同一命令开两个 session 时 SessionCard 列表里分不出谁是谁。本次改动：**未填 label 时自动生成 `8位字符_完整时间戳`**（本地时间）作为 label 发到后端，方便用户一眼区分多个 session。

2. **PTY 大输出加载慢**：当前 `fetchOutput(sid, 0, undefined)` 让服务端 `readFileSync` **整个日志文件**（`packages/agent/src/session/storage.ts:173`），再 base64 + JSON 序列化回前端。一个 50MB 的 Claude session 日志会让手机端首次进入卡顿 5-15 秒。本次改动：**加 `?tail=N` 参数，服务端只读末尾 N 字节**（倒序 seek），前端默认 `tail=64KB` 起步；UI 加"加载完整历史"按钮应急。

## 决策记录

| 问题 | 决策 | 理由 |
|---|---|---|
| 默认名格式 | `8位字符_完整时间戳` | 用户确认；绝对唯一，可读，~22 字符 |
| 默认名时区 | 本地时间 | 用户确认；与 SessionCard 的 "X minutes ago" 体验一致 |
| 默认 tail 字节数 | 64KB | 用户确认；3-4 屏终端，Claude chat 结尾上下文够用 |
| `?tail` vs `?from+limit` | 互斥；tail 优先 | 服务端互斥校验；尾部场景与增量回放场景意图完全不同 |
| 持久模式 tail？ | 不做 | `ClaudeChatView` 用 NDJSON 解析，需完整结构；按字节截断会破坏 JSON 边界 |
| truncated 字段 backward-compat | 可选字段，旧 agent 不返回时前端不崩 | 老 agent 还在跑生产环境时前端升级不能挂 |
| UTF-8 字符切在 tail 边界 | fatal:false 解码，U+FFFD 替换 | 简单可接受；用户视觉上看不到错位 |

## 设计方案

### 1. 前端默认名生成

**`packages/web/src/pages/SessionCreatePage.tsx`**

工具函数：

```ts
// 32 个无歧义字符：去掉 0/1/l/o 这类容易看错/打错的
const LABEL_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

function generateDefaultLabel(): string {
  const rnd = Array.from(
    { length: 8 },
    () => LABEL_CHARS[Math.floor(Math.random() * LABEL_CHARS.length)],
  ).join('');
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${rnd}_${stamp}`;
}
```

改动点：
- `handleCreate` line 142：`label: label.trim() || generateDefaultLabel()`
- Label 输入框 placeholder：`"可选 — 留空自动生成 a3k9m2x8_20260721T143052"`

**不改的**：后端零改动（协议已支持 label，manager proxy 透传，agent zod 只做 optional 字符串检查）。`SessionCard.tsx`、`TerminalPage.tsx` 的 `{label || cmd}` fallback 保留。

### 2. PTY tail 加载（跨层）

#### 2.1 protocol 类型扩展

**`packages/protocol/src/types.ts:177-186`** `FetchOutputResult` 加可选字段：

```ts
export interface FetchOutputResult {
  chunks: Array<{ offset: number; data: string }>;
  upTo: number;
  /** true = server returned fewer bytes than remaining (tail mode hit file end early) */
  truncated?: boolean;
  /** Total bytes in the log file at read time. Used by UI to show "已加载尾部 X / 共 Y". */
  totalBytes?: number;
}
```

#### 2.2 agent storage tail 实现

**`packages/agent/src/session/storage.ts`**

- 顶部 import 追加：`import { openSync, closeSync, readSync } from 'node:fs'`
- `Storage` 接口加方法：

```ts
readOutputTail(id: string, n: number): {
  chunks: Array<{ offset: number; data: Uint8Array }>;
  upTo: number;
  truncated: boolean;
};
```

- `SqliteStorage` 实现（~25 行）：

```ts
function readOutputTail(id, n) {
  const logPath = join(dataDir, 'sessions', `${id}.log`);
  if (!existsSync(logPath)) return { chunks: [], upTo: 0, truncated: false };
  const total = statSync(logPath).size;
  if (total <= 0 || n <= 0) return { chunks: [], upTo: total, truncated: false };
  const want = Math.min(n, total);
  const start = total - want;
  const fd = openSync(logPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(want);
    readSync(fd, buf, 0, want, start);
    return {
      chunks: [{ offset: start, data: new Uint8Array(buf) }],
      upTo: total,
      truncated: want < total,
    };
  } finally { closeSync(fd); }
}
```

- MySQL/Postgres stub 加同名 throw，保持接口单一
- `createStorage` 返回对象加 `readOutputTail`

#### 2.3 agent routes 解析 `?tail`

**`packages/agent/src/routes/sessions.ts`**

- `OutputQuerySchema` 扩展：

```ts
const OutputQuerySchema = z.object({
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(10 * 1024 * 1024).optional(),
  tail: z.coerce.number().int().min(1).max(10 * 1024 * 1024).optional(),
}).refine(
  (q) => !(q.tail != null && (q.from !== 0 || q.limit != null)),
  { message: 'tail is mutually exclusive with from+limit; omit from when using tail' },
);
```

- handler 分支：

```ts
if (parsed.data.tail != null) {
  const result = storage.readOutputTail(id, parsed.data.tail);
  return reply.code(200).send({
    chunks: result.chunks.map((c) => ({
      offset: c.offset,
      data: Buffer.from(c.data).toString('base64'),
    })),
    upTo: result.upTo,
    truncated: result.truncated,
    totalBytes: result.upTo,
  });
}
// else 走原 from + limit 路径，加 truncated: false + totalBytes
```

#### 2.4 transport 透传 `tail`

**`packages/protocol/src/HttpSseTransport.ts:372-387`** `fetchOutput` 加 `tail?: number`：

```ts
async fetchOutput(
  ref: ServerRef,
  id: string,
  fromOffset = 0,
  limit?: number,
  agentId?: string,
  tail?: number,        // ← 新增；tail 优先于 from+limit
): Promise<FetchOutputResult> {
  const params = new URLSearchParams();
  if (tail != null) {
    params.set('tail', String(tail));
  } else {
    params.set('from', String(fromOffset));
    if (limit != null) params.set('limit', String(limit));
  }
  // ...余下不变
}
```

#### 2.5 TerminalHandle 加 clear()

**`packages/web/src/components/render-views/TerminalView.tsx`**

`TerminalHandle` interface 加 `clear(): void;`，组件末尾加 `clear: () => term.clear()`。

#### 2.6 PTY 前端消费 tail

**`packages/web/src/components/PtySessionView.tsx`**

```ts
const PTY_OUTPUT_TAIL_BYTES = 64 * 1024; // 64KB

// 截断状态
const [outputTruncated, setOutputTruncated] = useState<{
  truncated: boolean;
  totalBytes: number;
  loadedBytes: number;
} | null>(null);

// 首次进入
const replay = await transport.fetchOutput(
  serverRef, sessionId, 0, undefined, agentId, PTY_OUTPUT_TAIL_BYTES,
);
setOutputTruncated({
  truncated: replay.truncated === true,
  totalBytes: replay.totalBytes ?? replay.upTo,
  loadedBytes: replay.chunks.reduce((s, c) => s + atob(c.data).length, 0),
});

// 加载完整历史
const loadFullHistory = useCallback(async () => {
  termRef.current?.clear();
  const full = await transport.fetchOutput(serverRef, sessionId, 0, undefined, agentId);
  let seeded = '';
  for (const chunk of full.chunks) seeded += decodeText(base64ToBytes(chunk.data));
  if (seeded) termRef.current?.write(seeded);
  termRef.current?.scrollToBottom();
  setOutputTruncated({ truncated: false, totalBytes: full.upTo, loadedBytes: 0 });
}, [serverRef, sessionId, agentId]);

// JSX（在 PtyInterventionBar 上方）
{outputTruncated?.truncated && (
  <div className="output-truncated-banner">
    <span>已加载最后 {formatBytes(outputTruncated.loadedBytes)} / 共 {formatBytes(outputTruncated.totalBytes)}</span>
    <button type="button" onClick={loadFullHistory}>加载完整历史</button>
  </div>
)}

function formatBytes(n: number): string {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
```

#### 2.7 持久模式不改

**`packages/web/src/components/ClaudeChatView.tsx:85`** 仍 `fetchOutput(serverRef, sessionId, 0, undefined, agentId)`，不加 tail。顶部 doc comment 加一行："NDJSON 解析需要完整结构，禁用 tail（truncate 会破坏 JSON 边界）"。

### 3. UI 样式

**`packages/web/src/styles.css`**

```css
.output-truncated-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: rgba(255, 200, 80, 0.12);
  border-bottom: 1px solid rgba(255, 200, 80, 0.35);
  color: var(--text-muted, #888);
  font-size: 12px;
}
.output-truncated-banner button {
  background: transparent;
  border: 1px solid rgba(255, 200, 80, 0.5);
  color: inherit;
  padding: 2px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
```

## 改动文件清单

| 文件 | 改动类型 | 行数估算 |
|---|---|---|
| `packages/web/src/pages/SessionCreatePage.tsx` | 加 `generateDefaultLabel()` + handleCreate 一行改 | +20 / -1 |
| `packages/protocol/src/types.ts` | `FetchOutputResult` 加 2 可选字段 | +2 |
| `packages/agent/src/session/storage.ts` | 加 `readOutputTail` + 接口方法 + import | +30 / -1 |
| `packages/agent/src/routes/sessions.ts` | zod 加 tail + refine + handler 分支 | +20 / -3 |
| `packages/protocol/src/HttpSseTransport.ts` | `fetchOutput` 加 `tail` 参数 + URL 分支 | +8 / -3 |
| `packages/web/src/components/render-views/TerminalView.tsx` | `TerminalHandle.clear()` + 实现 | +3 |
| `packages/web/src/components/PtySessionView.tsx` | tail 常量 + state + handler + banner JSX | +50 / -3 |
| `packages/web/src/components/ClaudeChatView.tsx` | 仅注释 | +1 |
| `packages/web/src/styles.css` | `.output-truncated-banner` 样式 | +15 |

合计：~150 行新增，~10 行删改。

## 验收

### 命名验证

| 场景 | 期望 |
|---|---|
| SessionCreatePage 不填 label 点 Create | `transport.createSession` body 里有 `label: 'a3k9m2x8_20260721T143052'`（验正则） |
| SessionCreatePage 填了 label "我的项目" 点 Create | body 里有 `label: '我的项目'` |
| 后端返回后 SessionCard 显示 | `session.label` 完整字符串，下方 meta 仍是 `cmd args` |
| 默认名格式正则 | `^[a-z2-9]{8}_\d{8}T\d{6}$` |

### PTY tail 验证

| 场景 | 期望 |
|---|---|
| 小 session（< 64KB）首次进入 | `truncated=false`，banner 不显示 |
| 50MB session 首次进入 | 服务端只读末尾 64KB（响应 < 500ms），banner 显示 + "加载完整历史" 按钮 |
| 点 "加载完整历史" | `term.clear()` + 全量 fetchOutput + write，banner 消失 |
| SSE 续接 | `replay.upTo === byteOffset` 时 SSE 直接走 live，不重放 64KB 尾部 |
| UTF-8 切在 tail 边界 | fatal:false 解码 U+FFFD，xterm 渲染不崩 |
| 持久模式 session 首次进入 | 走原 `fetchOutput(0, undefined)`，不变 |
| `?from=10&tail=100` 互斥参数 | 400 VALIDATION_ERROR（refine 触发） |
| 老 agent 不返回 truncated/totalBytes | 前端 `=== true` 判 false，banner 不显示，零回归 |

### 编译 / 自测

```bash
npm run build:protocol
npm run build:agent
npm run build:web
npm run typecheck
```

DevTools 移动端模拟，验证：
1. 创建 session 不填 label → SessionCard 立刻看到 `a3k9m2x8_...` 名字
2. 跑长输出命令（`yes | head -n 10000`）→ 重进 session → banner 显示 → 点"加载完整历史" → banner 消失 + xterm 显示全部
3. DevTools Network 看 `event-stream` SSE 重连不重放已有 64KB

## 兼容性

- 老 agent 升级前端后：`truncated` undefined → banner 不显示；体验退化但无报错
- 老前端调新 agent：传 `from` 不传 `tail` → 走原路径，行为完全不变
- MySQL/Postgres stub 抛 not implemented 时返回 500 → 前端按错误 banner 处理（已有路径）
- xterm scrollback = 5000 行（~5MB UTF-8），64KB 远未触及

## 实现顺序（4 个 commit）

```
1. feat(web): session 创建未填 label 时自动生成 8位字符_完整时间戳
2. feat(protocol): FetchOutputResult 加 truncated / totalBytes 字段
3. feat(agent): storage + routes 支持 ?tail=N 倒序读末尾 N 字节
4. feat(web): PTY 模式默认 tail=64KB + UI 截断提示 + 加载完整历史按钮
```

PR target = main；标题：`feat: session 默认命名 + PTY 大输出 tail 快速进入`。