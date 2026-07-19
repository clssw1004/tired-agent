# Token 管理功能 — 实现计划

## Context

当前 Manager 只有一个静态配置的管理员 token（`--token` / `CLSSW_MANAGER_TOKEN`），所有登录用户拥有完全相同的权限。本次改动将系统升级为多 token 模型，支持：

1. 启动时未配置 token 则自动生成
2. Web UI 中新增 token 管理页面，可创建、重置、删除 token
3. 每个 token 可设置允许访问的 agent 列表（admin token 拥有全部权限）

## 涉及的关键文件

### Manager 后端
- `packages/manager/src/storage.ts` — 新增 `manager_tokens` + `manager_token_agents` 表，新增 token CRUD 方法
- `packages/manager/src/config.ts` — 移除 token 长度强制校验
- `packages/manager/src/index.ts` — 启动时若未配置 token 则自动生成并持久化
- `packages/manager/src/auth.ts` — session 中提取 `tokenRef`，装饰到 request
- `packages/manager/src/routes/auth.ts` — login 改为查 `manager_tokens` 表 + 回退 `cfg.token`
- `packages/manager/src/routes/tokens.ts` — **新建**：token CRUD API
- `packages/manager/src/routes/proxy.ts` — 新增 `checkAgentAccess` 权限检查
- `packages/manager/src/app.ts` — 注册新路由

### Protocol 共享层
- `packages/protocol/src/types.ts` — 新增 `TokenSummary` 类型
- `packages/protocol/src/Transport.ts` — 接口新增 `listTokens/createToken/regenerateToken/deleteToken`
- `packages/protocol/src/HttpSseTransport.ts` — 实现新增方法

### Web 前端
- `packages/web/src/pages/TokenListPage.tsx` — **新建**：token 管理页面
- `packages/web/src/App.tsx` — 添加 `/tokens` 路由和导航
- `packages/web/src/store/AuthContext.tsx` — 添加 token 相关状态和方法
- `packages/web/src/styles.css` — 添加 token 相关样式

---

## 一、数据库变更

### 新表：`manager_tokens`
```sql
CREATE TABLE manager_tokens (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'agent-restricted'
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE UNIQUE INDEX manager_tokens_token ON manager_tokens(token);
```

### 新表：`manager_token_agents`（关联表）
```sql
CREATE TABLE manager_token_agents (
  token_id  TEXT NOT NULL REFERENCES manager_tokens(id) ON DELETE CASCADE,
  agent_id  TEXT NOT NULL REFERENCES manager_agents(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, agent_id)
);
```

### `manager_sessions` 表新增列
```sql
ALTER TABLE manager_sessions ADD COLUMN token_ref TEXT;
```
用于记录 session 是由哪个 token 创建的，proxy 鉴权时据此判断 agent 访问权限。

---

## 二、Storage 层新增方法

在 `storage.ts` 的 `Storage` 接口中新增：

- `listTokens()` → `ManagerTokenSummary[]` — 列出所有 token（不返回完整 secret）
- `findTokenByValue(value)` → `{id, type} | undefined` — 按 token 值查找
- `getTokenById(id)` → `ManagerToken | undefined`
- `persistTokenValue(value, name)` → void — 幂等插入（bootstrap 用）
- `createToken(name, type, agentIds?)` → `{id, token}` — 创建新 token
- `regenerateToken(id)` → `{token}` — 重新生成 token 值
- `deleteToken(id)` → void
- `updateTokenLastUsed(id)` → void
- `getTokenAgentIds(tokenId)` → `string[]`
- `setTokenAgentIds(tokenId, agentIds)` → void

Session 相关改动：
- `createSession(tokenRef?)` — 可选参数关联 token
- `getSession(token)` 返回值增加 `tokenRef?: string`

---

## 三、后端 API 路由

新建 `packages/manager/src/routes/tokens.ts`：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/manager/tokens` | 列出所有 token（只返回前缀，不返回完整值） |
| `POST` | `/v1/manager/tokens` | 创建 token，返回完整值（仅此一次） |
| `PUT` | `/v1/manager/tokens/:id` | 更新 token 名称、类型、agent 访问列表 |
| `POST` | `/v1/manager/tokens/:id/regenerate` | 重新生成 token 值 |
| `DELETE` | `/v1/manager/tokens/:id` | 删除 token（阻止删除最后一个 admin） |

---

## 四、现有文件改动

### 4.1 `config.ts`
- `validateConfig()` 中移除 token 长度校验（仅保留 port 校验）
- token 为空字符串时不再报错

### 4.2 `index.ts`
- `cfg` 从 `const` 改为可变（`let` 或展开拷贝）
- `validateConfig()` 调用后、`createApp()` 前插入 bootstrap 逻辑：
  - 若 `cfg.token` 已设置且 ≥8 字符 → 调用 `storage.persistTokenValue()` 写入 DB
  - 若未设置 → 生成 `randomBytes(32).hex`，写入 DB，设为 `cfg.token`，输出醒目警告日志

### 4.3 `auth.ts`（中间件）
- `getSession()` 返回值增加 `tokenRef`
- `req.userTokenRef = session.tokenRef ?? null`

### 4.4 `routes/auth.ts`（登录）
- `POST /login`：先查 `manager_tokens` 表，匹配不到再回退 `cfg.token` 常量时间比较
- 创建 session 时传入 `tokenRef`
- `GET /me`：返回当前 session 对应的 token 类型信息

### 4.5 `routes/proxy.ts`（代理鉴权）
- 新增 `checkAgentAccess(storage, tokenRef, agentId)` 函数
- `tokenRef` 为空 → 旧版 session，放行
- token 类型为 `admin` → 放行
- token 类型为 `agent-restricted` → 查关联表，仅允许访问已授权的 agent
- 无权限返回 403

### 4.6 `app.ts`
- 添加 `import { registerTokenRoutes }` 并调用

---

## 五、Protocol 共享层改动

### `types.ts`
新增 `TokenSummary` 接口：`{ id, name, type, tokenPrefix, createdAt, lastUsed, agentIds }`

### `Transport.ts`
接口新增：`listTokens`, `createToken`, `regenerateToken`, `deleteToken`

### `HttpSseTransport.ts`
实现上述四个方法，遵循现有 `fetch` + `authHeaders` 模式

---

## 六、Web 前端

### 6.1 `AuthContext.tsx`
新增状态和方法（遵循现有 `refreshAgents` / `addAgent` 模式）：
- `tokens: TokenSummary[]`
- `refreshTokens()`
- `createToken(name, type, agentIds?)`
- `regenerateToken(id)`
- `deleteToken(id)`

### 6.2 `TokenListPage.tsx`（新建）
遵循现有页面布局模式（`page > page-inner > page-header + content`）：

- **页面头部**：标题 "Tokens"，副标题显示数量，工具栏 "Create Token" 按钮
- **Token 卡片列表**：展示名称、类型徽章（Admin / Restricted）、token 前缀、创建时间、最近使用时间、授权 agent 列表、操作按钮
- **创建弹窗**：名称输入、类型选择（admin / agent-restricted）、agent 多选复选框、创建成功后一次性展示 token 值
- **重置弹窗**：确认提示 + 展示新 token 值
- **删除弹窗**：复用 `Modal` 组件 `intent="danger"`
- **空状态**：无 token 时的引导提示
- 复用已有 `Skeleton`、`Toast` 组件

### 6.3 `App.tsx`
- `<AppNav>` 中添加 "Tokens" `<NavLink>`（放在 Onboarding 之后）
- `<Routes>` 中添加 `<Route path="/tokens" element={<TokenListPage />} />`

### 6.4 `styles.css`
添加 token 相关样式（类型徽章、token 值展示框等），遵循已有 BEM 命名和 CSS 变量

---

## 七、实现顺序

1. **Storage 层**：建表 + 迁移 + 所有新方法 + session 改造
2. **Config + 启动**：放宽校验 + bootstrap 逻辑
3. **Auth 中间件 + 登录路由**：tokenRef 提取 + login 改造
4. **Token 路由模块**：新建 `routes/tokens.ts`
5. **Proxy 鉴权**：`checkAgentAccess` + 403 拦截
6. **App.ts 注册**：挂载新路由
7. **Protocol 层**：类型 + Transport 接口 + 实现
8. **AuthContext**：token 状态和方法
9. **TokenListPage**：完整页面组件
10. **样式 + App.tsx**：CSS + 路由注册
11. **全量 typecheck + 手动验证**

## 八、验证方法

1. 无 token 启动 → 自动生成 token，日志输出 → 用生成的 token 登录成功
2. 带 `--token` 启动 → 向后兼容，旧 token 仍可登录
3. 创建 restricted token → 登录后只能访问授权 agent → 未授权 agent 返回 403
4. 重置 token → 旧值立即失效 → 新值可登录
5. 删除 token（非最后一个 admin）→ 成功 → 该 token 无法登录
6. 尝试删除最后一个 admin token → API 拒绝
7. UI 页面：创建/重置/删除操作均正常，token 值仅在创建/重置时展示一次
8. `npm run typecheck` 全量通过
