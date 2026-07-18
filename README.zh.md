# tired-agent

> *让你的电脑加班，你只管躺平。*

一套自托管系统，让你在远程电脑上运行交互式 CLI 工具（如 `claude`、`aider`、`codex`），通过浏览器从任何地方访问——无需远程桌面，断开连接也不会丢失上下文。

## 架构

```
                    ┌── 远程电脑 ──┐
                    │ tired-agent  │  PTY 执行器
                    │ :8444        │  无 Web 界面
                    └───────┬───────┘
                            │ HTTP（内网）
                    ┌───────▼───────┐
┌──────────┐        │ tired-manager │        ┌── 远程电脑 2 ──┐
│ 手机/    │───────→│ Web 门户 +    │───────→│ tired-agent      │
│ 浏览器   │ HTTPS  │ 代理 + 认证   │  HTTP  │ :8444            │
│ SPA      │        │ :8443         │        └──────────────────┘
└──────────┘        └───────────────┘
```

## 包说明

| 包 | npm | 说明 |
|---------|-----|------|
| [`@tired-agent/agent`](packages/agent) | [![npm](https://img.shields.io/npm/v/@tired-agent/agent)](https://www.npmjs.com/package/@tired-agent/agent) | PTY 会话执行器——部署在被控机器上 |
| [`@tired-agent/manager`](packages/manager) | — | Web 门户 + 代理——浏览器访问的入口 |
| [`@tired-agent/protocol`](packages/protocol) | [![npm](https://img.shields.io/npm/v/@tired-agent/protocol)](https://www.npmjs.com/package/@tired-agent/protocol) | 共享类型和 Transport 接口 |
| [`@tired-agent/web`](packages/web) | — | React + Vite SPA（xterm.js 终端） |

## 快速开始——Agent

最简单的方式是在任意机器上安装 agent：

```bash
npm install -g @tired-agent/agent
tired-agent init              # 创建 ~/.tiredagent，自动生成 token
tired-agent start             # 在 127.0.0.1:8444 启动
curl http://localhost:8444/health
```

编辑 `~/.tiredagent/.env` 修改端口、监听地址或日志级别：

```env
CLSSW_TOKEN=<自动生成>
HOST=0.0.0.0
PORT=8444
CLSSW_LOG_LEVEL=info
```

## 快速开始——源码开发

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent
npm install

# 构建依赖包
npm run build:protocol
npm run build:web

# 启动 agent
npm run dev:agent -- --port 8444 --token dev-token-12345678

# 启动 manager（新终端）
npm run dev:manager -- --port 8443 --token admin-token-12345678

# 启动 Web 开发服务器（新终端）
npm run dev:web
# 打开 http://localhost:5173
```

Vite 开发服务器会自动将 `/v1/*` 代理到 `127.0.0.1:8443`（manager）。

## 自动注册

无需手动在 Manager UI 中添加 Agent——Agent 第一次启动时自动注册：

**1. 在 Manager 上**，配置共享密钥：

```bash
echo 'CLSSW_MANAGER_REGISTER_SECRET=my-shared-secret' >> .env
```

**2. 生成注册串**，传给 Agent：

```bash
REG=$(echo -n '{"managerUrl":"http://manager:8443","agentName":"my-pc","registerSecret":"my-shared-secret"}' | base64 -w0)

tired-agent start --register "$REG"
```

Agent 调用 Manager 注册，收到 API token 后持久化到 `~/.tiredagent/.agent-credentials`。重启时 Agent 使用自己的 `agentKey` 重复注册，Manager 自动去重。

## Docker 部署（Manager）

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent

# 设置管理员 token
export CLSSW_MANAGER_TOKEN=your-admin-token

# 启动
docker compose up -d
# 打开 http://localhost:8443
```

Docker 镜像内嵌了 Web SPA，一个容器搞定，无需额外配置。

## 特性

- **会话持久化**——随时断开。PTY 继续运行，输出写入磁盘。重新连接时按字节偏移量恢复。
- **移动端友好**——xterm.js 终端 + 原生输入桥，手机键盘也能用。
- **Manager-Agent 隔离**——Manager 是纯代理，没有 PTY 权限；Agent 独立运行。
- **SSE 流式传输**——服务端推送事件，支持从任意字节偏移量回放。
- **Agent 自动注册**——一次性配置，`agentKey` 去重，重启无忧。

## 文档

- [设计文档](docs/superpowers/specs/2026-07-15-tired-agent-design.md)（中文）
- [工程优化](docs/superpowers/specs/2026-07-18-engineering-optimizations.md)

## 许可证

TBD
