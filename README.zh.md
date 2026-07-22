# tired-agent

> *让你的电脑加班，你只管躺平。*

[**English**](README.md)

一套自托管系统，让你在远程电脑上运行交互式 CLI 工具（如 `claude`、`aider`、`codex`），通过浏览器从任何地方访问。随时断开连接——会话在远端继续运行。

## 原理

tired-agent 分三个服务角色，分别部署：

### Manager — 控制平面

一个 Fastify HTTP 服务器，承担中心枢纽角色：
- **门户** — 在 `http://<manager>:8443` 提供 Web SPA
- **认证** — 管理员登录、会话管理、访问控制
- **Agent 注册中心** — 用 SQLite 记录所有已注册 agent（名称、URL、token）
- **代理** — 浏览器不直接连接 agent。所有会话 API 调用和 SSE 流都由 manager 转发，透明地注入 agent 的 bearer token
- **引导** — 生成 base64 注册串，实现零配置 agent 接入

Manager 是**唯一需要暴露给外网**的组件（手机、平板、浏览器访问）。

### Agent — PTY 执行器

安装在每台受控机器上的 Node.js 守护进程：
- **PTY 会话** — 通过 `node-pty` 启动交互式 shell（`bash`、`cmd`、`claude` 等）
- **输出流** — 通过 SSE 推送 PTY 输出，支持字节偏移重放以便重连
- **追加日志持久化** — 所有输出写入磁盘，断线客户端可以追上
- **自动注册** — 首次启动时，agent 用管理员生成的一次性 payload 调用 manager 的注册接口，收到 API token 后持久化身份（`agentKey`）用于去重

### Web SPA — 浏览器客户端

由 manager 提供的 React + Vite 应用：
- **登录** — 输入任意 manager URL 和管理员 token 即可连接
- **会话列表** — 查看每个 agent 的运行/已退出会话
- **终端** — xterm.js 完整终端模拟器，支持手机键盘桥接
- **引导** — 分步指导添加新 agent（自动注册或手动添加）

```
┌──────────┐    HTTPS   ┌───────────────────┐    HTTP    ┌──────────────┐
│ 手机/    │───────────→│  Manager (:8443)   │───────────→│  Agent (:8444)│
│ 浏览器   │            │                    │            │  (每台电脑)   │
│ (SPA)    │            │  门户 + 认证 +      │            ├──────────────┤
└──────────┘            │  代理 + 注册中心    │            │  创建 PTY     │
                        │                     │            │  会话         │
                        └─────────────────────┘            └──────────────┘
```

Agent 首次启动时自动向 Manager 注册——每台机器无需手动配置。

---

## 1. 部署 Manager

Manager 是入口。你需要一个可访问的实例（公网或局域网均可）。

### Docker（推荐）

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent

# 设置管理员 token（请修改！）
export CLSSW_MANAGER_TOKEN=你的管理员密码

# 启动
docker compose up -d

# 打开 http://localhost:8443
```

用刚才设置的管理员密码登录，Manager 就绪。

### 从源码运行

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent
npm install
npm run build

CLSSW_MANAGER_TOKEN=你的管理员密码 npm run dev:manager
# 监听 0.0.0.0:8443
```

### Manager 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `CLSSW_MANAGER_TOKEN` | — | 管理员登录密码（必填，至少 8 位） |
| `CLSSW_MANAGER_HOST` | `127.0.0.1` | 监听地址 |
| `CLSSW_MANAGER_PORT` | `8443` | 监听端口 |
| `CLSSW_MANAGER_DATA` | `./data` | SQLite 数据库目录 |
| `CORS_ORIGIN` | `*` | CORS 策略 |

**注意：** Agent 注册端点（`/v1/manager/agents/register`）是公开的——不需要 session token。能访问 Manager 网络的人都可以注册 agent。请勿将 Manager 直接暴露在公网，务必加防火墙或 VPN。

---

## 2. 添加 Agent

Manager 启动后，登录 Web 界面，进入 **Onboarding** 页面（`/#/onboarding`）。

### 自动注册（一键）

点击 **Generate registration command**——页面生成一条命令，安装 agent 并注册到你的 Manager：

```bash
npm install -g @tired-agent/agent && tired-agent start --register "..." --daemon
```

在任何有 Node.js 的机器上粘贴执行。Agent 会自动：
- 以**主机名**作为显示名称
- **自动生成** bearer token 并保存到 `~/.tiredagent/.env`
- 通过 `POST /v1/manager/agents/register` 向 Manager 注册
- 监听 `0.0.0.0:8444`

同一台机器重复执行同一命令——agent 会复用已保存的 `agentKey`，不会创建重复条目。

### 手动添加

如果 agent 已经在某台机器上运行，在 Onboarding 页面的 **Manual add** 表单中粘贴它的 URL 和 token 即可。

---

## 3. Agent CLI

```bash
tired-agent start [options]       # 启动守护进程（可附带自动注册）
tired-agent status                # 查看注册状态 + 健康检查
tired-agent stop                  # 停止守护进程
tired-agent restart               # 重启守护进程
tired-agent register <base64>     # 一次性注册后退出
```

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-p, --port` | `PORT` | `8444` | 监听端口 |
| `-H, --host` | `HOST` | `127.0.0.1` | 监听地址（`--register` 时自动设为 `0.0.0.0`） |
| `-t, --token` | `CLSSW_TOKEN` | 自动生成 | Bearer 鉴权 token |
| `-n, --name` | `CLSSW_AGENT_NAME` | `os.hostname()` | 在 Manager 中显示的名称 |
| `--register` | `CLSSW_REGISTER` | — | Base64 编码的注册串（从 Onboarding 页面获取） |
| `-d, --data-dir` | `CLSSW_DATA` | `~/.tiredagent` | 数据目录 |
| `--log-level` | `CLSSW_LOG_LEVEL` | `info` | 日志级别 |

使用 `--register` 时，agent 自动绑定 `0.0.0.0` 以便 Manager 访问，并自动检测局域网 IP 用于注册。

---

## 4. 开发

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent
npm install

# 构建依赖
npm run build:protocol
npm run build:web

# 分别启动 manager、agent、web 开发服务器
CLSSW_MANAGER_TOKEN=admin-token-12345678 npm run dev:manager

node packages/agent/dist/cli.js start \
  --register "$(echo -n '{"managerUrl":"http://localhost:8443"}' | base64 -w0)"

npm run dev:web
# 打开 http://localhost:5173
```

Vite 开发服务器将 `/v1/*` 代理到 Manager 的 `127.0.0.1:8443`。

## 包

| 包 | npm | 说明 |
|----|-----|------|
| [`@tired-agent/agent`](packages/agent) | [![npm](https://img.shields.io/npm/v/@tired-agent/agent)](https://www.npmjs.com/package/@tired-agent/agent) | PTY 执行器（CLI + 守护进程） |
| [`@tired-agent/manager`](packages/manager) | — | Web 门户 + 代理（Docker） |
| [`@tired-agent/protocol`](packages/protocol) | [![npm](https://img.shields.io/npm/v/@tired-agent/protocol)](https://www.npmjs.com/package/@tired-agent/protocol) | 共享类型和 Transport 接口 |
| [`@tired-agent/web`](packages/web) | — | React + Vite SPA（内嵌在 Manager 中） |

## 特性

- **会话持久化**——随时断开。PTY 持续运行，输出写入磁盘。重连时按字节偏移量恢复。
- **移动端友好**——xterm.js 终端，支持手机键盘。
- **Manager-Agent 隔离**——Manager 是纯代理，没有 PTY 访问权限；Agent 独立运行。
- **SSE 流式传输**——Server-Sent Events 实时输出，支持任意字节偏移重放。

## 文档

- [系统架构](docs/architecture/architecture.md)
- [工程化：部署 / CLI / 自注册](docs/architecture/engineering.md)

## License

TBD
