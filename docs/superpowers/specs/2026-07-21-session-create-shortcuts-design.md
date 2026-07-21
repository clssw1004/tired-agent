# Session 创建快捷选项与远程目录选择设计

- 日期：2026-07-21
- 分支：`feat/session-create-shortcuts-20260721`
- 状态：已确认设计，进入实现

## 1. 背景与目标

当前 `SessionCreatePage` 已经提供 Claude、Bash、Zsh、cmd.exe、PowerShell、Python、Node 等命令预设，但参数仍主要依赖用户手写，启动目录也没有图形化选择入口。

本次功能的目标：

1. 创建 session 时提供少量稳定、常用的命令和参数预设；
2. 提供可复用的远程 Agent 目录选择弹窗；
3. 从 Agent 运行用户的 home 目录开始浏览，并支持进入任意可访问目录；
4. 支持目录快速返回上一级；
5. 支持收藏目录和最近使用目录，数据保存于 Agent data 目录；
6. 保持现有 `SessionSpec.cwd` 和 session 创建链路兼容，Manager 只负责代理；
7. 目录选择器只做导航和选择，不尝试替代终端的文件系统能力。

## 2. 非目标

本次不做以下内容：

- 不实现文件内容读取、下载、上传或删除；
- 不增加人为的文件系统根目录限制；
- 不新增用户自定义命令预设管理系统；
- 不把目录收藏同步到 Manager 数据库；
- 不修改 session 的 wire-level `cwd` 字段语义；
- 不改变现有 cmd、PowerShell 等终端的权限模型；
- 不因为目录浏览器存在就声称 Agent 文件系统被隔离。

Agent 已经支持直接启动 cmd.exe、PowerShell 等终端，目录浏览器仅提供便捷入口，不是安全沙箱。

## 3. 已确认的产品决策

### 3.1 命令预设

第一版使用前端内置的固定预设，不支持用户自定义命令模板。现有命令预设继续保留，并将参数改为结构化数组，避免预设内部再经过空格拆分。

保留的基础命令：

| 命令 | 默认参数 | 生命周期模式 |
| --- | --- | --- |
| Claude | 无额外参数 | persistent |
| Bash | 无额外参数 | process |
| Zsh | 无额外参数 | process |
| cmd.exe | 无额外参数 | process |
| PowerShell | 无额外参数 | process |
| Python | `-i` | process |
| Node | 无额外参数 | process |

命令选项区域提供少量稳定参数，不追求覆盖每个 CLI：

| 命令 | 常用参数选项 |
| --- | --- |
| Bash | Interactive `-i`、Login `-l` |
| Zsh | Interactive `-i`、Login `-l` |
| cmd.exe | Disable AutoRun `/d` |
| PowerShell | No logo `-NoLogo`、No profile `-NoProfile` |
| Python | Interactive `-i` |
| Node | Interactive `-i` |
| Claude | 暂不添加版本敏感的额外参数 |

参数选项以 toggle/chip 形式呈现。用户仍然可以在高级参数输入框中手动编辑参数；现有的空格分隔解析规则保持不变，不在本次范围内引入完整 shell quoting 解析器。

选择 Claude 时继续自动切换到 persistent 模式；切换到其他命令时继续自动回到 process 模式。

### 3.2 目录选择

目录选择为远程 Agent 文件系统选择，而不是浏览器本机目录选择。

- 首次打开目录浏览器时，以 Agent 运行用户的 home 目录为起点；
- 如果 session 表单已有 `cwd`，再次打开时从当前 `cwd` 开始；
- 允许进入任意可访问路径，不强制限制在 home 目录内；
- 目录列表只返回子目录，不返回文件内容；
- 弹窗提供明确的“上一级”按钮；
- 在文件系统根目录时，“上一级”按钮禁用；
- 当前目录可以直接选择并回填 session 表单；
- 浏览成功的目录可以收藏；
- 成功创建 session 后，Agent 自动记录该 `cwd` 到最近目录。

### 3.3 目录记忆归属

收藏目录和最近目录保存在 Agent 自身的 data 目录中，而不是浏览器 localStorage 或 Manager 数据库。因此：

- 换浏览器、换设备后仍能看到；
- 数据跟随具体 Agent；
- 同一个 Agent 的多个 Manager 使用者看到同一份目录快捷数据；
- 路径不会因为 Manager 重启而丢失。

## 4. 系统架构

### 4.1 组件关系

```text
SessionCreatePage
  ├── CommandPresetSelector（内置命令与参数选项）
  └── DirectoryPickerModal
        └── Transport
              └── Manager /v1/agents/:aid/directories
                    └── Agent /v1/directories
                          ├── DirectoryService（目录读取与路径处理）
                          └── DirectoryStore（Agent data 持久化）
```

已有 session 创建链路保持不变：

```text
SessionCreatePage
  → Transport.createSession({ cmd, args, cwd, ... })
  → Manager proxy
  → Agent sessions route
  → SessionManager.create
  → node-pty.spawn(..., { cwd })
```

### 4.2 Agent 模块

新增目录模块：

```text
packages/agent/src/directory/
  types.ts
  store.ts
  service.ts
```

职责：

- `types.ts`：Agent 内部目录数据类型；
- `store.ts`：读取、更新、原子写入 `directories.json`；
- `service.ts`：处理 home 起点、目录读取、父目录计算、错误映射和收藏校验。

新增路由模块：

```text
packages/agent/src/routes/directories.ts
```

`createApp` 创建 `DirectoryStore` 和 `DirectoryService` 后注册该路由。Agent 的 auth middleware 覆盖所有目录接口，`/health` 仍是唯一不需要认证的健康检查接口。

### 4.3 Manager 模块

Manager 增加对应的代理路由：

```text
GET    /v1/agents/:aid/directories
GET    /v1/agents/:aid/directories/shortcuts
POST   /v1/agents/:aid/directories/favorites
DELETE /v1/agents/:aid/directories/favorites/:id
```

Manager 不解析目录路径，也不保存目录数据。目录 query 参数使用 URL 编码后原样转发给 Agent。

### 4.4 Protocol 与 Transport

在 `@tired-agent/protocol` 增加共享类型：

```ts
export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
}

export interface DirectoryFavorite {
  id: string;
  name: string;
  path: string;
}

export interface RecentDirectory {
  path: string;
  lastUsedAt: number;
}

export interface DirectoryShortcuts {
  favorites: DirectoryFavorite[];
  recent: RecentDirectory[];
}
```

`Transport` 增加：

```ts
listDirectories(ref, path?, agentId?): Promise<DirectoryListing>;
getDirectoryShortcuts(ref, agentId?): Promise<DirectoryShortcuts>;
addDirectoryFavorite(ref, favorite, agentId?): Promise<DirectoryFavorite>;
removeDirectoryFavorite(ref, id, agentId?): Promise<void>;
```

Web 组件只依赖 `Transport`，不直接使用 `fetch` 或依赖 Manager URL 结构。

## 5. Agent API 设计

### 5.1 浏览目录

```text
GET /v1/directories
GET /v1/directories?path=<absolute-path>
```

省略 `path` 时使用 `os.homedir()`。

成功响应：

```json
{
  "path": "C:\\Users\\name\\workspace",
  "parent": "C:\\Users\\name",
  "entries": [
    {
      "name": "packages",
      "path": "C:\\Users\\name\\workspace\\packages"
    },
    {
      "name": "docs",
      "path": "C:\\Users\\name\\workspace\\docs"
    }
  ]
}
```

处理规则：

- 输入路径按 Agent 当前操作系统的 `path` 模块解析；
- 返回绝对、规范化后的路径；
- `entries` 只包含目录；
- 目录按名称排序，使用稳定的大小写不敏感排序；
- 能读取但没有子目录时返回空数组；
- 当前路径等于自身父路径时返回 `parent: null`；
- 不把 `..` 当作目录项，返回的 `parent` 由 API 单独提供；
- 允许绝对路径跳转到 home 之外的目录；
- 不返回文件名、文件大小或文件内容。

错误响应沿用现有格式：

```json
{
  "error": {
    "code": "DIRECTORY_NOT_FOUND",
    "message": "Directory does not exist"
  }
}
```

错误码：

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `INVALID_PATH` | path 为空、格式无效或不是绝对路径 |
| 404 | `DIRECTORY_NOT_FOUND` | 路径不存在 |
| 403 | `DIRECTORY_ACCESS_DENIED` | 无权限读取 |
| 400 | `NOT_A_DIRECTORY` | 路径存在但不是目录 |
| 500 | `DIRECTORY_READ_ERROR` | 其他文件系统错误 |

### 5.2 获取快捷目录

```text
GET /v1/directories/shortcuts
```

响应：

```json
{
  "favorites": [
    {
      "id": "uuid",
      "name": "工作项目",
      "path": "C:\\workspace"
    }
  ],
  "recent": [
    {
      "path": "C:\\workspace\\tired-agent",
      "lastUsedAt": 1720000000000
    }
  ]
}
```

快捷数据即使指向的目录后来被删除也可以返回，由前端在选择或浏览时显示失效状态。

### 5.3 收藏目录

```text
POST /v1/directories/favorites
Content-Type: application/json

{
  "path": "C:\\workspace",
  "name": "工作项目"
}
```

`name` 省略时使用路径 basename；同一路径再次收藏时更新名称，不创建重复项。

删除：

```text
DELETE /v1/directories/favorites/:id
```

只有当前目录实际存在且为可访问目录时才允许新增收藏。删除收藏不影响 session 和最近目录。

## 6. Agent data 持久化

文件路径：

```text
<cfg.dataDir>/directories.json
```

文件结构：

```json
{
  "favorites": [
    {
      "id": "uuid",
      "name": "工作项目",
      "path": "C:\\workspace"
    }
  ],
  "recent": [
    {
      "path": "C:\\workspace\\tired-agent",
      "lastUsedAt": 1720000000000
    }
  ]
}
```

实现要求：

- 文件不存在时返回空集合，不阻止 Agent 启动；
- 写入前确保 data 目录存在；
- 使用临时文件写入后 rename，避免进程中断产生半个 JSON 文件；
- 同一进程内串行化写操作，避免收藏和最近目录更新互相覆盖；
- Windows 上路径 key 大小写不敏感，Unix 上保持大小写敏感；
- 最近目录最多 10 条，按 `lastUsedAt` 倒序；
- 收藏目录按创建顺序保存，重复路径只保留一项；
- 文件损坏时记录 warning 并使用空集合启动，下一次成功写入时恢复合法格式。

## 7. 最近目录记录时机

最近目录只能在 session 创建成功后记录。

```text
用户在 Web 选择 cwd
  → POST /v1/agents/:aid/sessions
  → Agent 解析并创建 session
  → manager.create 成功返回 Session
  → DirectoryStore.recordRecent(session.cwd)
  → 返回 201
```

目录记录失败不应让已经创建成功的 session 返回失败；只记录 warning。

对于 persistent session，`cwd` 在创建阶段也会被记录，因为 session 已经成功创建，即使 Claude PTY 会在后续消息时才启动。

手动输入无效 cwd 时，仍由 Agent session 创建流程报错；该路径不会进入最近目录。

## 8. Web 交互设计

### 8.1 SessionCreatePage

新增状态：

```ts
const [cwd, setCwd] = useState('');
const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
```

Options 区域新增：

- 当前启动目录输入框，允许手动输入；
- “选择目录”按钮；
- 已有路径时显示路径并允许清空；
- 目录路径使用等宽字体并支持换行，防止移动端横向溢出。

创建请求增加：

```ts
cwd: cwd.trim() || undefined
```

### 8.2 DirectoryPickerModal

新增组件：

```text
packages/web/src/components/DirectoryPickerModal.tsx
```

组件行为：

1. 打开时并行加载快捷目录和当前路径；
2. 有当前 `cwd` 时从当前 `cwd` 加载，否则从 Agent home 目录加载；
3. 顶部显示当前路径；
4. 顶部左侧提供“← 上一级”按钮；
5. 在根目录时按钮禁用；
6. 目录项点击后进入下一级；
7. “选择当前目录”按钮将当前路径回传给 SessionCreatePage；
8. 收藏当前目录后立即刷新收藏列表；
9. 最近目录和收藏目录可以直接点击快速选中；
10. 快捷目录失效时显示不可用状态，点击后可进入对应错误提示；
11. 加载或导航失败时保留当前路径和错误信息，允许重试或返回；
12. 关闭弹窗不修改表单中的 `cwd`。

弹窗区域：

```text
[目录选择]                         [关闭]

[常用目录]
  工作项目     C:\workspace
  文档         C:\Users\name\docs

[最近目录]
  C:\workspace\tired-agent

[浏览目录]
[← 上一级]  C:\workspace\tired-agent

📁 docs
📁 packages
📁 scripts

[收藏当前目录]       [选择当前目录]
```

移动端使用近似全屏的 modal，保证上一级、目录项和底部操作按钮有足够触控区域。组件不依赖浏览器原生 `showDirectoryPicker`，避免把本机目录误认为远程 Agent 目录。

### 8.3 CommandPresetSelector

可以继续内嵌在 `SessionCreatePage`，不单独引入复杂状态管理。

将现有预设改成结构化定义：

```ts
interface Preset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  hint: string;
  emoji: string;
  options?: ArgumentOption[];
}

interface ArgumentOption {
  id: string;
  label: string;
  args: string[];
  hint: string;
}
```

点击命令预设时：

- 设置 cmd；
- 设置该预设的默认 args；
- 清空当前参数选项的 toggle 状态；
- 清空 label，保持现有行为；
- 按命令切换 lifecycle mode。

点击参数 chip 时只切换该选项对应的参数，不重复添加相同 token。手动参数仍保留在高级输入框中，命令 preview 显示最终 command + args。

## 9. 数据流

### 9.1 打开目录弹窗

```text
SessionCreatePage
  → DirectoryPickerModal.open
  → transport.getDirectoryShortcuts()
  → transport.listDirectories(currentCwd || undefined)
  → Manager proxy
  → Agent directory routes
  → JSON response
  → modal 渲染收藏、最近目录和当前目录
```

### 9.2 浏览下一级和上一级

```text
点击目录项
  → listDirectories(entry.path)
  → 更新 currentPath、parent、entries

点击“上一级”
  → listDirectories(parent)
  → 更新 currentPath、parent、entries
```

不在前端拼接路径，避免 Windows 分隔符、盘符和编码差异。

### 9.3 选择目录

```text
点击“选择当前目录”
  → onSelect(currentPath)
  → SessionCreatePage.setCwd(currentPath)
  → 关闭 modal
```

### 9.4 创建 session

```text
SessionCreatePage
  → SessionSpec { cmd, args, cwd, label, cols, rows, mode }
  → Transport.createSession
  → Agent manager.create
  → node-pty 使用 record.cwd
  → 成功后 DirectoryStore.recordRecent(cwd)
```

## 10. 错误处理

### 目录接口

- `DIRECTORY_NOT_FOUND`：提示“目录不存在”，快捷目录标记为失效；
- `DIRECTORY_ACCESS_DENIED`：提示“无权访问此目录”，保留上一级按钮；
- `NOT_A_DIRECTORY`：提示“路径不是目录”，不允许进入；
- 网络错误：显示重试按钮，不清空当前已经加载的列表；
- Agent 离线：沿用 Transport 的错误文本，并允许关闭弹窗。

### Session 创建

- 未选择目录时不发送 `cwd`，保持当前默认行为；
- 手动输入目录不存在时，显示 Agent 返回的创建错误；
- session 已创建但最近目录写入失败时，创建流程仍显示成功；
- 预设命令不存在时沿用现有 `SPAWN_ERROR` 行为。

## 11. 测试策略

### Protocol

- 类型检查 `DirectoryListing`、`DirectoryShortcuts` 和 Transport 新方法；
- 确认现有 session 类型和 `SessionSpec.cwd` 不回归。

### Agent

新增目录 store/service 测试：

- 文件不存在时返回空快捷数据；
- 收藏目录新增、重复更新、删除；
- 最近目录去重、更新排序和最多 10 条；
- 原子写入失败不会覆盖旧文件；
- 默认路径使用 home 目录；
- 目录项只返回子目录；
- 根目录返回 `parent: null`；
- 不存在路径、文件路径、无权限路径返回正确错误；
- Windows 路径大小写去重行为。

新增路由测试：

- `GET /v1/directories` 默认 home；
- `GET /v1/directories?path=...` 返回目录；
- shortcuts、favorite add/delete 的状态码和响应结构；
- 未认证请求被拒绝。

Session manager 测试：

- 成功创建带 cwd 的 session 后记录最近目录；
- cwd 无效时不记录最近目录；
- 最近目录写入失败不影响 session 创建结果。

### Manager

- 目录列表 query 参数正确编码和透传；
- favorites 路由正确透传 Agent 状态码和响应；
- Agent 不可达时返回现有 502 结构。

### Web

当前 Web package 没有专用组件测试框架，第一阶段使用：

- `npm run typecheck`；
- `npm run build:protocol` 后 `npm run build:web`；
- 手动验证移动端宽度下的弹窗、上一级按钮和长路径显示；
- 手动验证不同 Agent 之间快捷目录数据不串用。

## 12. 实施顺序

1. 扩展 protocol 目录类型和 Transport 接口；
2. 实现 Agent DirectoryStore；
3. 实现 Agent DirectoryService 与 API routes；
4. 在 Agent app/main 中初始化并注册目录服务；
5. 在 SessionManager 中记录成功创建的最近目录；
6. 添加 Manager 目录代理路由；
7. 实现 HttpSseTransport 目录方法；
8. 实现 `DirectoryPickerModal`；
9. 改造 SessionCreatePage 的 cwd 字段和命令参数 chips；
10. 添加 CSS 与移动端布局；
11. 运行 typecheck、build 和测试，修复回归。

## 13. 验收标准

- 用户无需手写路径即可从 Agent home 目录进入目标目录并选择；
- 目录弹窗有明确可用的“上一级”按钮，根目录时正确禁用；
- 选择目录后，创建请求带上正确的 `cwd`；
- session 确实在所选目录启动；
- 创建成功的目录出现在 Agent 的最近目录中；
- 用户可以收藏和取消收藏目录，重启 Agent 后数据仍在；
- 常用命令和参数可通过点击填充，仍可手动调整；
- Manager 代理模式和直连 Agent 模式行为一致；
- 目录接口不读取文件内容，不新增错误的浏览器本机目录语义；
- `npm run typecheck`、`npm run build` 通过。
