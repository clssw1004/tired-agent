# Agent 平台信息上报 + Manager 主动健康轮询

## 背景

两需求：

1. **Agent 上报 OS 平台信息**：注册时 + `/health` 端点返回 `platform`（os/arch/release），持久化到 DB，API 返回给前端，用于 session 创建时按平台个性化。

2. **Manager 主动健康轮询**：将当前 Agent → Manager 的心跳推送改为 Manager → Agent 的 `/health` 轮询，验证 **Manager→Agent** 链路（与下发指令方向一致）。同时解决注册时 IP 误报为 127.0.0.1 的问题。

## Agent 端变化

### 淘汰文件
- `packages/agent/src/heartbeat.ts` — 删除，agent 不再主动发心跳

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/agent/src/register.ts` | 注册时 body 增加 `platform`；优化 `detectLanIp()` 过滤虚拟网卡、支持通过 managerUrl 做 UDP 路由探测 |
| `packages/agent/src/index.ts` | 去掉心跳启动逻辑；注册时序不变（注册在前，listen 在后） |
| `packages/agent/src/app.ts` | `/health` 响应增加 `platform: {os, arch, release}` |

## Manager 端变化

### 新增文件
- `packages/manager/src/health-poller.ts` — 主动轮询器：启动定时器轮询所有 agent 的 `/health`，更新状态

### 修改文件

| 文件 | 改动 |
|------|------|
| `packages/manager/src/storage.ts` | `manager_agents` 表增加 `status TEXT`、`platform_os/arch/release TEXT` 列；`Agent` 类型增加对应字段；新增 `updateAgentStatus()`、`updateAgentPlatform()` |
| `packages/manager/src/heartbeat.ts` | 删除或改为空壳（被 health-poller 替代） |
| `packages/manager/src/routes/agents.ts` | `RegisterAgentSchema` 增加 `platform`；注册返回 `{id, token, status: 'pending'}`；`GET /manager/agents` 返回 platform 字段；注册端点不再调用 heartbeatTracker |
| `packages/manager/src/index.ts` | 启动 health-poller 定时器 |
| `packages/manager/src/app.ts` | 如果用到 heartbeatTracker 的地方改为 healthPoller |

## 协议变化

`packages/protocol/src/types.ts`：

- 新增 `PlatformInfo` 接口
- `HeartbeatRequest` 保留但不一定再用
- `/health` 响应类型（目前仅 agent 端有，做类型对齐）

## 状态机

```
register ──→ pending ──→ 首次轮询/health 成功 ──→ online
                            │
                            └── 轮询失败 ──→ offline
                            └── 持续失败或超过N次 ──→ offline

online ──→ 轮询超时（90s） ──→ offline
offline ──→ 后续轮询成功 ──→ online
```
