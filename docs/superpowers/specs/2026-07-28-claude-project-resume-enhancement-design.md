# Claude Project Resume Enhancement — Design Spec

## Context

tired-agent 管理远程 agent 上的 `claude` 会话。需要完成以下三个关联功能：

1. **创建时 resume** — 选择 `claude` preset/command + cwd 后，扫描 agent 端 `~/.claude/projects/`，列出历史 session 供用户选择 resume
2. **`--name <label>` 自动注入** — 每次创建 claude session 时自动追加 `--name <sessionLabel>`，使 Claude 本地命名与 tired-agent 一致，方便后续恢复
3. **已 exit session 恢复** — 在 session 详情页和列表页，对已 exit 的 claude session（有 `claudeSessionId`）提供「恢复」按钮，一键创建新 session 用 `--resume <claudeSessionId> --name <newLabel>` 接续

## Requirements

1. 选择「Claude」preset 或 `claude` 命令时触发增强功能
2. 用户选定工作目录（cwd）后，Flutter 端将原始路径传给后端
3. 后端在 agent 端编码路径、扫描 `~/.claude/projects/`、列出 session 信息，Flutter 端不感知编码规则
4. 按 `目录 → session[]` 结构返回，**不读 .jsonl 文件内容**，仅依赖文件名 + `stat`
5. 创建 claude session 时自动注入 `--name <sessionLabel>`
6. 已 exit 的 claude session 可见 `claudeSessionId`，UI 提供「恢复」按钮
7. 增强框架必须通用可扩展

## Backend Changes (tired-agent)

### 1. Protocol 类型 (`packages/protocol/src/types.ts`)

```typescript
/** One claude session entry from stat + filename. */
export interface ClaudeProjectSession {
  /** UUID from .jsonl filename (sans extension). */
  sessionId: string;
  /** File mtime epoch ms. */
  lastModified: number;
  /** File size in bytes. */
  size: number;
}

/** A claude project dir with its sessions. */
export interface ClaudeProjectInfo {
  /** Decoded human-readable directory path. */
  displayPath: string;
  /** Sessions sorted by lastModified DESC. */
  sessions: ClaudeProjectSession[];
}
```

不暴露 `projectName`（编码名），Flutter 端只看 `displayPath`。

### 2. 已有类型补充：`claudeSessionId` 暴露到 wire

当前 `Session` 类型（`@tired-agent/protocol`）缺少 `claudeSessionId` 字段，需要补上：

```typescript
// 在 Session interface 中追加 (两个语言同步)
claudeSessionId?: string | null;
```

后端内部 `SessionRecord` 已有此字段，Fastify 直接 JSON 序列化时如果 TS 层面没有类型会丢失。加上后 wire 和 Flutter 端都能收到。

### 3. 路径编码/解码工具

新增 `packages/agent/src/directory/claude-path.ts`：

```typescript
/**
 * Claude Code 的项目目录名编码规则。
 *
 * Windows 范例:
 *   "C:\\wspec\\tired_agent_app" → "C--wspec--tired_agent_app"
 *   （去掉驱动器冒号，反斜杠 → --）
 *
 * POSIX 范例:
 *   "/home/dev/my-project" → "home-dev-my-project"
 *   （去掉前导 /，斜杠 → -）
 */
export function encodeClaudeProjectPath(path: string): string;
export function decodeClaudeProjectPath(encoded: string): string;
```

**编码规则详细：**

| 环境 | 原始路径 | 处理后 |
|------|---------|--------|
| Windows | `C:\wspec\tired_agent_app` | `C--wspec--tired_agent_app` |
| Windows | `C:\Users\cuiwei` | `C--Users-cuiwei` |
| POSIX | `/home/dev/project` | `home-dev-project` |
| POSIX | `/` | `''` (空字符串，特殊处理) |

### 4. DirectoryService 新增方法

`packages/agent/src/directory/types.ts` — `DirectoryService` 接口增加：

```typescript
export interface DirectoryService {
  list(path?: string): Promise<DirectoryListing>;
  validateDirectory(path: string): Promise<void>;
  
  /** NEW: Scan claude project sessions for a given working directory. */
  getClaudeProjects(cwd: string): Promise<ClaudeProjectInfo>;
}
```

`packages/agent/src/directory/service.ts` — 实现：

```typescript
async function getClaudeProjects(cwd: string): Promise<ClaudeProjectInfo> {
  const home = homedir();
  const encoded = encodeClaudeProjectPath(cwd);
  const projectDir = join(home, '.claude', 'projects', encoded);

  let entries: Dirent[];
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { displayPath: cwd, sessions: [] };
    }
    throw err;
  }

  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'));

  const sessions: ClaudeProjectSession[] = [];
  for (const f of jsonlFiles) {
    const sessionId = f.name.slice(0, -'.jsonl'.length);
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) continue;
    try {
      const stats = await stat(join(projectDir, f.name));
      sessions.push({
        sessionId,
        lastModified: stats.mtimeMs,
        size: stats.size,
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);
  return { displayPath: cwd, sessions };
}
```

关键点：
- **不读文件内容**，只用 `stat` 拿 mtime + size
- UUID 格式校验防止非 session 文件混入
- 目录不存在返回空列表而不是 404
- 按时间倒序排列

### 5. 新路由文件

`packages/agent/src/routes/claude-projects.ts`：

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DirectoryService } from '../directory/types.js';
import { log } from '../util/log.js';

const QuerySchema = z.object({
  path: z.string().min(1, 'path is required'),
});

export function registerClaudeProjectsRoutes(
  app: FastifyInstance,
  service: DirectoryService,
): void {
  app.get<{ Querystring: { path?: string } }>(
    '/directories/claude-projects',
    async (req, reply) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: parsed.error.message },
        });
      }
      try {
        const result = await service.getClaudeProjects(parsed.data.path);
        return reply.code(200).send(result);
      } catch (err) {
        log.error({ err }, 'GET /directories/claude-projects failed');
        return reply.code(500).send({
          error: { code: 'DIRECTORY_READ_ERROR', message: (err as Error).message },
        });
      }
    },
  );
}
```

### 6. App 端注册

`packages/agent/src/app.ts` — 新增 import 和注册：

```typescript
import { registerClaudeProjectsRoutes } from './routes/claude-projects.js';
registerClaudeProjectsRoutes(scoped, directoryService);
```

位置在 `registerDirectoryRoutes` 后面即可。

### 7. Manager 端代理

`packages/manager/src/routes/proxy.ts` — 新增注册（必须在 `/agents/:aid/directories` 之前）：

```typescript
app.get<{ Params: { aid: string }; Querystring: { path?: string } }>(
  '/agents/:aid/directories/claude-projects',
  async (req, reply) => {
    const qs = req.query.path ? `?path=${encodeURIComponent(req.query.path)}` : '';
    return proxyJson(
      storage, req.params.aid, 'GET',
      `/api/v1/directories/claude-projects${qs}`,
      undefined, reply,
    );
  },
);
```

放在现有 `/shortcuts` 路由（第 285 行）附近。

## Flutter Changes (tired_agent_app)

### A. 基础改动：claudeSessionId 补全

**`lib/protocol/types.dart`** — `Session` 类追加：

```dart
class Session {
  // ... 现有字段
  final String? claudeSessionId;   // NEW

  const Session({
    // ... 现有参数
    this.claudeSessionId,          // NEW
  });

  factory Session.fromJson(Map<String, dynamic> json) {
    return Session(
      // ... 现有字段
      claudeSessionId: json['claudeSessionId'] as String?,  // NEW
    );
  }
}
```

### B. `--name <label>` 自动注入（功能 2）

**实现位置：** `ClaudeProjectsEnhancement.modifySpec()` 中。

不论是否选择了 resume session，只要命令是 claude：
```dart
Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx) async {
  final List<String> extraArgs = [];
  
  // 总是注入 --name <label>
  if (spec.label != null && spec.label!.isNotEmpty) {
    extraArgs.addAll(['--name', spec.label!]);
  }
  
  // 如果用户选了 resume session
  if (ctx.selectedSessionId != null) {
    extraArgs.addAll(['--resume', ctx.selectedSessionId!]);
  }
  
  if (extraArgs.isEmpty) return spec;
  return SessionSpec(
    cmd: spec.cmd,
    args: [...?spec.args, ...extraArgs],
    cwd: spec.cwd,
    env: spec.env,
    cols: spec.cols,
    rows: spec.rows,
    label: spec.label,
    mode: spec.mode,
    executionMode: spec.executionMode,
  );
}
```

### C. Enhancement 框架（新模块 `lib/enhancements/`）

```
lib/enhancements/
├── enhancement.dart
├── enhancement_context.dart
├── types.dart
└── claude_projects/
    ├── claude_projects_enhancement.dart
    ├── claude_projects_picker.dart
    └── claude_projects_types.dart
```

**`types.dart` — 激活条件和增强点：**

```dart
enum EnhancementPoint {
  directorySelected,   // 目录选择后展示
  beforeSubmit,        // 提交前修改 spec
}

class EnhancementActivation {
  final List<String> presetIds;
  final Pattern? commandPattern;
  
  const EnhancementActivation({
    this.presetIds = const [],
    this.commandPattern,
  });
  
  bool matches(String cmd, BuiltinPreset? preset) {
    if (preset != null && presetIds.contains(preset.id)) return true;
    if (commandPattern != null && commandPattern.hasMatch(cmd)) return true;
    return false;
  }
}
```

**`enhancement.dart` — 抽象基类 + 注册中心：**

```dart
abstract class SessionEnhancement {
  String get id;
  EnhancementActivation get activation;
  EnhancementPoint get point;
  
  Widget buildWidget(BuildContext context, EnhancementContext ctx);
  Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx);
}

class EnhancementRegistry {
  static final List<SessionEnhancement> _items = [];
  static void register(SessionEnhancement e) => _items.add(e);
  
  static List<SessionEnhancement> forPoint(
    EnhancementPoint point, String cmd, BuiltinPreset? preset,
  ) => _items.where((e) =>
    e.point == point && e.activation.matches(cmd, preset)
  ).toList();
}
```

**`enhancement_context.dart`：**

```dart
class EnhancementContext {
  String? cwd;
  String? selectedSessionId;
  String? profileId;        // 从页面传入
  String? agentId;          // 从页面传入
  VoidCallback? onStateChanged;
}
```

### D. Claude Projects Enhancement（功能 1 创建页）

`lib/enhancements/claude_projects/claude_projects_enhancement.dart`：

```dart
class ClaudeProjectsEnhancement extends SessionEnhancement {
  @override
  String get id => 'claude-projects';
  @override
  EnhancementActivation get activation => EnhancementActivation(
    presetIds: ['claude'],
    commandPattern: RegExp(r'^claude( |$)'),
  );
  @override
  EnhancementPoint get point => EnhancementPoint.directorySelected;
  
  @override
  Widget buildWidget(BuildContext context, EnhancementContext ctx) {
    if (ctx.cwd == null || ctx.cwd!.isEmpty) return const SizedBox.shrink();
    return ClaudeProjectsPicker(
      cwd: ctx.cwd!,
      profileId: ctx.profileId!,
      agentId: ctx.agentId!,
      onSelected: (sessionId) {
        ctx.selectedSessionId = sessionId;
        ctx.onStateChanged?.call();
      },
    );
  }
  
  @override
  Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx) async {
    final List<String> extraArgs = [];
    // --name 总是注入
    if (spec.label != null && spec.label!.isNotEmpty) {
      extraArgs.addAll(['--name', spec.label!]);
    }
    // --resume 仅当用户选了 session
    if (ctx.selectedSessionId != null) {
      extraArgs.addAll(['--resume', ctx.selectedSessionId!]);
    }
    if (extraArgs.isEmpty) return spec;
    return SessionSpec(
      cmd: spec.cmd,
      args: [...?spec.args, ...extraArgs],
      cwd: spec.cwd,
      env: spec.env,
      cols: spec.cols,
      rows: spec.rows,
      label: spec.label,
      mode: spec.mode,
      executionMode: spec.executionMode,
    );
  }
}
```

### E. Claude Projects Picker UI（创建页组件）

`lib/enhancements/claude_projects/claude_projects_picker.dart`：

嵌入在目录选择器下方的可折叠面板：
- 标题「Claude 项目」+ session 数量
- 展开后按时间倒序排列
- 每行：相对时间 + 文件大小
- 点击选中 → 预览区 args 更新
- 点击同一条取消选中

### F. 集成到 CreateSessionScreen

```dart
// 新增状态
final EnhancementContext _enhancementCtx = EnhancementContext();
List<SessionEnhancement> _activeEnhancements = [];

void _updateEnhancements() {
  _activeEnhancements = EnhancementRegistry.forPoint(
    EnhancementPoint.directorySelected, _cmd, _selectedPreset,
  );
}

// 目录选择后回调
void _onDirectoryPicked(String path) {
  _cwdController.text = path;
  _enhancementCtx.cwd = path;
  _updateEnhancements();
  setState(() {});
}

// build 中目录选择器下方插入:
if (_activeEnhancements.any((e) => e.point == EnhancementPoint.directorySelected)) {
  for (final e in _activeEnhancements) {
    e.buildWidget(context, _enhancementCtx);
  }
}

// _submit 中:
for (final e in EnhancementRegistry.forPoint(EnhancementPoint.beforeSubmit, _cmd, _selectedPreset)) {
  spec = await e.modifySpec(spec, _enhancementCtx);
}
```

### G. 已 exit session 恢复按钮（功能 3）

涉及两个文件：

**`lib/widgets/session_card.dart`** — SessionCard 增加 resume 按钮：

```dart
// 在模式 badge 右侧按钮区（现有 kill/delete 旁边）追加：
if (session.mode == SessionMode.persistent &&
    session.status == SessionStatus.exited &&
    session.claudeSessionId != null)
  _ActionButton(
    icon: '▶',
    label: AppStrings.of.sessionResumeBtn,
    color: c.success,
    onTap: onResume!,
  ),
```

`SessionCard` 新增 `onResume` 回调。

**`lib/screens/session_detail_screen.dart`** — 详情页 AppBar 追加 resume 按钮：

```dart
// 在现有 kill/delete 判断后追加（line 264–275 附近）：
if (isPersistent &&
    sessionStatus == SessionStatus.exited &&
    _session!.claudeSessionId != null)
  IconButton(
    icon: Icon(Icons.replay, color: c.success),
    tooltip: AppStrings.of.sessionResumeTooltip,
    onPressed: _requestResume,
  ),
```

`_requestResume` 方法：

```dart
Future<void> _requestResume() async {
  // 生成新 label
  final newLabel = _session!.label != null
      ? '${_session!.label}-r'
      : _generateDefaultLabel();
  
  final spec = SessionSpec(
    cmd: 'claude',
    args: ['--name', newLabel, '--resume', _session!.claudeSessionId!],
    cwd: _session!.cwd,
    cols: _session!.cols,
    rows: _session!.rows,
    label: newLabel,
    mode: SessionMode.persistent,
  );
  
  try {
    final newSession = await _conn!.transport.createSession(
      _mgrRef(), spec, agentId: widget.agentId,
    );
    if (mounted) {
      context.replace('/session/${widget.profileId}/${widget.agentId}/${newSession.id}');
    }
  } catch (e) {
    // show error snackbar
  }
}
```

**`lib/screens/server_sessions_screen.dart`** — 列表页 resume 回调连接：

在构建 `SessionCard` 时传入 `onResume`：
```dart
SessionCard(
  session: session,
  onTap: () => context.push('/session/$profileId/$agentId/${session.id}'),
  onKill: session.status != SessionStatus.exited ? () => _requestKill(session) : null,
  onDelete: session.status == SessionStatus.exited ? () => _requestDelete(session) : null,
  onResume: (session.mode == SessionMode.persistent && 
             session.status == SessionStatus.exited && 
             session.claudeSessionId != null)
      ? () => _requestResume(session) : null,
  // ...
)
```

`_requestResume` 方法同详情页逻辑。

### H. 国际化

`lib/utils/app_strings.dart` 新增 keys：

| Key | 中文 |
|-----|------|
| `claudeProjectsTitle` | "Claude 项目" |
| `claudeProjectsSessions` | "{n} 个会话" |
| `claudeProjectsNoSessions` | "暂无历史会话" |
| `claudeProjectsSelectToResume` | "选择会话继续" |
| `sessionResumeBtn` | "恢复" |
| `sessionResumeTooltip` | "恢复此会话" |

## 完整数据流

### 创建页面 resume 流程
```
用户: 选 Claude preset
  → EnhancementRegistry.forPoint(directorySelected, 'claude', claudePreset)
  → ClaudeProjectsEnhancement 激活

用户: 选 cwd
  → _enhancementCtx.cwd = '/home/dev/project-a'
  → ClaudeProjectsPicker 出现 → 加载 session 列表
  → 选中 session → _enhancementCtx.selectedSessionId = '<uuid>'

用户: Launch
  → ClaudeProjectsEnhancement.modifySpec(spec, ctx)
  → args = ['--name', 'project-a-20260728', '--resume', '<uuid>']
  → transport.createSession(spec)
```

### 已 exit session 恢复流程
```
用户: 在 session 列表/详情页看到已 exit 的 claude session
  → 检测: mode==persistent && status==exited && claudeSessionId!=null
  → 显示「恢复」按钮

用户: 点击「恢复」
  → 生成新 label（旧 label + "-r"）
  → 创建 SessionSpec:
      cmd: 'claude'
      args: ['--name', 'oldLabel-r', '--resume', '<claudeSessionId>']
      mode: SessionMode.persistent
  → transport.createSession(spec)
  → 跳转到新 session 详情页
```

## 扩展性示例

```dart
// 在 main.dart 或初始化点注册
EnhancementRegistry.register(ClaudeProjectsEnhancement());

// 后续轻松追加：
EnhancementRegistry.register(GitBranchEnhancement());
EnhancementRegistry.register(VenvDetectEnhancement());
```

## Verification

### 后端测试 (agent):
- 编码/解码函数测试（Windows + POSIX）
- 模拟 `~/.claude/projects/` 目录验证 session 列表
- 大 .jsonl 只 stat 不读内容
- 空目录、无 .jsonl、目录不存在等边缘情况

### Flutter 测试:
- EnhancementActivation.matches （preset id、命令正则）
- EnhancementRegistry 注册/查询
- modifySpec 注入 --name 和 --resume
- 空 cwd 时不触发增强
- Session.fromJson 解析 claudeSessionId
- 会话卡片和详情页 resume 按钮可见性条件

### 集成验证:
1. 创建 Claude session，验证 args 包含 `--name <label>`
2. 已有 claude session，支持在创建页选择 resume
3. Exit 后的 claude session 显示恢复按钮，点击后创建新 session 接续
