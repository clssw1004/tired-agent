# 工程优化设计文档

> 日期：2026-07-18
> 状态：待实现
> 关联：tired-agent 工程化提升

---

## 动机

项目已完成 agent/manager 分服务架构拆分和基本功能实现。当前阶段需要提升工程成熟度：

1. **部署体验**：目前需手动安装 Node.js、构建、配置，门槛高
2. **分发**：agent 仅限源码使用，无法 `npm install -g` 快速安装
3. **配置流程**：登录分两步（先 URL 后 token）不够流畅
4. **Agent 注册**：手动在 Manager UI 添加 agent 繁琐，期望启动即注册

---

## Task 1: Docker 支持（manager 优先）

### 设计

Manager 容器内嵌 web SPA（`@fastify/static` 托管 `web/dist`）。Dockerfile 用多阶段构建：

1. **Stage 1** (`web-builder`)：构建 web SPA + protocol
2. **Stage 2** (`manager-builder`)：构建 manager
3. **Stage 3** (`runtime`)：node:20-alpine，仅含 dist + node_modules

`docker-compose.yml` 定义 manager 服务，volume 挂载 SQLite 数据目录。

### 文件

- `packages/manager/Dockerfile` — 多阶段构建
- `docker-compose.yml`（项目根）— manager 服务定义
- `.dockerignore` — 排除无用文件

### 关键决策

- Manager 容器中 web dist 已 built-in，不需额外挂载
- 环境变量 `CLSSW_MANAGER_TOKEN` 必须由用户通过 `.env` 或 `docker-compose.yml` 传入
- 数据目录映射到 volume `manager-data:/data`，重启不丢失

### Dockerfile

```dockerfile
FROM node:20-alpine AS web-builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/web/ packages/web/
RUN npm install && npm run build:protocol && npm run build:web

FROM node:20-alpine AS manager-builder
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/protocol/ packages/protocol/
COPY packages/manager/ packages/manager/
RUN npm install && npm run build:protocol && npm run build:manager

FROM node:20-alpine
WORKDIR /app
COPY --from=manager-builder /app/packages/manager/dist ./dist
COPY --from=manager-builder /app/packages/manager/node_modules ./node_modules
COPY --from=manager-builder /app/packages/protocol/dist ./node_modules/@tired-agent/protocol
COPY --from=web-builder /app/packages/web/dist ./web-dist
ENV CLSSW_MANAGER_WEB_DIST=./web-dist
EXPOSE 8443
CMD ["node", "dist/index.js"]
```

### docker-compose.yml

```yaml
services:
  manager:
    build:
      context: .
      dockerfile: packages/manager/Dockerfile
    ports:
      - "${MANAGER_PORT:-8443}:8443"
    environment:
      - CLSSW_MANAGER_TOKEN=${CLSSW_MANAGER_TOKEN:?required}
      - CLSSW_MANAGER_HOST=0.0.0.0
      - CLSSW_MANAGER_PORT=8443
      - CLSSW_MANAGER_DATA=/data
      - CLSSW_MANAGER_REGISTER_SECRET=${CLSSW_MANAGER_REGISTER_SECRET:-}
    volumes:
      - manager-data:/data
    restart: unless-stopped

volumes:
  manager-data:
```

---

## Task 2: Agent npm publish + 丰富 CLI

### 设计

用 [commander](https://www.npmjs.com/package/commander) 替代手写 `parseArgs`，支持子命令（`start`、`register`）和丰富参数。包去掉 `private: true`，加 `bin` entry。

### CLI 接口

```bash
tired-agent start [options]          启动 agent 守护进程
  -p, --port <port>     端口，默认 8444
  -H, --host <host>     绑定地址，默认 127.0.0.1
  -t, --token <token>   认证 token（必须，或 CLSSW_TOKEN）
  -d, --data <dir>      数据目录，默认 ./data
  -n, --name <name>     agent 名称（注册时使用）
  --daemon              fork 到后台运行
  --register <base64>   base64 编码的管理器注册串
  --version             版本号
  --help                帮助

tired-agent register <base64>        注册到 manager 后退出
```

### 后台运行（--daemon）

```ts
if (opts.daemon) {
  const child = spawn(process.execPath, filteredArgv, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  process.exit(0);
}
```

### 包结构改动

```diff
- "private": true,
+ "bin": {
+   "tired-agent": "./dist/cli.js"
+ },
```

`src/cli.ts`（新建）作为 CLI 入口，负责 commander 解析 → 调用 `src/index.ts` 导出的 `main(cfg)`。

### npm publish 注意事项

- node-pty 是 native module，依赖 `node-gyp` 编译环境
- 发布前 `npm run build` 产出 `dist/`
- 可在 CI 上用 `prebuild-install` 提供预编译二进制，或文档说明编译依赖

---

## Task 3: 登录页 URL + Token 同时输入

### 设计

将当前两步登录（先 URL → 再 token）合并为单页面表单。

### 当前状态

LoginPage 根据 `AuthContext.status` 分 4 个渲染分支：

| 状态 | 显示内容 |
|------|----------|
| `needs-manager` | URL 输入 + Continue 按钮 |
| `needs-login` | token 输入 + Sign in 按钮 |
| `uninitialized` / `logging-in` | spinner |
| `error` | 错误 + 重试按钮 |

### 改动后

| 状态 | 显示内容 |
|------|----------|
| `needs-login` | **URL 输入 + token 输入 + Connect 按钮**（合并） |
| `uninitialized` / `logging-in` | spinner |
| `error` | 错误 banner + 重试表单 |
| 罕见：`needs-manager` 保留 | 仅当用户点 "Use different Manager" 且清空 URL 后 |

### AuthContext 新增方法

```ts
/** 原子化设置 Manager URL 并登录 */
async connect(url: string, token: string): Promise<void> {
  localStorage.setItem(BASE_URL_KEY, url.trim());
  setManagerBaseUrlState(url.trim());
  await this.login(token);  // 复用现有 login 逻辑
}
```

### 状态机

```
uninitialized → on mount:
  ├─ localStorage 有 URL+sessionToken → 验证 → logged-in / (清 token → needs-login)
  └─ 无 → needs-login（合并表单）

needs-login → 用户填写 URL+token → connect() → logging-in → logged-in / error
needs-manager → 仅用户主动清 localStorage 后出现 → 同合并表单
```

---

## Task 4: Agent 自动注册到 Manager

### 完整流程

```
┌─ Admin ─────────────────────────────────────────────────┐
│  生成 base64 注册串:                                      │
│    echo -n '{"managerUrl":"http://mgr:8443",            │
│              "name":"my-pc",                            │
│              "registerSecret":"s3cret"}' | base64 -w0   │
│                                                         │
│  写入 agent 的 .env:                                     │
│    CLSSW_REGISTER=<base64串>                             │
└────────────────────────────────────────────────────────┘

┌─ Agent 启动 ─────────────────────────────────────────────┐
│  1. 读取 CLSSW_REGISTER 或 --register <base64>           │
│  2. 解码 → { managerUrl, name, registerSecret }          │
│  3. 构建 agentBaseUrl: http://<host>:<port>              │
│  4. POST {managerUrl}/v1/manager/agents/register          │
│     Body: { name, baseUrl, registerSecret }               │
│  5. Manager 验证 registerSecret → 创建 agent → 返回 token │
│  6. Agent 将 token 写入 .env (CLSSW_TOKEN=xxx)           │
│  7. 用返回的 token 继续正常启动                            │
└────────────────────────────────────────────────────────┘
```

### Manager 端

**config.ts** — 新增 `registerSecret` 字段（`CLSSW_MANAGER_REGISTER_SECRET`，可选）

**routes/agents.ts** — 新增 POST /v1/manager/agents/register（公开，无需 session auth）：

```ts
app.post('/v1/manager/agents/register', async (req, reply) => {
  const { name, baseUrl, registerSecret } = req.body;
  if (!cfg.registerSecret || registerSecret !== cfg.registerSecret) {
    return reply.code(403).send({ error: 'invalid registerSecret' });
  }
  const agentToken = randomBytes(32).toString('hex');
  const { id } = storage.addAgent(name, baseUrl, agentToken);
  return { id, token: agentToken };
});
```

**auth.ts** — 将 `/v1/manager/agents/register` 加入 `PUBLIC_PATHS`

### Agent 端

**src/register.ts**（新建）— 注册逻辑：

```ts
export async function registerWithManager(
  managerUrl: string,
  name: string,
  registerSecret: string,
  agentBaseUrl: string,
): Promise<{ id: string; token: string }> { ... }
```

**index.ts** — 启动前注册：

```ts
if (cfg.registerToken) {
  const payload = JSON.parse(Buffer.from(cfg.registerToken, 'base64').toString());
  const agentBaseUrl = `http://${cfg.host}:${cfg.port}`;
  const result = await registerWithManager(
    payload.managerUrl, payload.name, payload.registerSecret, agentBaseUrl,
  );
  // 写入 .env
  writeEnv({ CLSSW_TOKEN: result.token });
  cfg.token = result.token;
}
```

### 安全

- `/register` 端点公开，但依赖 `registerSecret` 验证
- `registerSecret` 是共享密钥，配置在 Manager 的 `.env` 中
- 注册成功后 agent 获得专属随机 token，后续所有 API 调用使用该 token
- base64 仅为方便复制粘贴，非安全措施（等效明文传输）

---

## 实施顺序

```
Phase 1: Task 3 (登录合并)   ← 纯前端，改动量小
Phase 2: Task 1 (Docker)     ← 无代码依赖
Phase 3: Task 4 (自动注册)   ← Manager + Agent 配合
Phase 4: Task 2 (npm CLI)    ← 最后重构 CLI
```

---

## 验证方法

见 [工程优化验证](2026-07-18-engineering-optimizations.md#验证)（本文件执行命令）。
