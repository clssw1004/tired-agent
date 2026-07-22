# 工程化：部署、CLI、登录、自注册

本文件记录 tired-agent 的工程化能力如何落地：容器化部署、Agent 的 npm 分发与 CLI、登录体验、
以及 Agent 到 Manager 的自注册流程。

---

## Task 1：Docker 支持（Manager）

Manager 镜像内嵌 Web SPA（用 `@fastify/static` 托管 `web/dist`）。`packages/manager/Dockerfile`
采用三阶段构建，最终运行镜像仅含 `dist` + `node_modules`。

### Dockerfile（三阶段）

```dockerfile
# Stage 1: 构建 protocol + web SPA
FROM node:20-alpine AS web-builder
WORKDIR /app
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/
RUN npm ci
RUN npm run build:protocol && npm run build:web

# Stage 2: 构建 manager
FROM node:20-alpine AS manager-builder
WORKDIR /app
RUN apk add --no-cache build-base python3
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/ packages/
RUN npm ci
RUN npm run build:protocol && npm run build:manager

# Stage 3: 运行时
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache build-base python3
COPY --from=web-builder     /app/packages/web/dist       ./packages/web/dist
COPY --from=manager-builder /app/packages/manager/dist   ./packages/manager/dist
COPY --from=manager-builder /app/packages/manager/package.json ./packages/manager/
COPY --from=manager-builder /app/node_modules            ./node_modules
COPY --from=manager-builder /app/packages/protocol/dist  ./packages/protocol/dist
ENV CLSSW_MANAGER_HOST=0.0.0.0
ENV CLSSW_MANAGER_PORT=8443
ENV CLSSW_MANAGER_DATA=/data
ENV CLSSW_MANAGER_WEB_DIST=/app/packages/web/dist
ENV CORS_ORIGIN=*
EXPOSE 8443
WORKDIR /app/packages/manager
CMD ["node", "dist/index.js"]
```

> `build-base python3` 是 `better-sqlite3` 等原生模块的编译依赖，运行阶段同样保留以便按需重建。

### docker-compose.yml

```yaml
services:
  manager:
    image: clssw1004/tired-manager:latest
    ports:
      - "${MANAGER_PORT:-8443}:8443"
    environment:
      - CLSSW_MANAGER_TOKEN=${CLSSW_MANAGER_TOKEN:?Please set CLSSW_MANAGER_TOKEN}
      - CLSSW_MANAGER_HOST=0.0.0.0
      - CLSSW_MANAGER_PORT=8443
      - CLSSW_MANAGER_DATA=/data
      - CORS_ORIGIN=*
    volumes:
      - manager-data:/data
    restart: unless-stopped

volumes:
  manager-data:
```

### 关键决策

- Web dist 已内建进镜像，无需额外挂载。
- `CLSSW_MANAGER_TOKEN` 必须由用户通过 `.env` 或 compose 传入；未设置时启动会拒绝
  （或自动生成并写入 `.env`，取决于运行方式）。
- 数据目录映射到具名卷 `manager-data:/data`，重启不丢失。
- 官方镜像 `clssw1004/tired-manager` 与 npm 包同版本发布，保证 SPA / protocol / server 对齐。

---

## Task 2：Agent 的 npm 分发与 CLI

Agent 以 `@tired-agent/agent` 发布，`package.json` 提供 `bin: { "tired-agent": "./dist/cli.js" }`。
CLI 用 [commander](https://www.npmjs.com/package/commander) 实现子命令。

### 子命令

```bash
tired-agent start [options]      启动 agent 守护进程
tired-agent register <base64>    用 base64 连接串注册到 Manager 后退出
tired-agent stop                 停止守护进程（读 agent.pid）
tired-agent restart              重启守护进程
tired-agent status               显示注册状态 / 健康 / 配置
tired-agent --version            版本号
tired-agent --help               帮助
```

### `tired-agent start` 选项

| 选项 | 环境变量 | 默认 | 说明 |
|------|----------|------|------|
| `-p, --port` | `PORT` | `8444` | 监听端口 |
| `-H, --host` | `HOST` | `127.0.0.1`（设 `--register` 时为 `0.0.0.0`） | 绑定地址 |
| `-t, --token` | `CLSSW_TOKEN` | 自动生成 | 入站鉴权 bearer |
| `-d, --data-dir` | `CLSSW_DATA` | `~/.tiredagent` | 数据目录 |
| `-n, --name` | `CLSSW_AGENT_NAME` | `os.hostname()` | 注册时的 Agent 名 |
| `--register` | `CLSSW_REGISTER` | — | base64 注册串 |
| `--log-level` | `CLSSW_LOG_LEVEL` | `info` | 日志级别 |
| `--sse-format` | `CLSSW_SSE_FORMAT` | `base64` | SSE 载荷编码（`base64` / `hex`） |
| `--sse-debug` | `CLSSW_DEBUG_SSE` | `false` | SSE hex dump 调试日志 |
| `-D, --daemon` | — | — | 后台运行（脱离终端） |

### 后台运行（`--daemon`）

`start --daemon` 会剔除 `--daemon` 后 fork 一个前台子进程再退出，PID 写入
`<dataDir>/agent.pid`；`stop` / `restart` 读该 PID 文件管理进程：

- Windows：后台用 `start /B`，停止用 `taskkill /F /PID`。
- Unix：后台用 `nohup ... &`，停止用 `kill`（SIGTERM）。

在系统服务管理器（systemd / nssm）下运行时**不要**加 `--daemon`，让服务管理器持有前台进程生命周期。

### 配置加载顺序（`.env`）

优先级由低到高：包内 `dist/.env`（打包默认）→ `~/.tiredagent/.env`（用户配置，`override`）→
shell 环境变量（最高）。启动时若 token 未设置会自动生成并回写到用户 `.env`。

### npm 发布注意

- node-pty 是原生模块，依赖编译环境（Windows 需 Python + build tools；Alpine 需 `build-base python3`）。
- 发布前 `npm run build` 产出 `dist/`。
- `@tired-agent/protocol` 与 `@tired-agent/agent` 同版本、按序发布（protocol 先，agent 后）。

---

## Task 3：登录页 URL + Token 单表单

登录合并为**单页面表单**：同时填写 Manager URL 与 admin token，点击连接即完成。

- 前端 `AuthContext` 用 localStorage 键持久化：
  - `tired-agent:manager-base-url` —— Manager 地址
  - `tired-agent:manager-session-token` —— 登录后拿到的会话 token
- 登录调用 `POST /v1/manager/auth/login`，body `{ token: <admin-token> }`，成功后返回会话 token
  （TTL 24h），后续请求以会话 token 鉴权。
- 已保存有效会话 token 时自动进入已登录态；token 失效则清理并回到登录表单。

---

## Task 4：Agent 自动注册到 Manager

### 完整流程

```
┌─ Admin（已在 Onboarding UI 登录）──────────────────────────────────┐
│  点击"生成注册命令"，UI 构造：                                       │
│    base64(json({ "managerUrl": "http://<manager-host>:8443"         │
│                 [, "agentName": "my-pc" ] }))                        │
│  展示安装 + 启动一行命令                                             │
└─────────────────────────────────────────────────────────────────────┘

┌─ Agent 启动 ──────────────────────────────────────────────────────────┐
│  1. 读取 --register / CLSSW_REGISTER，解码 → { managerUrl }           │
│  2. 生成或复用 agentKey（存 <dataDir>/.agent-credentials）             │
│  3. host=0.0.0.0 时自动探测局域网 IPv4，拼出 baseUrl                   │
│  4. POST {managerUrl}/v1/manager/agents/register                      │
│     body: { name, baseUrl, agentKey }                                 │
│  5. Manager 按 agentKey（其次 baseUrl）去重 → 返回 { id, token }       │
│  6. Agent 保存 { agentKey, id, token }，用该 token 继续正常启动        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Manager 端

- **`routes/agents.ts`** —— `POST /v1/manager/agents/register`（公开，无需会话鉴权）：

  ```ts
  const RegisterAgentSchema = z.object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
    agentKey: z.string().optional(),   // 再注册时携带，用于去重
  });

  app.post('/v1/manager/agents/register', async (req, reply) => {
    const parsed = RegisterAgentSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid_request', ... } });
    const { id, token } = storage.registerAgent(parsed.data.name, parsed.data.baseUrl, parsed.data.agentKey);
    return reply.code(201).send({ id, token });
  });
  ```

- **`auth.ts`** —— `/v1/manager/agents/register` 属于 `PUBLIC_PATHS`，跳过会话鉴权。
- **`storage.registerAgent`** —— 去重逻辑：
  1. 若 `agentKey` 命中既有条目 → 复用其 token，仅刷新 `baseUrl` / `name`。
  2. 否则若 `baseUrl` 命中（同机器、agentKey 丢失场景）→ 复用 id/token，刷新 name。
  3. 都不命中 → 新建条目，生成随机 token。

### Agent 端

- **`register.ts`** —— `registerWithManager(managerUrl, name, agentBaseUrl, agentKey?)` POST 注册；
  `getOrRegisterCredentials(cfg)` 负责"有 register 串则（携 agentKey）注册、否则复用
  `.agent-credentials`"。`detectLanIp()` 在 `host=0.0.0.0` 时挑选可达的内网 IPv4。

### 安全

- 注册端点**公开、无共享密钥、无 ticket**。base64 仅为便于复制粘贴，**不是安全措施**（等效明文传输）。
- 安全边界是**网络**：请用 VPN / 反向代理 / 防火墙保护 Manager，不要裸露公网。
- 复用 token 而非每次重签，避免 Agent 重启后锁死此前连接的客户端。

---

## 验证

```bash
# Manager（Docker）
export CLSSW_MANAGER_TOKEN=<your-admin-token>
docker compose up -d
# 浏览器打开 http://localhost:8443，用 admin token 登录

# Agent（源码 / npm）
tired-agent start --register "<base64-注册串>"
tired-agent status     # 查看注册与健康状态
```
