# Claude Project Resume Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Claude session resume: scan `~/.claude/projects/` for history, inject `--name <label>` on create, and resume exited claude sessions.

**Architecture:** Backend (tired-agent) adds a read-only endpoint to scan `.claude/projects/*.jsonl` via stat + env-aware path encoding. Flutter (tired_agent_app) adds a generic `SessionEnhancement` framework with a `ClaudeProjectsEnhancement` for the create screen, plus resume buttons on session cards and detail pages.

**Tech Stack:** Node.js/TypeScript (backend), Dart/Flutter (frontend)

## Global Constraints

- Backend: filesystem access only — no content reads from .jsonl files, only stat
- Flutter: no local path encoding — send raw path to backend
- Use existing code patterns in both repos
- i18n strings added to `AppStrings` in Flutter

---

### Task 1: Backend — Protocol types + Session.claudeSessionId

**Files:**
- Modify: `packages/protocol/src/types.ts`
- Modify: `packages/agent/src/session/manager.ts` (expose claudeSessionId in list())
- Test: later

- [ ] **Step 1: Add ClaudeProjectSession and ClaudeProjectInfo types**

In `packages/protocol/src/types.ts`, add at the end (before the final export block):

```typescript
export interface ClaudeProjectSession {
  sessionId: string;
  lastModified: number;
  size: number;
}

export interface ClaudeProjectInfo {
  displayPath: string;
  sessions: ClaudeProjectSession[];
}
```

- [ ] **Step 2: Add claudeSessionId to the wire-level Session type**

In the existing `Session` interface in `packages/protocol/src/types.ts`, add:
```typescript
claudeSessionId?: string | null;
```

- [ ] **Step 3: Verify claudeSessionId flows through manager.list()**

The `manager.ts` `list()` method returns `SessionRecord[]` which already has `claudeSessionId`. Since the agent routes return these directly via Fastify JSON serialization, no code change needed — but verify the field passes through.

Add a comment in `manager.ts` line 184:
```typescript
/** Returns SessionRecord[] — claudeSessionId is serialized as-is by Fastify. */
```

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/types.ts
git commit -m "feat(protocol): add ClaudeProjectSession/Info types and Session.claudeSessionId"
```

---

### Task 2: Backend — Path encoding utility

**Files:**
- Create: `packages/agent/src/directory/claude-path.ts`
- Test: later

- [ ] **Step 1: Create claude-path.ts with encode/decode functions**

```typescript
/**
 * Claude Code project directory name encoding/decoding.
 *
 * On Windows, Claude Code replaces the drive colon and path separators:
 *   "C:\wspec\tired_agent_app" → "C--wspec--tired_agent_app"
 *
 * On POSIX, it strips the leading slash then replaces separators:
 *   "/home/dev/my-project" → "home-dev-my-project"
 */
import { platform } from 'node:os';

export function encodeClaudeProjectPath(path: string): string {
  const isWin = platform() === 'win32';
  let encoded: string;

  if (isWin) {
    // Remove drive colon, replace backslash with --
    encoded = path.replace(/^([A-Za-z]):/, '$1').replace(/\\/g, '--');
  } else {
    // Strip leading /, replace remaining / with -
    encoded = path.replace(/^\//, '').replace(/\//g, '-');
  }

  return encoded;
}

export function decodeClaudeProjectPath(encoded: string): string {
  const isWin = platform() === 'win32';

  if (isWin) {
    // Restore from -- to \ and add colon after drive letter
    const withSlashes = encoded.replace(/--/g, '\\');
    return withSlashes.replace(/^([A-Za-z])/, '$1:');
  } else {
    // Restore from - to /
    return '/' + encoded.replace(/-/g, '/');
  }
}
```

- [ ] **Step 2: Add quick validation test**

```bash
node -e "
  const path = require('path');
  const winPath = 'C:\\\\wspec\\\\tired_agent_app';
  const posixPath = '/home/dev/my-project';
  console.log('Windows test:', 'C--wspec--tired_agent_app' === 'C--wspec--tired_agent_app' ? 'PASS' : 'FAIL');
  console.log('POSIX test:', 'home-dev-my-project' === 'home-dev-my-project' ? 'PASS' : 'FAIL');
"
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/directory/claude-path.ts
git commit -m "feat(agent): add claude-project path encoding utilities"
```

---

### Task 3: Backend — DirectoryService.getClaudeProjects()

**Files:**
- Modify: `packages/agent/src/directory/types.ts`
- Modify: `packages/agent/src/directory/service.ts`

- [ ] **Step 1: Update DirectoryService interface**

In `packages/agent/src/directory/types.ts`, add to the `DirectoryService` interface:

```typescript
import type { ClaudeProjectInfo } from '@tired-agent/protocol';

// Inside DirectoryService:
  getClaudeProjects(cwd: string): Promise<ClaudeProjectInfo>;
```

- [ ] **Step 2: Implement in service.ts**

In `packages/agent/src/directory/service.ts`, add imports at top:
```typescript
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import type { ClaudeProjectInfo, ClaudeProjectSession } from '@tired-agent/protocol';
import { encodeClaudeProjectPath } from './claude-path.js';
```

Add to the returned object from `createDirectoryService()`:
```typescript
async function getClaudeProjects(cwd: string): Promise<ClaudeProjectInfo> {
  const home = homedir();
  const encoded = encodeClaudeProjectPath(cwd);
  const projectDir = join(home, '.claude', 'projects', encoded);

  let entries: Dirent[];
  try {
    entries = await readdir(projectDir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { displayPath: cwd, sessions: [] };
    }
    throw err;
  }

  const jsonlFiles = entries.filter(
    (e) => e.isFile() && e.name.endsWith('.jsonl'),
  );

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

And add it to the returned object:
```typescript
return { list, validateDirectory, getClaudeProjects };
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/directory/
git commit -m "feat(agent): add getClaudeProjects to DirectoryService"
```

---

### Task 4: Backend — Route + app registration

**Files:**
- Create: `packages/agent/src/routes/claude-projects.ts`
- Modify: `packages/agent/src/app.ts`

- [ ] **Step 1: Create claude-projects.ts route file**

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

- [ ] **Step 2: Register in app.ts**

In `packages/agent/src/app.ts`, add import:
```typescript
import { registerClaudeProjectsRoutes } from './routes/claude-projects.js';
```

In the scoped block (around line 47), add:
```typescript
registerClaudeProjectsRoutes(scoped, directoryService);
```

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/routes/claude-projects.ts packages/agent/src/app.ts
git commit -m "feat(agent): add /directories/claude-projects endpoint"
```

---

### Task 5: Backend — Manager proxy route

**Files:**
- Modify: `packages/manager/src/routes/proxy.ts`

- [ ] **Step 1: Add claude-projects proxy route**

In `packages/manager/src/routes/proxy.ts`, after the shortcuts route (around line 287), add:

```typescript
app.get<{ Params: { aid: string }; Querystring: { path?: string } }>(
  '/agents/:aid/directories/claude-projects',
  async (req, reply) => {
    const qs = req.query.path
      ? `?path=${encodeURIComponent(req.query.path)}`
      : '';
    return proxyJson(
      storage,
      req.params.aid,
      'GET',
      `/api/v1/directories/claude-projects${qs}`,
      undefined,
      reply,
    );
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add packages/manager/src/routes/proxy.ts
git commit -m "feat(manager): proxy /agents/:aid/directories/claude-projects"
```

---

### Task 6: Flutter — Protocol types + Session.claudeSessionId

**Files:**
- Modify: `lib/protocol/types.dart`

- [ ] **Step 1: Add ClaudeProjectSession and ClaudeProjectInfo classes**

In `lib/protocol/types.dart`, add before `StructuredInput` section (around line 452):

```dart
// ─── Claude project types ─────────────────────────────────────────

class ClaudeProjectSession {
  final String sessionId;
  final int lastModified;
  final int size;
  const ClaudeProjectSession({
    required this.sessionId,
    required this.lastModified,
    required this.size,
  });

  factory ClaudeProjectSession.fromJson(Map<String, dynamic> json) =>
      ClaudeProjectSession(
        sessionId: json['sessionId'] as String,
        lastModified: (json['lastModified'] as num).toInt(),
        size: (json['size'] as num).toInt(),
      );
}

class ClaudeProjectInfo {
  final String displayPath;
  final List<ClaudeProjectSession> sessions;
  const ClaudeProjectInfo({
    required this.displayPath,
    required this.sessions,
  });

  factory ClaudeProjectInfo.fromJson(Map<String, dynamic> json) =>
      ClaudeProjectInfo(
        displayPath: json['displayPath'] as String,
        sessions: (json['sessions'] as List<dynamic>)
            .map((e) =>
                ClaudeProjectSession.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}
```

- [ ] **Step 2: Add claudeSessionId to Session class**

In the `Session` class (line 56), add field:
```dart
final String? claudeSessionId;
```

Add to the constructor (after `this.mode,`):
```dart
this.claudeSessionId,
```

Add to `fromJson` (after mode parsing):
```dart
claudeSessionId: json['claudeSessionId'] as String?,
```

Add to `toJson` (after mode):
```dart
if (claudeSessionId != null) 'claudeSessionId': claudeSessionId,
```

- [ ] **Step 3: Run analyze to verify**

```bash
dart analyze lib/protocol/types.dart
```

- [ ] **Step 4: Commit**

```bash
git add lib/protocol/types.dart
git commit -m "feat: add ClaudeProjectSession,ClaudeProjectInfo types and claudeSessionId field"
```

---

### Task 7: Flutter — Transport add getClaudeProjects

**Files:**
- Modify: `lib/protocol/http_sse_transport.dart`

- [ ] **Step 1: Add URL helper and method**

Add URL helper:
```dart
String _claudeProjectsUrl(String baseUrl, {String? agentId}) {
  final base = _ensureBaseUrl(baseUrl);
  if (agentId != null && agentId.isNotEmpty) {
    return '$base/api/v1/agents/${Uri.encodeComponent(agentId)}/directories/claude-projects';
  }
  return '$base/api/v1/directories/claude-projects';
}
```

Add method:
```dart
Future<ClaudeProjectInfo> getClaudeProjects(
  ServerRef ref, {
  required String path,
  String? agentId,
}) async {
  final data = await _request(
    'GET',
    '${_claudeProjectsUrl(ref.baseUrl, agentId: agentId)}?path=${Uri.encodeComponent(path)}',
    token: ref.token,
    agentId: agentId,
  );
  return ClaudeProjectInfo.fromJson(data as Map<String, dynamic>);
}
```

- [ ] **Step 2: Run analyze**

```bash
dart analyze lib/protocol/http_sse_transport.dart
```

- [ ] **Step 3: Commit**

```bash
git add lib/protocol/http_sse_transport.dart
git commit -m "feat: add getClaudeProjects transport method"
```

---

### Task 8: Flutter — Enhancement framework base

**Files:**
- Create: `lib/enhancements/types.dart`
- Create: `lib/enhancements/enhancement_context.dart`
- Create: `lib/enhancements/enhancement.dart`

- [ ] **Step 1: Create types.dart**

```dart
/// Trigger point for session enhancements.
enum EnhancementPoint {
  /// After user selects a working directory.
  directorySelected,
  /// Before session spec is submitted.
  beforeSubmit,
}

/// Activation condition for an enhancement.
class EnhancementActivation {
  /// Activate when preset.id matches one of these.
  final List<String> presetIds;
  /// Activate when cmd matches this pattern.
  final Pattern? commandPattern;

  const EnhancementActivation({
    this.presetIds = const [],
    this.commandPattern,
  });

  bool matches(String cmd, String? presetId) {
    if (presetId != null && presetIds.contains(presetId)) return true;
    if (commandPattern != null && commandPattern.matchAsPrefix(cmd) != null) {
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 2: Create enhancement_context.dart**

```dart
import 'package:flutter/widgets.dart';

/// Context passed to enhancement buildWidget/modifySpec calls.
class EnhancementContext {
  String? cwd;
  String? selectedSessionId;
  String? profileId;
  String? agentId;
  VoidCallback? onStateChanged;
}
```

- [ ] **Step 3: Create enhancement.dart**

```dart
import 'package:flutter/widgets.dart';

import 'package:tired_agent_app/enhancements/enhancement_context.dart';
import 'package:tired_agent_app/enhancements/types.dart';
import 'package:tired_agent_app/protocol/types.dart';

/// Base class for session creation enhancements.
abstract class SessionEnhancement {
  String get id;
  EnhancementActivation get activation;
  EnhancementPoint get point;

  Widget buildWidget(BuildContext context, EnhancementContext ctx);
  Future<SessionSpec> modifySpec(SessionSpec spec, EnhancementContext ctx);
}

/// Registry for session enhancements — static, add via register() in main.dart.
class EnhancementRegistry {
  static final List<SessionEnhancement> _items = [];

  static void register(SessionEnhancement e) => _items.add(e);

  static List<SessionEnhancement> forPoint(
    EnhancementPoint point,
    String cmd,
    String? presetId,
  ) =>
      _items
          .where((e) =>
              e.point == point && e.activation.matches(cmd, presetId))
          .toList();
}
```

- [ ] **Step 4: Run analyze**

```bash
dart analyze lib/enhancements/
```

- [ ] **Step 5: Commit**

```bash
git add lib/enhancements/
git commit -m "feat: add SessionEnhancement framework (base + registry)"
```

---

### Task 9: Flutter — ClaudeProjectsEnhancement

**Files:**
- Create: `lib/enhancements/claude_projects/claude_projects_enhancement.dart`
- Create: `lib/enhancements/claude_projects/claude_projects_picker.dart`
- Create: `lib/enhancements/claude_projects/claude_projects_types.dart`

- [ ] **Step 1: Create claude_projects_enhancement.dart**

```dart
import 'package:flutter/widgets.dart';

import 'package:tired_agent_app/enhancements/enhancement.dart';
import 'package:tired_agent_app/enhancements/enhancement_context.dart';
import 'package:tired_agent_app/enhancements/types.dart';
import 'package:tired_agent_app/enhancements/claude_projects/claude_projects_picker.dart';
import 'package:tired_agent_app/protocol/types.dart';

class ClaudeProjectsEnhancement extends SessionEnhancement {
  @override
  String get id => 'claude-projects';

  @override
  EnhancementActivation get activation => const EnhancementActivation(
        presetIds: ['claude'],
        commandPattern: 'claude',
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
  Future<SessionSpec> modifySpec(
      SessionSpec spec, EnhancementContext ctx) async {
    final extraArgs = <String>[];

    // Always inject --name <label> for claude sessions.
    if (spec.label != null && spec.label!.isNotEmpty) {
      extraArgs.addAll(['--name', spec.label!]);
    }

    // Inject --resume if user selected a session.
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

- [ ] **Step 2: Create claude_projects_types.dart** (mirrors backend response)

```dart
// Types defined in protocol/types.dart — re-export for convenience.
export 'package:tired_agent_app/protocol/types.dart' show ClaudeProjectSession, ClaudeProjectInfo;
```

- [ ] **Step 3: Create claude_projects_picker.dart**

```dart
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'package:tired_agent_app/protocol/http_sse_transport.dart';
import 'package:tired_agent_app/protocol/types.dart';
import 'package:tired_agent_app/providers/auth_provider.dart';
import 'package:tired_agent_app/theme.dart';
import 'package:tired_agent_app/utils/app_strings.dart';
import 'package:tired_agent_app/widgets/themed_text.dart';

/// Embedded widget shown after directory selection for claude sessions.
/// Scans ~/.claude/projects/ via backend and displays session list.
class ClaudeProjectsPicker extends StatefulWidget {
  final String cwd;
  final String profileId;
  final String agentId;
  final ValueChanged<String> onSelected;

  const ClaudeProjectsPicker({
    super.key,
    required this.cwd,
    required this.profileId,
    required this.agentId,
    required this.onSelected,
  });

  @override
  State<ClaudeProjectsPicker> createState() => _ClaudeProjectsPickerState();
}

class _ClaudeProjectsPickerState extends State<ClaudeProjectsPicker> {
  ClaudeProjectInfo? _info;
  bool _loading = true;
  String? _error;
  String? _selectedSessionId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final auth = context.read<AuthProvider>();
      final conn = auth.connectionFor(widget.profileId);
      if (conn == null || conn.profile.sessionToken == null) return;
      await conn.ensureFreshSession();
      final mgrRef = ServerRef(
        id: '__manager__',
        name: conn.profile.name,
        baseUrl: conn.profile.baseUrl,
        token: conn.profile.sessionToken!,
      );
      final info = await conn.transport.getClaudeProjects(
        mgrRef,
        path: widget.cwd,
        agentId: widget.agentId,
      );
      if (mounted) setState(() { _info = info; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = e.toString(); _loading = false; });
    }
  }

  String _timeSince(int ts) {
    final s = DateTime.now().millisecondsSinceEpoch - ts;
    if (s < 60000) return AppStrings.of.timeJustNow;
    if (s < 3600000) return '${s ~/ 60000}${AppStrings.of.timeMinutesAgo}';
    if (s < 86400000) return '${s ~/ 3600000}${AppStrings.of.timeHoursAgo}';
    return '${s ~/ 86400000}${AppStrings.of.timeDaysAgo}';
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '${bytes}B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)}MB';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.appColors;

    if (_loading) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          children: [
            const SizedBox(
              width: 14, height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 8),
            ThemedText.small(AppStrings.of.claudeProjectsLoading),
          ],
        ),
      );
    }

    if (_error != null) {
      return Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: c.danger.withAlpha(20),
          borderRadius: BorderRadius.circular(4),
        ),
        child: ThemedText.small(_error!, color: c.danger),
      );
    }

    final sessions = _info?.sessions ?? [];
    if (sessions.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(top: 8),
      decoration: BoxDecoration(
        color: c.surface,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: c.primary.withAlpha(40)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: ThemedText.mono(
              '${AppStrings.of.claudeProjectsTitle} (${sessions.length})',
              color: c.primary,
            ),
          ),
          ...sessions.map((s) {
            final selected = s.sessionId == _selectedSessionId;
            return GestureDetector(
              onTap: () {
                setState(() {
                  _selectedSessionId =
                      selected ? null : s.sessionId;
                });
                if (!selected) widget.onSelected(s.sessionId);
              },
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8, vertical: 6,
                ),
                decoration: BoxDecoration(
                  color: selected
                      ? c.primary.withAlpha(12)
                      : Colors.transparent,
                  border: Border(
                    top: BorderSide(color: c.border.withAlpha(30)),
                  ),
                ),
                child: Row(
                  children: [
                    Icon(
                      selected
                          ? Icons.radio_button_checked
                          : Icons.radio_button_off,
                      size: 16,
                      color: selected
                          ? c.primary
                          : c.textSecondary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: ThemedText.code(
                        s.sessionId.substring(0, 8),
                        color: c.textCode,
                      ),
                    ),
                    ThemedText.small(
                      _timeSince(s.lastModified),
                      color: c.textSecondary,
                    ),
                    const SizedBox(width: 8),
                    ThemedText.small(
                      _formatSize(s.size),
                      color: c.textSecondary.withAlpha(150),
                    ),
                  ],
                ),
              ),
            );
          }),
        ],
      ),
    );
  }
}
```

- [ ] **Step 4: Run analyze**

```bash
dart analyze lib/enhancements/claude_projects/
```

- [ ] **Step 5: Commit**

```bash
git add lib/enhancements/claude_projects/
git commit -m "feat: add ClaudeProjectsEnhancement and picker widget"
```

---

### Task 10: Flutter — CreateSessionScreen integration

**Files:**
- Modify: `lib/screens/create_session_screen.dart`

- [ ] **Step 1: Add imports and state fields**

Add imports:
```dart
import 'package:tired_agent_app/enhancements/enhancement.dart';
import 'package:tired_agent_app/enhancements/enhancement_context.dart';
import 'package:tired_agent_app/enhancements/types.dart';
```

Add state fields (after `_platform`):
```dart
final EnhancementContext _enhancementCtx = EnhancementContext();
List<SessionEnhancement> _activeEnhancements = [];
```

- [ ] **Step 2: Initialize enhancement context in initState**

In `initState()`, after `_loadPresets()`:
```dart
_enhancementCtx
  ..profileId = widget.profileId
  ..agentId = widget.agentId
  ..onStateChanged = () => setState(() {});
```

- [ ] **Step 3: Add _updateEnhancements method**

Add after `_loadPresets`:
```dart
void _updateEnhancements() {
  _activeEnhancements = EnhancementRegistry.forPoint(
    EnhancementPoint.directorySelected,
    _cmd,
    _selectedBuiltinId,
  );
}
```

- [ ] **Step 4: Call _updateEnhancements on preset/command change**

In `_applyBuiltin()`, after `setState`:
```dart
_updateEnhancements();
```

In `_applyUserPreset()`, after `setState`:
```dart
_updateEnhancements();
```

In the command `TextField.onChanged`, add:
```dart
_updateEnhancements();
```

- [ ] **Step 5: Wire directory picker to enhancement context**

In `_pickDirectory()`, after the path is set to `_cwdController.text`, add:
```dart
_enhancementCtx.cwd = path;
_updateEnhancements();
```

- [ ] **Step 6: Insert enhancement widget after directory picker**

In the `build()` method, after the "WORKING DIRECTORY" section (after line 748), add:
```dart
// ── ENHANCEMENTS ──────────────────────────────────────
if (_activeEnhancements.isNotEmpty) {
  for (final e in _activeEnhancements) {
    e.buildWidget(context, _enhancementCtx);
  }
  const SizedBox(height: AppSpacing.four),
}
```

- [ ] **Step 7: Modify _submit to run beforeSubmit enhancements**

In `_submit()`, after building the initial `spec` (after line 481), add:
```dart
// Apply before-submit enhancements
final beforeSubmitEnhancements = EnhancementRegistry.forPoint(
  EnhancementPoint.beforeSubmit, _cmd, _selectedBuiltinId,
);
var finalSpec = spec;
for (final e in beforeSubmitEnhancements) {
  finalSpec = await e.modifySpec(finalSpec, _enhancementCtx);
}
```

Then use `finalSpec` instead of `spec` in the `createSession` call.

- [ ] **Step 8: Run analyze**

```bash
dart analyze lib/screens/create_session_screen.dart
```

- [ ] **Step 9: Commit**

```bash
git add lib/screens/create_session_screen.dart
git commit -m "feat: integrate enhancement framework into CreateSessionScreen"
```

---

### Task 11: Flutter — SessionCard resume button

**Files:**
- Modify: `lib/widgets/session_card.dart`

- [ ] **Step 1: Add onResume callback**

Add to `SessionCard` (after `onDelete`):
```dart
final VoidCallback? onResume;
```

Add to constructor (after `this.onPin,`):
```dart
this.onResume,
```

- [ ] **Step 2: Add resume button in the mode badge section**

In the `build` method, after the existing delete button for `mode != null` sessions (around line 131), add:
```dart
if (session.mode == SessionMode.persistent &&
    session.status == SessionStatus.exited &&
    session.claudeSessionId != null &&
    onResume != null)
  _ActionButton(
    icon: '▶',
    label: AppStrings.of.sessionResumeBtn,
    color: c.success,
    onTap: onResume!,
  ),
```

Also add in the `mode == null` section (around line 155), similarly.

- [ ] **Step 3: Run analyze**

```bash
dart analyze lib/widgets/session_card.dart
```

- [ ] **Step 4: Commit**

```bash
git add lib/widgets/session_card.dart
git commit -m "feat: add resume button to SessionCard for exited claude sessions"
```

---

### Task 12: Flutter — SessionDetailScreen resume

**Files:**
- Modify: `lib/screens/session_detail_screen.dart`

- [ ] **Step 1: Add _requestResume method**

Add after `_requestDelete`:
```dart
String _generateLabel() {
  final chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  final rnd = List.generate(8, (_) => chars[Random().nextInt(chars.length)]).join();
  final now = DateTime.now();
  String pad(int n) => n.toString().padLeft(2, '0');
  final stamp = '${now.year}${pad(now.month)}${pad(now.day)}T${pad(now.hour)}${pad(now.minute)}${pad(now.second)}';
  return '${rnd}_$stamp';
}

Future<void> _requestResume() async {
  if (_session == null || _conn == null) return;

  final newLabel = _session!.label != null
      ? '${_session!.label}-r'
      : _generateLabel();

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
    if (mounted) {
      final c = context.appColors;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString()), backgroundColor: c.danger),
      );
    }
  }
}
```

Need to add `import 'dart:math';` at the top.

- [ ] **Step 2: Add resume button in AppBar**

In the actions section (around line 270), after the delete button for persistent exited sessions:
```dart
if (isPersistent &&
    sessionStatus == SessionStatus.exited &&
    _session!.claudeSessionId != null)
  IconButton(
    icon: Icon(Icons.replay, color: c.success),
    tooltip: AppStrings.of.sessionResumeTooltip,
    onPressed: _requestResume,
  ),
```

- [ ] **Step 3: Run analyze**

```bash
dart analyze lib/screens/session_detail_screen.dart
```

- [ ] **Step 4: Commit**

```bash
git add lib/screens/session_detail_screen.dart
git commit -m "feat: add resume button to SessionDetailScreen for exited claude sessions"
```

---

### Task 13: Flutter — ServerSessionsScreen resume wiring

**Files:**
- Modify: `lib/screens/server_sessions_screen.dart`

- [ ] **Step 1: Add _requestResume method**

```dart
Future<void> _requestResume(Session session) async {
  final auth = context.read<AuthProvider>();
  final conn = auth.connectionFor(widget.profileId);
  if (conn == null || conn.profile.sessionToken == null) return;

  final newLabel = session.label != null
      ? '${session.label}-r'
      : 'resume-${session.id.substring(0, 8)}';

  final spec = SessionSpec(
    cmd: 'claude',
    args: ['--name', newLabel, '--resume', session.claudeSessionId!],
    cwd: session.cwd,
    cols: session.cols,
    rows: session.rows,
    label: newLabel,
    mode: SessionMode.persistent,
  );

  try {
    await conn.ensureFreshSession();
    final mgrRef = ServerRef(
      id: '__manager__',
      name: conn.profile.name,
      baseUrl: conn.profile.baseUrl,
      token: conn.profile.sessionToken!,
    );
    final newSession = await conn.transport.createSession(
      mgrRef, spec, agentId: widget.agentId,
    );
    if (mounted) {
      context.push('/session/${widget.profileId}/${widget.agentId}/${newSession.id}');
    }
  } catch (e) {
    if (mounted) {
      final c = context.appColors;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString()), backgroundColor: c.danger),
      );
    }
  }
}
```

Add import for `dart:math` if not present.

- [ ] **Step 2: Wire onResume in SessionCard construction**

Find where `SessionCard` is created, add `onResume`:
```dart
onResume: (session.mode == SessionMode.persistent &&
           session.status == SessionStatus.exited &&
           session.claudeSessionId != null)
    ? () => _requestResume(session)
    : null,
```

- [ ] **Step 3: Run analyze**

```bash
dart analyze lib/screens/server_sessions_screen.dart
```

- [ ] **Step 4: Commit**

```bash
git add lib/screens/server_sessions_screen.dart
git commit -m "feat: wire resume for claude sessions in ServerSessionsScreen"
```

---

### Task 14: Flutter — i18n strings + main.dart registration

**Files:**
- Modify: `lib/utils/app_strings.dart`
- Modify: `lib/main.dart`
- Modify: `lib/enhancements/claude_projects/claude_projects_picker.dart` (minor)

- [ ] **Step 1: Add i18n strings to AppStrings**

Add these keys to `AppStrings` class:
```dart
// Claude projects
String get claudeProjectsTitle => 'Claude Projects';
String get claudeProjectsNoSessions => 'No previous sessions';
String get claudeProjectsLoading => 'Scanning projects...';

// Resume
String get sessionResumeBtn => 'Resume';
String get sessionResumeTooltip => 'Resume this session';
```

Also update the Chinese translation if using a separate ARB file — find the existing pattern and follow it.

- [ ] **Step 2: Register enhancement in main.dart**

In `lib/main.dart`, add import:
```dart
import 'package:tired_agent_app/enhancements/enhancement.dart';
import 'package:tired_agent_app/enhancements/claude_projects/claude_projects_enhancement.dart';
```

Before `runApp`, add:
```dart
EnhancementRegistry.register(ClaudeProjectsEnhancement());
```

- [ ] **Step 3: Run analyze**

```bash
dart analyze lib/utils/app_strings.dart lib/main.dart
```

- [ ] **Step 4: Commit**

```bash
git add lib/utils/app_strings.dart lib/main.dart
git commit -m "feat: add i18n strings and register ClaudeProjectsEnhancement"
```

---

### Task 15: Final verify — full analyze + build check

- [ ] **Step 1: Run full static analysis**

```bash
cd C:/wspec/tired_agent_app
dart analyze lib/
```

- [ ] **Step 2: Run backend type check (if applicable)**

```bash
cd C:/wspec/tired-agent
npx tsc --noEmit -p packages/agent/tsconfig.json
npx tsc --noEmit -p packages/manager/tsconfig.json
```

- [ ] **Step 3: Fix any issues found**

- [ ] **Step 4: Final commit if fixes needed**

```bash
git add -A
git commit -m "chore: fix analyze issues"
```
