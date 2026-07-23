# Manager 双 Token 滑动续期 设计规范

> 2026-07-22 设计。本规范**取代** ROADMAP 中"长效登录（"记住我" + 15 天 TTL + 自动续期）"方案（单 token、15d absolute TTL、refresh endpoint）。

## Context

`tiredAgentMobile` 一次登录应当可用远超 15 天（用户不希望 app 频繁弹登录页）。原 ROADMAP 设计的 15 天 absolute TTL 仍会强制周期性重新登录。

新方案采用类 OAuth 2.0 双 token 模型：

- **sessionToken**（短，1h）：每次 manager 请求用，存内存，不持久化
- **refreshToken**（长，30d）：唯一持久化在 secure-store，专门用于换新 sessionToken

只要用户**活跃**（任一 manager 请求在 sessionToken 过期前 5 分钟触发 refresh），refreshToken 滑动重置 30 天，**永远不踢**。真不活跃超过 30 天，下次启动 refreshToken 失效 → 回登录页。

## 协议契约

### manager HTTP 接口

```http
POST /v1/manager/auth/login
Body: { token: string }                     # agent registration token
→ 200 {
    sessionToken: string,                   # 短期，1h
    refreshToken: string,                   # 长期，30d
    sessionExpiresIn: number,               # 秒，3600
    refreshExpiresIn: number,               # 秒，2592000
  }
→ 401 { error: { code: 'invalid_token', message: ... } }

POST /v1/manager/auth/refresh
Authorization: Bearer <refreshToken>
→ 200 { sessionToken: string, sessionExpiresIn: number }
  副作用：旧 session 行删，新行入；**refreshToken 同时滑动**到 30d
  原 refreshToken 第二次提交 401（一次性，仅当有并发竞争时让第二个 401）
→ 401 { error: { code: 'invalid_refresh', message: 'expired or used' } }

POST /v1/manager/auth/logout
Authorization: Bearer <sessionToken|refreshToken>   # 两者皆可认证
→ 200 { ok: true }
  副作用：整行删除（sessionToken + refreshToken 双失效）
```

### 数据库

```sql
CREATE TABLE manager_sessions (
  token              TEXT PRIMARY KEY,        -- sessionToken
  refresh_token      TEXT NOT NULL UNIQUE,    -- refreshToken
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,        -- sessionToken expiry
  refresh_expires_at INTEGER NOT NULL         -- refreshToken expiry
);
CREATE INDEX IF NOT EXISTS manager_sessions_refresh
  ON manager_sessions(refresh_token);
CREATE INDEX IF NOT EXISTS manager_sessions_refresh_expires
  ON manager_sessions(refresh_expires_at);
```

### refresh 事务

```ts
function refresh(refreshToken) {
  db.transaction(() => {
    const row = SELECT * FROM manager_sessions WHERE refresh_token = ?;
    if (!row || row.refresh_expires_at < now) return invalid;
    DELETE FROM manager_sessions WHERE refresh_token = ?;     -- 旧行
    INSERT INTO manager_sessions (token, refresh_token, created_at, expires_at, refresh_expires_at)
      VALUES (random, random, now, now + 1h, now + 30d);      -- 新行
  })();
}
```

- 一个 refreshToken **一次性**（用完失效，并发第二个 401）
- SQLite 在 Node 是单连接 sequential，无 race；但**为跨进程安全**仍走事务
- Web 端多个 tab 共享同一 refreshToken 时只有一个能 refresh 成功，第二个客户端需要 retry（HTTP 401 → 用户后续刷新会重 login）

## 协议包（`@tired-agent/protocol`）

### Transport 接口扩展

```ts
interface Transport {
  // 修改返回类型：
  login(ref: ServerRef, token: string): Promise<{
    sessionToken: string;
    refreshToken: string;
    sessionExpiresIn: number;
    refreshExpiresIn: number;
  }>;

  // 新增：
  refreshSession(ref: ServerRef, refreshToken: string): Promise<{
    sessionToken: string;
    sessionExpiresIn: number;
  }>;
}
```

`ref` 在 refresh 路径下用同一 baseUrl 复用即可——refreshToken 本身鉴权。

### HttpSseTransport 实现要点

- `login()` 现 POST 返回多 token；直接把 payload 透传
- `refreshSession(ref, refreshToken)`：构造 `Authorization: Bearer <refreshToken>` header，POST `/v1/manager/auth/refresh`，返回新 sessionToken
- 错误：`checkOk` 解析 401 → 抛 `Error('refresh failed (401): <msg>')`

## Mobile 端持久化

### secure-store 状态

| Key | 值 | 备注 |
|---|---|---|
| `tired-agent:cred:refresh-token` | `string`（refreshToken） | **唯一**持久化 token |
| 其它 | — | sessionToken 不存 |

### AsyncStorage 状态

| Key | 值 | 备注 |
|---|---|---|
| `tired-agent:manager-config` | `{ baseUrl }` | 不含 sessionToken |

### 内存状态（AuthContext）

| 字段 | 用途 |
|---|---|
| `sessionToken` | 当下活动 sessionToken，每次 manager 调用需有效 |
| `sessionExpiresAtMs` | session 过期时间戳 |
| `refreshToken` | 当前 refreshToken（与 secure-store 同步） |

## Mobile AuthContext 双 Token 模型

### boot() 流程

```
loadManagerConfig() → 读 baseUrl
loadRefreshToken() → 拿 refreshToken; 不存在 → 清空回登录
  if refreshToken 存在:
    try:
      transport.refreshSession(ref, refreshToken)  →  拿到新 sessionToken
      refresh() 取 agent list
      进入 authenticated
    except (401):
      clearSecure / clearAsync
      → 回登录
```

**关键差别**：原方案 boot 调 `checkSession` 用旧 sessionToken；新方案 boot **直接用 refreshToken 换**，避免 boot 时 sessionToken 早已过期的边角。

### login()

```
transport.login(ref, token)  →  {sessionToken, refreshToken, expiresIn...}
  存: saveRefreshToken(refreshToken)
  内存: setSessionToken(sessionToken)
       setSessionExpiresAtMs(now + sessionExpiresIn*1000)
  同步 AsyncStorage: baseUrl
  → 调一次 listAgents (用新 sessionToken)
  authenticated
```

### logout()

```
transport.logout(ref)  ← 用 sessionToken
clearRefreshToken()
clearManagerConfig()
```

### managerRequest 拦截器

任何 mobile 调用 manager 之前过此 wrapper：

```ts
async function withManagerAuth<T>(op: (ref) => Promise<T>): Promise<T> {
  await ensureFreshSession();   // 必要时 silent refresh
  return op(currentRef());
}

// 并发合并：同一 refreshToken 多次 await 同时只跑一次 refresh
let inflightRefresh: Promise<...> | null = null;
async function ensureFreshSession() {
  const remaining = sessionExpiresAtMs - Date.now();
  if (sessionToken && remaining > REFRESH_WINDOW_MS) return;
  if (!refreshToken) throw new UnauthorizedError();
  inflightRefresh ??= transport.refreshSession(currentRef(), refreshToken)
    .finally(() => inflightRefresh = null);
  const { sessionToken: newToken, sessionExpiresIn } = await inflightRefresh;
  setSessionToken(newToken);
  setSessionExpiresAtMs(Date.now() + sessionExpiresIn * 1000);
}
```

`REFRESH_WINDOW_MS = 5 * 60 * 1000`（5 分钟）：提前 5 分钟刷新，避免在请求飞行时过期。

### 401 错误时再尝试一次

```ts
async function withManagerRetry<T>(op: (ref) => Promise<T>): Promise<T> {
  try {
    return await withManagerAuth(op);
  } catch (e) {
    if (isUnauthorized(e) && refreshToken) {
      // 网络抖动导致 sessionToken 在并发窗口外过期 → 强刷一次
      await forceRefresh();
      return op(currentRef());
    }
    if (isUnauthorized(e)) {
      await clearAuthAndRedirect();
    }
    throw e;
  }
}
```

## 配置参数

| 参数 | 值 | 来源 |
|---|---|---|
| `SESSION_TTL_MS` | `60 * 60 * 1000`（1h） | manager `config.sessionTtlMs` |
| `REFRESH_TTL_MS` | `30 * 24 * 60 * 60 * 1000`（30d） | manager `config.refreshTtlMs` |
| `REFRESH_WINDOW_MS` | `5 * 60 * 1000`（5min） | mobile `src/api/authInterceptor.ts` 常量 |

manager 端允许通过 `ManagerConfig` 注入默认值覆盖，mobile 与 web 端硬编码常量不冲突——协议层只用 expiresIn 字段返回的事实值。

## 跨端实施顺序

按 PR 顺序：

1. **tired-agent: 改 manager**（storage.ts + routes/auth.ts + 测试）→ 跑 manager 测试
2. **tired-agent: 改 protocol**（types + Transport + HttpSseTransport + rebuild dist）→ mobile 类型兼容
3. **tiredAgentMobile: 改 AuthContext + storage**（双 token 模型 + 拦截器 + 测试）→ 用户最终感知

ROADMAP 中"长效登录"条目状态从 `📋 设计中` 改为 `✅ 完成`（改双 token 实现）

## 不在范围

- refresh token 撤销/黑名单（30d 内主动撤销需新机制）
- 多设备并发登录：单一 refreshToken 多 tab 共享，第二 tab refresh 后第一 tab refreshToken 失效 → 该 tab 401 → 用户无感重 login（接受）
- 跨设备同步（iPhone + iPad 共账号）的最新 design：以后轮
- "记住我" UI checkbox：mobile 不需要；web 端如果需要另议
