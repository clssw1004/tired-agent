# Claude Project Resume Enhancement — Design Spec

## Context

tired-agent 管理远程 agent 上的 `claude` 会话。Claude Code 在 agent 机器上运行时会将会话日志写入 `~/.claude/projects/<encoded-path>/<sessionId>.jsonl`。用户希望用 tired-agent 创建 claude session 时，能扫描 agent 端对应目录的 `.claude/projects/`，列出历史会话并选择 resume。

## Requirements

1. 选择「Claude」preset 或 `claude` 命令时触发增强功能
2. 用户选定工作目录（cwd）后，Flutter 端将原始路径传给后端
3. 后端在 agent 端编码路径、扫描 `~/.claude/projects/`、列出 session 信息，Flutter 端不感知编码规则
4. 按 `目录 → session[]` 结构返回，**不读 .jsonl 文件内容**，仅依赖文件名 + `stat`
5. 用户选取一个 session 后，创建会话时自动追加 `--resume <sessionId>` 到 args
6. 增强框架必须通用可扩展，后续其他命令也可通过同样机制添加增强

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

### 2. 路径编码/解码工具

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

### 3. DirectoryService 新增方法

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
      // 目录不存在 → 空列表
      return { displayPath: cwd, sessions: [] };
    }
    throw err;
  }

  const jsonlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.jsonl'));

  const sessions: ClaudeProjectSession[] = [];
  for (const f of jsonlFiles) {
    const sessionId = f.name.slice(0, -'.jsonl'.length);
    // UUID 格式校验 (8-4-4-4-12)
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) continue;

    try {
      const stats = await stat(join(projectDir, f.name));
      sessions.push({
        sessionId,
        lastModified: stats.mtimeMs,
        size: stats.size,
      });
    } catch {
      // 并发删除等情况，跳过
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

### 4. 新路由文件

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

### 5. App 端注册

`packages/agent/src/app.ts` — 新增 import 和注册：

```typescript
import { registerClaudeProjectsRoutes } from './routes/claude-projects.js';

// 在 scoped 注册块中追加:
registerClaudeProjectsRoutes(scoped, directoryService);
```

位置在 `registerDirectoryRoutes` 后面即可，因为路径不冲突。

### 6. Manager 端代理

`packages/manager/src/routes/proxy.ts` — 新增注册（**必须在** `/agents/:aid/directories` 之前，避免路径冲突）：

```typescript
// Claude projects — 必须在 /directories 通配前注册
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

查看现有 proxy 代码（第 285-300 行），`/directories/shortcuts` 在 `/directories` 之前注册。新注册放在 `/shortcuts` 附近即可。

## Flutter Changes (tired_agent_app)

### 1. Enhancement 框架 (新模块 `lib/enhancements/`)

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
/// 增强点 — 决定 widget 在哪个时机注入
enum EnhancementPoint {
  /// 目录选择后展示
  directorySelected,
  /// 提交前修改 spec
  beforeSubmit,
}

/// 增强激活条件
class EnhancementActivation {
  /// 匹配的 preset id 列表（如 ['claude']）
  final List<String> presetIds;
  /// 匹配的命令正则（如 RegExp(r'^claude( |$)')）
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
  
  /// 在增强点触发时构建 UI 片段
  Widget buildWidget(BuildContext context, EnhancementContext ctx);
  
  /// 提交前修改 SessionSpec
  Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx);
}

class EnhancementRegistry {
  static final List<SessionEnhancement> _items = [];
  static void register(SessionEnhancement e) => _items.add(e);
  
  static List<SessionEnhancement> forPoint(EnhancementPoint point, String cmd, BuiltinPreset? preset) =>
    _items.where((e) =>
      e.point == point && e.activation.matches(cmd, preset)
    ).toList();
}
```

**`enhancement_context.dart` — 页面状态上下文：**

```dart
class EnhancementContext {
  String? cwd;
  String? selectedSessionId;
  VoidCallback? onStateChanged;  // 通知页面刷新
}
```

### 2. Protocol 类型 (Dart 侧)

`lib/protocol/types.dart` 新增：

```dart
class ClaudeProjectSession {
  final String sessionId;
  final int lastModified;
  final int size;
  const ClaudeProjectSession({required this.sessionId, required this.lastModified, required this.size});
  
  factory ClaudeProjectSession.fromJson(Map<String, dynamic> json) => ClaudeProjectSession(
    sessionId: json['sessionId'] as String,
    lastModified: (json['lastModified'] as num).toInt(),
    size: (json['size'] as num).toInt(),
  );
}

class ClaudeProjectInfo {
  final String displayPath;
  final List<ClaudeProjectSession> sessions;
  const ClaudeProjectInfo({required this.displayPath, required this.sessions});
  
  factory ClaudeProjectInfo.fromJson(Map<String, dynamic> json) => ClaudeProjectInfo(
    displayPath: json['displayPath'] as String,
    sessions: (json['sessions'] as List<dynamic>)
      .map((e) => ClaudeProjectSession.fromJson(e as Map<String, dynamic>))
      .toList(),
  );
}
```

### 3. Transport 层

`lib/protocol/http_sse_transport.dart` 新增方法：

```dart
Future<ClaudeProjectInfo> getClaudeProjects(
  ServerRef ref, {
  required String path,
  String? agentId,
}) async {
  final data = await _request(
    'GET',
    _claudeProjectsUrl(ref.baseUrl, agentId: agentId) + '?path=${Uri.encodeComponent(path)}',
    token: ref.token,
    agentId: agentId,
  );
  return ClaudeProjectInfo.fromJson(data as Map<String, dynamic>);
}
```

```dart
String _claudeProjectsUrl(String baseUrl, {String? agentId}) {
  final base = _ensureBaseUrl(baseUrl);
  if (agentId != null && agentId.isNotEmpty) {
    return '$base/api/v1/agents/${Uri.encodeComponent(agentId)}/directories/claude-projects';
  }
  return '$base/api/v1/directories/claude-projects';
}
```

### 4. Claude Projects Enhancement 实现

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
      profileId: ctx.profileId,
      agentId: ctx.agentId,
      onSelected: (sessionId) {
        ctx.selectedSessionId = sessionId;
        ctx.onStateChanged?.call();
      },
    );
  }
  
  @override
  Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx) async {
    if (ctx.selectedSessionId == null) return spec;
    final resumeArgs = ['--resume', ctx.selectedSessionId!];
    return SessionSpec(
      cmd: spec.cmd,
      args: [...?spec.args, ...resumeArgs],
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

### 5. Claude Projects Picker UI

`lib/enhancements/claude_projects/claude_projects_picker.dart`：

一个嵌入式的 widget（非 full-screen modal），展示在目录选择器下方：

```dart
class ClaudeProjectsPicker extends StatefulWidget {
  final String cwd;
  final String profileId;
  final String agentId;
  final ValueChanged<String> onSelected;
  // ...
}

// State 逻辑:
// 1. initState: 调用 transport.getClaudeProjects(ref, path: cwd, agentId)
// 2. 加载中: 显示小 loading indicator
// 3. 加载完成:
//    - sessions 为空 → "No previous sessions" (collapsed)
//    - 有 sessions → 展开显示 session 列表
// 4. 每行: 相对时间 + 文件大小
// 5. 选中: 高亮，回调 onSelected
```

**交互设计：**
- 目录选择器下方显示一个折叠面板
- 标题「Claude Projects」+ session 数量
- 展开后按时间倒序列 session
- 点击选中 → 预览区 args 更新为 `--resume <uuid>`
- 点击同一条取消选中 → 回到纯 claude 模式

### 6. 集成到 CreateSessionScreen

`create_session_screen.dart` 改动：

1. 在 `initState` 中初始化 EnhancementContext
2. 在 preset/command 切换时重新计算激活的 enhancement
3. 在目录选择器下方插入 `directorySelected` 点的 widget
4. 在 `_submit()` 中调用 `beforeSubmit` 点的 `modifySpec()`

```dart
// 新增状态
final EnhancementContext _enhancementCtx = EnhancementContext();
List<SessionEnhancement> _activeEnhancements = [];

// preset 或 command 变化时更新
void _updateEnhancements() {
  _activeEnhancements = EnhancementRegistry.forPoint(
    EnhancementPoint.directorySelected, _cmd, _selectedPreset,
  );
}

// 目录选择后的回调
void _onDirectoryPicked(String path) {
  _cwdController.text = path;
  _enhancementCtx.cwd = path;
  _updateEnhancements();
  setState(() {});
}

// build 中目录选择器下方插入:
if (_activeEnhancements.any((e) => e.point == EnhancementPoint.directorySelected)) {
  for (final e in _activeEnhancements.where((e) => e.point == EnhancementPoint.directorySelected)) {
    e.buildWidget(context, _enhancementCtx);
  }
}

// _submit 中:
for (final e in EnhancementRegistry.forPoint(EnhancementPoint.beforeSubmit, _cmd, _selectedPreset)) {
  spec = await e.modifySpec(spec, _enhancementCtx);
}
```

### 7. 国际化

`lib/utils/app_strings.dart` 新增 keys（带中文翻译）：

| Key | 中文 |
|-----|------|
| `claudeProjectsTitle` | "Claude 项目" |
| `claudeProjectsSessions` | "{n} 个会话" |
| `claudeProjectsNoSessions` | "暂无历史会话" |
| `claudeProjectsSelectToResume` | "选择会话继续" |
| `claudeProjectsSessionCount` | "{n} 个 session" |

## 完整数据流

```
用户: 选 Claude preset
  → EnhancementRegistry.forPoint(directorySelected, 'claude', claudePreset)
  → ClaudeProjectsEnhancement 激活

用户: 选 cwd
  → _enhancementCtx.cwd = '/home/dev/project-a'
  → ClaudeProjectsPicker 出现

Picker initState:
  transport.getClaudeProjects(ref, path: '/home/dev/project-a', agentId: 'xxx')
  ─────────────────────────────────────────────────────────►
  Manager: GET /agents/xxx/directories/claude-projects?path=/home/dev/project-a
  ─────────────────────────────────────────────────────────►
  Agent: GET /directories/claude-projects?path=/home/dev/project-a
    → service.getClaudeProjects('/home/dev/project-a')
    → encodeClaudeProjectPath → 'home-dev-project-a'
    → stat ~/.claude/projects/home-dev-project-a/*.jsonl
    → return { displayPath, sessions: [{sessionId, lastModified, size}] }
  ◄─────────────────────────────────────────────────────────
  Manager 透传
  ◄─────────────────────────────────────────────────────────
  → 渲染 session 列表

用户: 选中 session
  → _enhancementCtx.selectedSessionId = '<uuid>'
  → 预览区更新为 "claude --resume <uuid>"

用户: Launch
  → EnhancementRegistry.forPoint(beforeSubmit, ...)
  → ClaudeProjectsEnhancement.modifySpec(spec, ctx)
  → args 注入 ['--resume', '<uuid>']
  → transport.createSession(spec)
```

## 扩展性示例

```dart
// 添加 Git 增强
class GitBranchEnhancement extends SessionEnhancement {
  @override
  String get id => 'git-branch';
  @override
  EnhancementActivation get activation => EnhancementActivation(presetIds: ['git', 'dev']);
  // ...
}

// 在 main.dart 或任何初始化点注册
EnhancementRegistry.register(ClaudeProjectsEnhancement());
EnhancementRegistry.register(GitBranchEnhancement());
```

## Verification

### 后端测试 (agent):
- 编码/解码函数测试（Windows + POSIX）
- 模拟 `~/.claude/projects/` 目录，验证 session 列表正确
- 大 .jsonl 文件验证只调用 stat 不读内容
- 边缘情况：空目录、无 .jsonl、目录不存在

### Flutter 测试:
- EnhancementActivation.matches 测试（preset id、命令正则）
- EnhancementRegistry 注册和查询
- ClaudeProjectsEnhancement.buildWidget 条件性渲染
- modifySpec 注入 --resume
- 空 cwd 时增强不触发

### 集成验证:
1. 在 agent 上已有 claude session 的情况下扫描
2. 返回的 session 按时间倒序排列
3. 选中后 Launch，创建 session 的 args 包含 `--resume <uuid>`
