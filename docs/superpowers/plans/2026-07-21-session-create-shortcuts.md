# Session 创建快捷选项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 session 创建页增加内置命令参数快捷选项、远程 Agent 目录选择弹窗、上一级导航、收藏目录和最近目录记忆，同时保持现有 `SessionSpec.cwd` 创建链路兼容。

**Architecture:** Agent 新增只读目录浏览 API 和基于 Agent data 的目录快捷存储；Manager 仅透传目录请求；Protocol/Transport 提供共享类型和调用方法；Web 新增 `DirectoryPickerModal`，并在 `SessionCreatePage` 中组合目录选择、cwd 回填和内置命令参数 chips。session 创建成功后由 Agent 记录 cwd 到最近目录。

**Tech Stack:** TypeScript、Fastify、Zod、Node `fs/promises`/`path`/`os`、React 18、Vite、现有 `HttpSseTransport`、Node built-in `node:test` + 已有 `tsx`。

## Global Constraints

- 所有特性开发在 `feat/session-create-shortcuts-20260721` 分支完成，不能把代码改回 `main`。
- 必须先运行 `npm run build:protocol`，再运行 `npm run build:web`。
- 目录浏览从 Agent 运行用户的 home 目录开始，但不限制用户继续进入 home 之外的合法目录。
- 目录 API 只返回目录导航信息，不读取或返回文件内容。
- 收藏目录和最近目录必须保存在 Agent 的 `cfg.dataDir/directories.json`，不能只保存在浏览器或 Manager。
- 最近目录只在 session 创建成功后记录，记录失败不能让已创建 session 失败。
- 第一版只提供内置命令/参数预设，不新增用户自定义命令预设管理。
- `SessionSpec.cwd` 已存在，不能改名或改变其含义；未选择目录时继续省略 `cwd`。
- 不引入浏览器原生 `showDirectoryPicker`，目录选择必须针对远程 Agent。
- 现有错误响应格式 `{ error: { code, message } }` 必须继续使用。
- 不把目录浏览 API 当作文件系统安全边界；Agent 已支持 cmd.exe/PowerShell，不能额外添加与产品决定冲突的人工 root 限制。

---

## 文件结构与职责映射

| 文件 | 操作 | 职责 |
| --- | --- | --- |
| `packages/protocol/src/types.ts` | 修改 | 增加目录列表、收藏、最近目录的 wire types |
| `packages/protocol/src/Transport.ts` | 修改 | 增加目录 API 的 Transport 方法 |
| `packages/protocol/src/HttpSseTransport.ts` | 修改 | 实现目录 API URL、鉴权、JSON 请求 |
| `packages/agent/src/directory/types.ts` | 创建 | Agent 目录数据和服务内部类型 |
| `packages/agent/src/directory/store.ts` | 创建 | `directories.json` 的加载、原子写入、收藏和最近目录更新 |
| `packages/agent/src/directory/service.ts` | 创建 | home 起点、目录读取、父目录计算、文件系统错误映射 |
| `packages/agent/src/routes/directories.ts` | 创建 | Agent 目录 HTTP 路由与 Zod 校验 |
| `packages/agent/src/app.ts` | 修改 | 注册目录路由 |
| `packages/agent/src/index.ts` | 修改 | 初始化目录 store/service 并注入 app/SessionManager |
| `packages/agent/src/session/manager.ts` | 修改 | session 创建成功后记录最近 cwd |
| `packages/agent/test/directory.test.ts` | 创建 | DirectoryStore/Service 单元测试 |
| `packages/agent/test/directory-routes.test.ts` | 创建 | 目录路由注入测试 |
| `packages/agent/package.json` | 修改 | 增加 Node test 脚本 |
| `packages/manager/src/routes/proxy.ts` | 修改 | Manager 目录接口透传 |
| `packages/web/src/components/DirectoryPickerModal.tsx` | 创建 | 可复用的远程目录选择弹窗 |
| `packages/web/src/pages/SessionCreatePage.tsx` | 修改 | cwd、目录弹窗、命令参数 chips 和提交字段 |
| `packages/web/src/styles.css` | 修改 | 目录弹窗、目录项、路径、参数 chips 的样式 |
| `docs/superpowers/specs/2026-07-21-session-create-shortcuts-design.md` | 已提交 | 需求、架构、API 和验收标准 |

---

### Task 1: 扩展 Protocol 与 HTTP Transport 契约

**Files:**
- Modify: `packages/protocol/src/types.ts`（在 `SessionSpec`/`Session` 附近增加目录类型）
- Modify: `packages/protocol/src/Transport.ts:11-18,41-126`
- Modify: `packages/protocol/src/HttpSseTransport.ts`（增加目录 URL 与方法）

**Interfaces:**
- Produces `DirectoryEntry`, `DirectoryListing`, `DirectoryFavorite`, `RecentDirectory`, `DirectoryShortcuts`。
- Produces `Transport.listDirectories`, `getDirectoryShortcuts`, `addDirectoryFavorite`, `removeDirectoryFavorite`。
- Later tasks consume these exact types and methods; `packages/protocol/src/index.ts` 已通过 `export *` 自动暴露它们。

- [ ] **Step 1: 添加共享目录响应类型**

在 `packages/protocol/src/types.ts` 的 session 类型后加入：

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

- [ ] **Step 2: 在 Transport 接口声明目录方法**

更新 `packages/protocol/src/Transport.ts` 的 import：

```ts
import type {
  DirectoryFavorite,
  DirectoryListing,
  DirectoryShortcuts,
  FetchOutputResult,
  OutputChunk,
  Session,
  ServerRef,
  SessionSpec,
} from './types.js';
```

在 `createSession` 后增加：

```ts
  listDirectories(
    ref: ServerRef,
    path?: string,
    agentId?: string,
  ): Promise<DirectoryListing>;

  getDirectoryShortcuts(
    ref: ServerRef,
    agentId?: string,
  ): Promise<DirectoryShortcuts>;

  addDirectoryFavorite(
    ref: ServerRef,
    favorite: { path: string; name?: string },
    agentId?: string,
  ): Promise<DirectoryFavorite>;

  removeDirectoryFavorite(
    ref: ServerRef,
    id: string,
    agentId?: string,
  ): Promise<void>;
```

- [ ] **Step 3: 为 HttpSseTransport 增加目录 URL helper**

在 `agentsUrl` 附近增加：

```ts
private directoriesUrl(ref: ServerRef, agentId?: string): string {
  const base = ensureBaseUrl(ref);
  return agentId
    ? `${base}/v1/agents/${encodeURIComponent(agentId)}/directories`
    : `${base}/v1/directories`;
}
```

- [ ] **Step 4: 实现四个 HTTP 方法**

在 `HttpSseTransport` 中加入等价实现：

```ts
async listDirectories(
  ref: ServerRef,
  path?: string,
  agentId?: string,
): Promise<DirectoryListing> {
  const base = this.directoriesUrl(ref, agentId);
  const url = path == null
    ? base
    : `${base}?${new URLSearchParams({ path }).toString()}`;
  const res = await this.fetchImpl(url, { headers: authHeaders(ref) });
  await checkOk(res, 'listDirectories');
  return (await res.json()) as DirectoryListing;
}

async getDirectoryShortcuts(
  ref: ServerRef,
  agentId?: string,
): Promise<DirectoryShortcuts> {
  const res = await this.fetchImpl(
    `${this.directoriesUrl(ref, agentId)}/shortcuts`,
    { headers: authHeaders(ref) },
  );
  await checkOk(res, 'getDirectoryShortcuts');
  return (await res.json()) as DirectoryShortcuts;
}

async addDirectoryFavorite(
  ref: ServerRef,
  favorite: { path: string; name?: string },
  agentId?: string,
): Promise<DirectoryFavorite> {
  const res = await this.fetchImpl(
    `${this.directoriesUrl(ref, agentId)}/favorites`,
    {
      method: 'POST',
      headers: { ...authHeaders(ref), 'Content-Type': 'application/json' },
      body: JSON.stringify(favorite),
    },
  );
  await checkOk(res, 'addDirectoryFavorite');
  return (await res.json()) as DirectoryFavorite;
}

async removeDirectoryFavorite(
  ref: ServerRef,
  id: string,
  agentId?: string,
): Promise<void> {
  const res = await this.fetchImpl(
    `${this.directoriesUrl(ref, agentId)}/favorites/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: authHeaders(ref) },
  );
  await checkOk(res, 'removeDirectoryFavorite');
}
```

保留现有 `fetchImpl`、`authHeaders`、`checkOk` 的调用方式，不新增第三方 HTTP 库。

- [ ] **Step 5: 运行 Protocol 类型检查**

Run:

```bash
npm run typecheck -w @tired-agent/protocol
```

Expected: `tsc` 完成且无错误。

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/types.ts packages/protocol/src/Transport.ts packages/protocol/src/HttpSseTransport.ts
git commit -m "feat(protocol): add directory transport contract"
```

---

### Task 2: 实现 Agent DirectoryStore 与 DirectoryService

**Files:**
- Create: `packages/agent/src/directory/types.ts`
- Create: `packages/agent/src/directory/store.ts`
- Create: `packages/agent/src/directory/service.ts`
- Create: `packages/agent/test/directory.test.ts`
- Modify: `packages/agent/package.json`

**Interfaces:**
- Consumes protocol `DirectoryFavorite`, `DirectoryShortcuts`, `RecentDirectory`。
- Produces `DirectoryStore`、`DirectoryService`，供后续 routes 和 SessionManager 使用。

- [ ] **Step 1: 添加 Agent 内部类型和 Store 接口**

`packages/agent/src/directory/types.ts`：

```ts
import type {
  DirectoryFavorite,
  DirectoryListing,
  DirectoryShortcuts,
  RecentDirectory,
} from '@tired-agent/protocol';

export interface DirectoryData {
  favorites: DirectoryFavorite[];
  recent: RecentDirectory[];
}

export interface DirectoryStore {
  init(): Promise<void>;
  getShortcuts(): Promise<DirectoryShortcuts>;
  addFavorite(path: string, name?: string): Promise<DirectoryFavorite>;
  removeFavorite(id: string): Promise<boolean>;
  recordRecent(path: string): Promise<void>;
}

export interface DirectoryService {
  list(path?: string): Promise<DirectoryListing>;
  validateDirectory(path: string): Promise<void>;
}
```

- [ ] **Step 2: 先写 Store 测试**

`packages/agent/test/directory.test.ts` 使用 `node:test`、`assert/strict`、`mkdtemp` 和 `tmpdir`，覆盖：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectoryStore } from '../src/directory/store.js';

test('store starts empty and persists favorites', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  assert.deepEqual(await store.getShortcuts(), { favorites: [], recent: [] });
  const favorite = await store.addFavorite(join(dataDir, 'project'), 'Project');
  assert.equal(favorite.name, 'Project');
  assert.equal((await store.getShortcuts()).favorites.length, 1);
  assert.match(await readFile(join(dataDir, 'directories.json'), 'utf8'), /Project/);
});

test('store deduplicates recent paths and caps at ten entries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tired-agent-directory-'));
  const store = createDirectoryStore(dataDir);
  await store.init();

  for (let i = 0; i < 11; i++) {
    await store.recordRecent(join(dataDir, `project-${i}`));
  }
  await store.recordRecent(join(dataDir, 'project-0'));

  const recent = (await store.getShortcuts()).recent;
  assert.equal(recent.length, 10);
  assert.equal(recent[0]?.path, join(dataDir, 'project-0'));
});
```

- [ ] **Step 3: 运行测试确认先失败**

Run:

```bash
node --import tsx --test packages/agent/test/directory.test.ts
```

Expected: FAIL because `packages/agent/src/directory/store.ts` does not exist yet.

- [ ] **Step 4: 实现 DirectoryStore**

`createDirectoryStore(dataDir: string): DirectoryStore` 必须：

- 使用 `join(dataDir, 'directories.json')`；
- `init()` 创建 dataDir 并加载 JSON，文件不存在时使用空集合；
- 写入采用 `directories.json.tmp` + `rename`；
- 通过 Promise chain 串行化写入；
- favorite 按 normalized path 去重，Windows 使用小写 key；
- favorite 默认名称使用 `basename(path)`，空 basename 使用完整路径；
- recent 按 normalized path 去重，插入到头部，最多十条；
- `getShortcuts()` 返回新数组，避免 route 直接修改内存状态；
- JSON 损坏时记录 warning 并恢复空数据，不让 Agent 启动失败。

实现关键函数签名：

```ts
export function createDirectoryStore(dataDir: string): DirectoryStore {
  // return { init, getShortcuts, addFavorite, removeFavorite, recordRecent };
}
```

不要把 `DirectoryStore` 与 SQLite `Storage` 合并；本功能的数据文件独立于 session 数据库。

- [ ] **Step 5: 添加 Service 测试**

在同一测试文件加入真实临时目录测试：

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { parse } from 'node:path';
import { createDirectoryService } from '../src/directory/service.js';

test('service lists home children and returns parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tired-agent-home-'));
  await mkdir(join(root, 'packages'));
  await writeFile(join(root, 'file.txt'), 'not returned');
  const service = createDirectoryService(root);

  const listing = await service.list();
  assert.equal(listing.path, root);
  assert.equal(listing.parent, join(root, '..'));
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['packages']);
});

test('service returns null parent at filesystem root', async () => {
  const root = parse(process.cwd()).root;
  const service = createDirectoryService(root);
  const listing = await service.list(root);
  assert.equal(listing.parent, null);
});
```

测试使用平台实际存在的文件系统 root；home 起点测试通过 `createDirectoryService(root)` 注入临时目录，不依赖真实用户 home。

- [ ] **Step 6: 实现 DirectoryService**

实现构造函数：

```ts
export function createDirectoryService(homeDirectory = homedir()): DirectoryService;
```

`list(path?)` 行为：

- path 省略时使用注入的 homeDirectory；
- 用 `resolve` 规范化路径；
- 用 `readdir(..., { withFileTypes: true })` 读取；
- 只保留目录项；
- 对目录名进行大小写不敏感的稳定排序；
- `parent = dirname(currentPath)`，当 parent 与 currentPath 相同则返回 null；
- 把 `ENOENT` 映射为 `DIRECTORY_NOT_FOUND`，`EACCES`/`EPERM` 映射为 `DIRECTORY_ACCESS_DENIED`，`ENOTDIR` 映射为 `NOT_A_DIRECTORY`。

`validateDirectory(path)` 使用 `stat`，确保路径存在、是目录且可访问；不做 home root 限制。

- [ ] **Step 7: 运行 Agent 单元测试和类型检查**

Run:

```bash
node --import tsx --test packages/agent/test/directory.test.ts
npm run typecheck -w @tired-agent/agent
```

Expected: 所有目录单元测试 PASS，Agent 类型检查 PASS。

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/directory packages/agent/test/directory.test.ts packages/agent/package.json
git commit -m "feat(agent): persist directory shortcuts"
```

---

### Task 3: 接入 Agent 路由、启动和 session 最近目录记录

**Files:**
- Create: `packages/agent/src/routes/directories.ts`
- Create: `packages/agent/test/directory-routes.test.ts`
- Modify: `packages/agent/src/app.ts:16-29`
- Modify: `packages/agent/src/index.ts:100-127`
- Modify: `packages/agent/src/session/manager.ts:54-80`

**Interfaces:**
- Consumes `DirectoryStore`, `DirectoryService`。
- Produces authenticated Agent endpoints `/v1/directories*`。
- Produces `SessionManager(storage, directoryStore?)` behavior: successful create with cwd calls `recordRecent` without failing the session.

- [ ] **Step 1: 为 routes 写 Fastify inject 测试**

`packages/agent/test/directory-routes.test.ts` 使用现有 `createApp`，注入临时 Agent config、SQLite storage、SessionManager、DirectoryService 和 DirectoryStore，覆盖：

```ts
test('GET /v1/directories defaults to home and returns only directories', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/v1/directories',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as DirectoryListing;
  assert.equal(body.path, homeDirectory);
  assert.ok(body.entries.every((entry) => entry.path.startsWith(homeDirectory)));
});

test('favorite routes round trip', async () => {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/directories/favorites',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    payload: { path: homeDirectory, name: 'Home' },
  });
  assert.equal(created.statusCode, 201);
  const favorite = created.json() as DirectoryFavorite;

  const removed = await app.inject({
    method: 'DELETE',
    url: `/v1/directories/favorites/${favorite.id}`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(removed.statusCode, 204);
});
```

- [ ] **Step 2: 运行路由测试确认先失败**

Run:

```bash
node --import tsx --test packages/agent/test/directory-routes.test.ts
```

Expected: FAIL because directory routes are not registered.

- [ ] **Step 3: 实现 Agent directory routes**

新增 `registerDirectoryRoutes(app, service, store)`：

```ts
export function registerDirectoryRoutes(
  app: FastifyInstance,
  service: DirectoryService,
  store: DirectoryStore,
): void;
```

使用 Zod：

```ts
const FavoriteSchema = z.object({
  path: z.string().min(1),
  name: z.string().trim().min(1).max(80).optional(),
});
```

路由要求：

- `GET /v1/directories` 调用 `service.list(req.query.path)`；
- `GET /v1/directories/shortcuts` 调用 `store.getShortcuts()`；
- `POST /v1/directories/favorites` 先 `service.validateDirectory(path)`，再 `store.addFavorite`，返回 201；
- `DELETE /v1/directories/favorites/:id` 删除成功返回 204，不存在返回 404；
- 将 DirectoryError 映射到设计文档中的 HTTP/code；
- 不暴露原始堆栈；
- 认证由已有 `registerAuth` 负责，routes 本身不新增旁路认证。

注意在 `GET /v1/directories` 之前注册 `/shortcuts` 这一固定路径，避免未来参数路由冲突。

- [ ] **Step 4: 接入 app/index 初始化**

`packages/agent/src/index.ts` 在创建 session storage 后创建并初始化：

```ts
const directoryStore = createDirectoryStore(cfg.dataDir);
await directoryStore.init();
const directoryService = createDirectoryService();
const manager = new SessionManager(storage, directoryStore);
const app = await createApp(cfg, storage, manager, directoryService, directoryStore);
```

更新 `createApp` 签名：

```ts
export async function createApp(
  cfg: ServerConfig,
  storage: Storage,
  manager: SessionManager,
  directoryService: DirectoryService,
  directoryStore: DirectoryStore,
): Promise<FastifyInstance>;
```

在 `app.ts` 中调用：

```ts
registerDirectoryRoutes(app, directoryService, directoryStore);
```

所有现有 app 创建调用点和测试 fixture 都补上同一组依赖。

- [ ] **Step 5: 修改 SessionManager 记录 recent**

更新构造函数：

```ts
constructor(
  private readonly storage: Storage,
  private readonly directoryStore?: DirectoryStore,
) {}
```

在 `create(spec)` 成功得到 session record 后统一调用：

```ts
private async recordRecentCwd(cwd: string | null): Promise<void> {
  if (!cwd || !this.directoryStore) return;
  try {
    await this.directoryStore.recordRecent(cwd);
  } catch (err) {
    log.warn({ err, cwd }, 'failed to record recent session directory');
  }
}
```

在 process 分支 `_spawnAndAttach` 成功返回后、persistent 分支 `_createPersistent` 成功返回后调用该 helper。不要在 spawn 抛错路径记录 recent。

- [ ] **Step 6: 运行 Agent 测试、类型检查和构建**

Run:

```bash
node --import tsx --test packages/agent/test/directory.test.ts packages/agent/test/directory-routes.test.ts
npm run typecheck -w @tired-agent/agent
npm run build:agent
```

Expected: 目录测试 PASS，Agent typecheck/build PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/routes/directories.ts packages/agent/src/app.ts packages/agent/src/index.ts packages/agent/src/session/manager.ts packages/agent/test/directory-routes.test.ts
git commit -m "feat(agent): expose remote directory browser"
```

---

### Task 4: 增加 Manager 目录代理

**Files:**
- Modify: `packages/manager/src/routes/proxy.ts:89-98`
- Add tests beside existing Manager route tests if the repository adds them during implementation; otherwise use the build/typecheck verification in Step 4.

**Interfaces:**
- Consumes Agent paths `/v1/directories`, `/v1/directories/shortcuts`, `/v1/directories/favorites`。
- Produces Manager paths `/v1/agents/:aid/directories*` for Web Transport。

- [ ] **Step 1: 添加目录 proxy route**

在现有 session proxy routes 后增加：

```ts
app.get<{ Params: { aid: string } }>(
  '/v1/agents/:aid/directories',
  async (req, reply) => {
    const queryString = req.url.split('?')[1] ?? '';
    const upstreamPath = `/v1/directories${queryString ? `?${queryString}` : ''}`;
    return proxyJson(storage, req.params.aid, 'GET', upstreamPath, undefined, reply);
  },
);

app.get<{ Params: { aid: string } }>(
  '/v1/agents/:aid/directories/shortcuts',
  async (req, reply) =>
    proxyJson(storage, req.params.aid, 'GET', '/v1/directories/shortcuts', undefined, reply),
);

app.post<{ Params: { aid: string } }>(
  '/v1/agents/:aid/directories/favorites',
  async (req, reply) =>
    proxyJson(storage, req.params.aid, 'POST', '/v1/directories/favorites', req.body, reply),
);

app.delete<{ Params: { aid: string; id: string } }>(
  '/v1/agents/:aid/directories/favorites/:id',
  async (req, reply) =>
    proxyJson(
      storage,
      req.params.aid,
      'DELETE',
      `/v1/directories/favorites/${encodeURIComponent(req.params.id)}`,
      undefined,
      reply,
    ),
);
```

固定 `/shortcuts` 路由必须在参数 query 的目录 route 前注册，且 `proxyJson` 现有 GET/POST/DELETE 签名保持可用。

- [ ] **Step 2: 验证 query、状态码和错误透传**

使用现有 Manager app 的 inject/fetch 测试方式；如果仓库没有 Manager 测试 harness，至少通过静态检查确认：

- `?path=` 保留并仅编码一次；
- Agent 201/204/4xx 状态码直接镜像；
- Agent 不可达继续返回 502；
- agent id 使用 `encodeURIComponent`。

- [ ] **Step 3: 运行 Manager 类型检查和构建**

Run:

```bash
npm run typecheck -w @tired-agent/manager
npm run build:manager
```

Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add packages/manager/src/routes/proxy.ts
git commit -m "feat(manager): proxy directory endpoints"
```

---

### Task 5: 实现 Web DirectoryPickerModal

**Files:**
- Create: `packages/web/src/components/DirectoryPickerModal.tsx`
- Modify: `packages/web/src/styles.css`（目录弹窗样式）

**Interfaces:**
- Consumes `AgentServerRef`, `transport.listDirectories`, `getDirectoryShortcuts`, `addDirectoryFavorite`, `removeDirectoryFavorite`。
- Produces `onSelect(path: string)` callback，供 SessionCreatePage 回填 cwd。

- [ ] **Step 1: 定义组件 props 和本地状态**

组件 props：

```ts
interface DirectoryPickerModalProps {
  server: AgentServerRef;
  value?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}
```

状态至少包括：

```ts
const [currentPath, setCurrentPath] = useState(value ?? '');
const [parent, setParent] = useState<string | null>(null);
const [entries, setEntries] = useState<DirectoryEntry[]>([]);
const [favorites, setFavorites] = useState<DirectoryFavorite[]>([]);
const [recent, setRecent] = useState<RecentDirectory[]>([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);
const [savingFavorite, setSavingFavorite] = useState(false);
```

- [ ] **Step 2: 实现初始加载和导航函数**

使用 `createHttpSseTransport()` 或现有 `transport` 实例，不直接 `fetch`：

```ts
const loadListing = useCallback(async (path?: string) => {
  setLoading(true);
  setError(null);
  try {
    const listing = await transport.listDirectories(server, path || undefined, server.agentId);
    setCurrentPath(listing.path);
    setParent(listing.parent);
    setEntries(listing.entries);
  } catch (err) {
    setError((err as Error).message);
  } finally {
    setLoading(false);
  }
}, [server]);
```

首次 effect 并行加载：

```ts
useEffect(() => {
  let cancelled = false;
  void Promise.all([
    transport.getDirectoryShortcuts(server, server.agentId),
    transport.listDirectories(server, value || undefined, server.agentId),
  ]).then(([shortcuts, listing]) => {
    if (cancelled) return;
    setFavorites(shortcuts.favorites);
    setRecent(shortcuts.recent);
    setCurrentPath(listing.path);
    setParent(listing.parent);
    setEntries(listing.entries);
  }).catch((err) => {
    if (!cancelled) setError((err as Error).message);
  }).finally(() => {
    if (!cancelled) setLoading(false);
  });
  return () => { cancelled = true; };
}, [server, value]);
```

目录项调用 `loadListing(entry.path)`；上一级只在 `parent !== null` 时调用 `loadListing(parent)`。

- [ ] **Step 3: 实现快捷目录、收藏和选择行为**

要求：

- 收藏/最近项点击直接 `onSelect(path)` 并关闭；
- 目录项点击进入目录，不直接选择；
- “选择当前目录”调用 `onSelect(currentPath)` 后关闭；
- “收藏当前目录”调用 `addDirectoryFavorite`，成功后更新 favorites；
- 已收藏路径显示取消收藏操作，调用 `removeDirectoryFavorite`；
- 收藏失败只显示错误，不关闭弹窗；
- 失效快捷路径点击时先尝试 `loadListing(path)`，失败则显示错误；
- 关闭按钮调用 `onClose`，不修改父组件状态。

收藏名称不新增输入弹窗，默认由 Agent 使用 basename 生成，符合已确认的“浏览后收藏”最小方案。

- [ ] **Step 4: 实现 JSX 和无障碍/触控行为**

必须包含以下可识别元素：

```tsx
<button
  type="button"
  className="directory-up-btn"
  disabled={parent === null || loading}
  onClick={() => parent && void loadListing(parent)}
>
  ← 上一级
</button>
```

目录项使用 `button` 而非不可聚焦的 div；每个操作按钮最小触控高度 44px；当前路径使用 `aria-label`；加载和错误状态都有可见文本。

- [ ] **Step 5: 添加 CSS**

`styles.css` 增加：

- `.directory-modal`：桌面最大宽度 640px，移动端接近全屏；
- `.directory-path`：等宽字体、长路径换行；
- `.directory-toolbar`：上一级按钮和当前路径布局；
- `.directory-entry`：目录图标、名称、点击反馈；
- `.directory-shortcut-list`、`.directory-shortcut-item`：常用/最近列表；
- `.directory-modal-actions`：底部选择/收藏按钮；
- `@media (max-width: 600px)`：modal padding、列表高度和按钮布局适配。

不要改变现有全局 button 的默认语义，新增 class 必须局部覆盖。

- [ ] **Step 6: 运行 Web 类型检查**

在 protocol 已构建后运行：

```bash
npm run build:protocol
npm run typecheck -w @tired-agent/web
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/DirectoryPickerModal.tsx packages/web/src/styles.css
git commit -m "feat(web): add remote directory picker"
```

---

### Task 6: 改造 SessionCreatePage 的 cwd 与命令参数预设

**Files:**
- Modify: `packages/web/src/pages/SessionCreatePage.tsx:7-25,35-108,220-252`
- Modify: `packages/web/src/styles.css`（参数 chip、cwd 字段）

**Interfaces:**
- Consumes `DirectoryPickerModal`。
- Produces `transport.createSession` request with `cwd?: string`。
- Keeps existing preset tiles and lifecycle mode behavior。

- [ ] **Step 1: 将 Preset args 改为数组并定义 ArgumentOption**

替换当前类型：

```ts
interface ArgumentOption {
  id: string;
  label: string;
  args: string[];
  hint: string;
}

interface Preset {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  hint: string;
  emoji: string;
  options?: ArgumentOption[];
}
```

使用以下固定定义：

```ts
const PRESETS: Preset[] = [
  { id: 'claude', label: 'Claude', cmd: 'claude', args: [], hint: 'Anthropic Claude Code CLI', emoji: '✦' },
  { id: 'bash', label: 'Bash', cmd: 'bash', args: [], hint: 'POSIX shell', emoji: '$', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
    { id: 'login', label: 'Login', args: ['-l'], hint: 'Start as a login shell' },
  ] },
  { id: 'zsh', label: 'Zsh', cmd: 'zsh', args: [], hint: 'Z shell', emoji: '$', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
    { id: 'login', label: 'Login', args: ['-l'], hint: 'Start as a login shell' },
  ] },
  { id: 'cmd', label: 'cmd.exe', cmd: 'cmd.exe', args: [], hint: 'Windows command prompt', emoji: '>', options: [
    { id: 'no-auto-run', label: 'No AutoRun', args: ['/d'], hint: 'Disable AutoRun commands' },
  ] },
  { id: 'powershell', label: 'PowerShell', cmd: 'powershell.exe', args: [], hint: 'Windows PowerShell', emoji: '>', options: [
    { id: 'no-logo', label: 'No logo', args: ['-NoLogo'], hint: 'Hide startup logo' },
    { id: 'no-profile', label: 'No profile', args: ['-NoProfile'], hint: 'Skip profile scripts' },
  ] },
  { id: 'python', label: 'Python', cmd: 'python3', args: ['-i'], hint: 'Interactive Python REPL', emoji: '🐍', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
  ] },
  { id: 'node', label: 'Node', cmd: 'node', args: [], hint: 'Node.js REPL', emoji: '⬢', options: [
    { id: 'interactive', label: 'Interactive', args: ['-i'], hint: 'Force interactive mode' },
  ] },
];
```

- [ ] **Step 2: 添加 cwd 和选项状态**

增加：

```ts
const [cwd, setCwd] = useState('');
const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
const [activeOptionIds, setActiveOptionIds] = useState<string[]>([]);
```

增加派生参数：

```ts
const selectedPreset = PRESETS.find((preset) => preset.cmd === cmd);
const selectedOptionArgs = (selectedPreset?.options ?? [])
  .filter((option) => activeOptionIds.includes(option.id))
  .flatMap((option) => option.args);
const effectiveArgs = [...(selectedPreset?.args ?? []), ...selectedOptionArgs];
```

为了保留高级输入框，`args` 状态只保存用户手动输入的附加参数，固定预设参数只来自 `effectiveArgs`。`applyPreset` 必须执行 `setArgs('')`、`setActiveOptionIds([])`，不能把 `preset.args` 再写入 `args`。preview 和提交时使用 `effectiveArgs` 与手动参数的空格拆分结果合并。切换到不匹配任何预设的自定义命令时，`effectiveArgs` 为空，只提交手动参数。

- [ ] **Step 3: 增加参数 chips 和 command preview**

在 Arguments 输入框下渲染：

```tsx
{selectedPreset?.options && selectedPreset.options.length > 0 && (
  <div className="argument-options" aria-label="Common arguments">
    {selectedPreset.options.map((option) => {
      const active = activeOptionIds.includes(option.id);
      return (
        <button
          key={option.id}
          type="button"
          className={'argument-chip' + (active ? ' is-active' : '')}
          title={option.hint}
          onClick={() => {
            setActiveOptionIds((ids) => active
              ? ids.filter((id) => id !== option.id)
              : [...ids, option.id]);
          }}
        >
          {option.label}
        </button>
      );
    })}
  </div>
)}
```

命令 preview 必须展示最终 token 顺序，避免只展示用户手写的 `args`。

- [ ] **Step 4: 增加目录字段和弹窗**

在 Options 区域增加：

```tsx
<div className="field">
  <label className="field-label">Working directory</label>
  <div className="cwd-input-row">
    <input
      className="form-input-mono"
      placeholder="Agent home directory"
      value={cwd}
      onChange={(event) => setCwd(event.target.value)}
      spellCheck={false}
    />
    <button type="button" onClick={() => setDirectoryPickerOpen(true)}>
      Choose
    </button>
  </div>
  {cwd && (
    <button type="button" className="btn-ghost cwd-clear" onClick={() => setCwd('')}>
      Clear directory
    </button>
  )}
</div>
```

在页面根部渲染：

```tsx
{directoryPickerOpen && (
  <DirectoryPickerModal
    server={server}
    value={cwd || undefined}
    onSelect={(path) => {
      setCwd(path);
      setDirectoryPickerOpen(false);
    }}
    onClose={() => setDirectoryPickerOpen(false)}
  />
)}
```

- [ ] **Step 5: 修改提交 payload**

在 `handleCreate` 中构造最终 args，并增加 cwd：

```ts
const manualArgs = args.trim() ? args.trim().split(/\s+/) : [];
const finalArgs = [...effectiveArgs, ...manualArgs];

const session = await transport.createSession(
  serverRef,
  {
    cmd: cmd.trim(),
    args: finalArgs,
    cwd: cwd.trim() || undefined,
    label: label.trim() || undefined,
    cols,
    rows,
    mode,
  },
  server.agentId,
);
```

实现时明确采用单一来源：`args` 只保存高级输入框的手动附加参数，`effectiveArgs` 保存预设默认参数和 chips 参数。因此 `finalArgs` 始终按“预设参数 → chips 参数 → 手动参数”的顺序生成，不会重复发送预设默认值。

- [ ] **Step 6: 添加 Web 样式**

新增 `.argument-options`、`.argument-chip`、`.argument-chip.is-active`、`.cwd-input-row`、`.cwd-clear`，在窄屏下让 cwd 输入框和按钮上下排列。参数 chip 触控高度至少 40px，页面已有移动端 media query 时保持 44px 规则。

- [ ] **Step 7: 运行 Web 类型检查和构建**

Run:

```bash
npm run build:protocol
npm run typecheck -w @tired-agent/web
npm run build:web
```

Expected: PASS，且 Vite 生成 `packages/web/dist`。

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/pages/SessionCreatePage.tsx packages/web/src/styles.css
git commit -m "feat(web): add session directory and argument shortcuts"
```

---

### Task 7: 端到端回归、错误路径和最终验证

**Files:**
- Modify: `packages/agent/test/directory.test.ts`（补充边界测试）
- Modify: `packages/agent/test/directory-routes.test.ts`（补充错误/认证测试）
- Modify: `packages/agent/package.json`（确认 test script）
- No new production files unless a test exposes a concrete defect。

**Interfaces:**
- Consumes all previous tasks。
- Produces passing test/build evidence for the feature。

- [ ] **Step 1: 补充必要的错误路径测试**

加入以下断言：

```ts
test('route rejects a file path as a directory', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/directories?path=${encodeURIComponent(filePath)}`,
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'NOT_A_DIRECTORY');
});

test('route rejects unauthenticated directory access', async () => {
  const response = await app.inject({ method: 'GET', url: '/v1/directories' });
  assert.equal(response.statusCode, 401);
});
```

- [ ] **Step 2: 运行 Agent 测试全集**

Run:

```bash
npm test -w @tired-agent/agent
```

Expected: 所有 `packages/agent/test/*.test.ts` PASS。若现有 package 没有 test script，则先确认 Task 2 已添加：

```json
"test": "node --import tsx --test test/*.test.ts"
```

- [ ] **Step 3: 运行全仓类型检查**

Run:

```bash
npm run typecheck
```

Expected: protocol、agent、manager、web 全部 PASS。

- [ ] **Step 4: 按依赖顺序构建**

Run:

```bash
npm run build:protocol
npm run build:agent
npm run build:manager
npm run build:web
```

Expected: 四个 build 全部 PASS；protocol 必须先于 web。

- [ ] **Step 5: 手动验证核心流程**

启动 Agent、Manager 和 Web 后验证：

1. 打开某个 Agent 的 New Session 页面；
2. 点击 Choose，确认初始目录是 Agent home；
3. 点击子目录进入下一级；
4. 点击“← 上一级”返回，根目录按钮禁用；
5. 选择当前目录，确认 cwd 回填；
6. 收藏当前目录，关闭并重新打开弹窗确认出现在常用目录；
7. 创建 session，确认 session metadata 的 cwd 正确；
8. 重新打开目录弹窗确认该 cwd 出现在最近目录；
9. 重启 Agent 后确认 `directories.json` 中的快捷数据仍能加载；
10. 点击 Bash/PowerShell/Python 等命令的参数 chips，确认 preview 和创建请求 args 正确；
11. 手动输入不存在目录，确认显示 Agent 错误且不会产生 recent；
12. 通过 Manager 访问和直连 Agent 访问时行为一致。

- [ ] **Step 6: 检查工作区并提交最终修正**

Run:

```bash
git diff --check
git status --short --branch
git log --oneline -8
```

确认没有生成不应提交的 Agent data、session log、`dist` 或临时 JSON 文件。若有构建产物被 Git 跟踪，删除后再提交；若测试暴露真实缺陷，修复后重新执行相关测试。

- [ ] **Step 7: Commit**

```bash
git add packages docs
git commit -m "test: verify session creation shortcuts"
```

---

## 完成定义

实现完成前必须满足：

- Protocol、Agent、Manager、Web 类型检查通过；
- `npm run build` 或按依赖顺序的四个 build 通过；
- Agent 目录单元测试和路由测试通过；
- Session 创建页能够选择远程 Agent 目录并发送 `cwd`；
- “← 上一级”在普通目录可用、根目录禁用；
- 收藏和最近目录重启后仍来自 Agent data；
- 内置命令参数 chips 不破坏现有命令预设和 lifecycle mode；
- 未选择 cwd 时的旧行为不变；
- 设计文档和实现提交均位于 `feat/session-create-shortcuts-20260721`。
