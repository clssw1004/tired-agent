# CLAUDE.md

## 注意事项：
* **全程使用中文对话**
* 升级操作只能在main分支进行，若当前不在main分支，则需要切到最新的main分支（先切到main，再fetch 再 rebase 到最新的main）
* 修BUG，开发新需求务必要从最新的main分支切出一个新分支进行开发（分支名称：${修改类型(feat/fix...)}/内容相关-${日期(年月日)}）

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Branch strategy

| Branch | Allowed operations |
|--------|-------------------|
| `main` | 版本升级 (`npm version` / 改 `version` 字段)、CI/CD 配置变更、README/CLAUDE.md 等文档更新 |
| `feat/*` | 特性开发 — 从 main 签出，完成后 PR → main |
| `fix/*` | Bug 修复 — 从 main 签出，完成后 PR → main |
| `refactor/*` | 重构 — 从 main 签出，完成后 PR → main |

**规则：`main` 分支不得有特性开发、bug 修复、重构等代码变更。** 这类工作必须在各自的分支进行，通过 PR 合并回 main。版本修改只能在 main 上操作。

## Commands

```bash
# Build all packages (order: protocol → agent + manager + web)
npm run build

# Build individual packages
npm run build:protocol   # types first — everything depends on this
npm run build:agent
npm run build:manager
npm run build:web

# Dev servers (run in separate terminals)
npm run dev:agent        # port 8444, auto-generates token if missing
npm run dev:manager -- --token admin-token-12345678
npm run dev:web          # Vite dev server on :5173, proxies /v1 to :8443

# Agent CLI
node packages/agent/dist/cli.js start --register "<base64>"   # auto-register + start
node packages/agent/dist/cli.js status                         # check status
node packages/agent/dist/cli.js stop                           # stop daemon
node packages/agent/dist/cli.js restart                        # restart daemon

# Typecheck
npm run typecheck

# Docker
docker build -f packages/manager/Dockerfile .          # manager image
docker compose up -d                                    # full stack

# Package publishing
npm publish -w @tired-agent/protocol                   # publish scoped package
npm publish -w @tired-agent/agent
```

Always run `npm run build:protocol` before `npm run build:web` — web's Vite alias points to protocol's source directory and needs types built.

## Release process

### Version bump conventions

**约束：版本号修改只能在 `main` 分支进行。** 如果当前不在 main，先提 PR 合并或 `git switch main && git pull`。

When asked to bump the version, follow these rules:

| User says | Action |
|-----------|--------|
| "升级到 x.y.z" | Set all `package.json` `version` fields to `x.y.z` exactly |
| "发布版本" / no version specified | Patch bump: `z` → `z+1` (e.g. `0.1.0` → `0.1.1`) |
| "发布 minor 版本" | Minor bump: `y` → `y+1`, `z` → `0` (e.g. `0.1.5` → `0.2.0`) |
| "发布 beta 版" / "发个测试版" | `z` → `z+1-beta.0` (e.g. `0.1.0` → `0.1.1-beta.0`). Next beta: `-beta.1` |
| "发布 rc 版" | `z` → `z+1-rc.0` |

Always update **all** packages (protocol, agent, manager, web, root) to the same version. Then suggest the user tag and push:

```
git tag v<new-version>
git push origin v<new-version>
```

### Version strategy — all packages in sync

All packages share the same version (`0.x.y`). The two npm-publishable packages (`@tired-agent/protocol`, `@tired-agent/agent`) are released together on every tag — protocol first, then agent. This avoids version mismatch bugs (agent depends on protocol at `^0.x.y`) and keeps the monorepo manageable.

Releasing the manager as a Docker image at the same tag (`clssw1004/tired-manager:v0.x.y`) ensures the web SPA, protocol types, and server code are always aligned.

### How to release

```bash
# 1. Update version in all package.json files
npm version <patch|minor|major> --workspaces --include-workspace-root
# Or manually edit packages/*/package.json version fields

# 2. Tag and push (triggers CI + Docker + npm publish)
git tag v$(node -p "require('./package.json').version")
git push origin v$(node -p "require('./package.json').version")
```

CI will:
1. **ci.yml** — typecheck + build + verify Docker builds
2. **docker-publish.yml** — build & push `clssw1004/tired-manager` to Docker Hub
3. **npm-publish.yml** — publish `@tired-agent/protocol` → `@tired-agent/agent` to npm

The tag version is validated against both publishable packages before anything ships — if they don't match, the workflow fails.

## Architecture

### Two-server model

- **Agent** (`packages/agent`) — PTY session executor. Runs on machines you control. Listens on `:8444`. No web UI. npm-publishable CLI.
- **Manager** (`packages/manager`) — Web portal + proxy + agent registry. Entry point for browser access. Listens on `:8443`. Docker image.

```
Phone/Browser ──HTTPS──→ Manager (:8443) ──HTTP──→ Agent (:8444)
```

### Data flow

1. Client creates a session via `POST /v1/sessions { cmd, args }` on the agent
2. Agent spawns a node-pty child process, streams output via SSE (`GET /v1/sessions/:id/stream`)
3. SSE emits three event types: `output` (PTY bytes), `state` (session metadata), `heartbeat` (15s keepalive)
4. Output is append-logged to disk for replay; clients reconnect with `?from=<byteOffset>`
5. Input is sent via `POST /v1/sessions/:id/input { data: "<base64>" }`

### Session lifecycle

`starting` → `running` → `exited` → pruned from `live` Map after 60s grace (no subscribers → cleanup timer removes it). On server restart, `reconcileWithStorage()` marks orphan DB rows as `exited`.

### Proxy flow (Manager → Agent)

Manager stores agent tokens. When a browser session is directed at a remote agent, the manager's proxy middleware rewrites paths and injects the agent's bearer token, so the browser never sees agent secrets.

### Packages

| Package | npm | Public | Role |
|---------|-----|--------|------|
| `@tired-agent/protocol` | ✅ | Yes | Shared TypeScript types, Transport interface, SSE types |
| `@tired-agent/agent` | ✅ | Yes | PTY executor (CLI + daemon) |
| `@tired-agent/manager` | — | No | Web portal + proxy (private) |
| `@tired-agent/web` | — | No | React SPA (private, embedded in manager Docker image) |

### Web renderer architecture

The SPA uses a pluggable `AgentRenderer` pipeline:
- `RendererRegistry` (priority-sorted detectors) selects a renderer per command
- Built-in: `ClaudeRenderer` (detects Claude TUI), `GenericPtyRenderer` (fallback with ANSI SGR color rendering)
- Renderers produce `StructuredContent` (discriminated union: text/code/divider/status/table/link/image/command)
- `ChatContainer` maps each variant to a React component

## Key config

All config via CLI args or env vars. Agent loads `.env` from `~/.tiredagent/.env`. Manager loads `.env` from `packages/manager/.env`.

| Component | Env prefix | Default data dir | Default port |
|-----------|-----------|-----------------|-------------|
| Agent | `CLSSW_` / `PORT` | `~/.tiredagent` | 8444 |
| Manager | `CLSSW_MANAGER_` | `./data` | 8443 |

### Agent auto-registration

The admin generates a registration command from the manager UI (`/onboarding`):
1. Admin clicks "Generate registration command" on the onboarding page.
2. UI builds `base64.json({managerUrl})` and shows the install + start one-liner.
3. Agent decodes the payload and POSTs `{name, baseUrl, agentKey}` to `POST /v1/manager/agents/register` (public endpoint, no auth — security is the network perimeter).
4. Manager registers or updates the agent by agentKey, returns `{id, token}`.

Agent defaults:
- **Name**: `os.hostname()`
- **Token**: auto-generated on first start, persisted to `~/.tiredagent/.env`
- **Host**: `0.0.0.0` when `--register` set (LAN IP auto-detected for registration)
- **agentKey**: persisted in `~/.tiredagent/.agent-credentials`, reused across restarts for dedup

Agent CLI subcommands:
- `start` — daemon (supports `--register`, `--port`, `--name`, etc.)
- `status` — show registration state, daemon health
- `stop` — kill daemon by PID file
- `restart` — stop + re-spawn daemon
- `register <base64>` — one-shot register then exit

## Windows notes

- `node-pty` needs `build-base python3` (Alpine) or Python on the PATH
- `better-sqlite3` 12.x has prebuilds for Node 24+ on Windows
- Agent auto-appends `.exe` to bare command names on Windows (`cmd` → `cmd.exe`)
- PTY kill uses `taskkill /F /PID` on Windows

## Vite dev server gotchas

- `@tired-agent/protocol` alias in `vite.config.ts` points to `../protocol/src/index.ts` (not dist/) so edits to protocol source are reflected immediately
- Vite proxies `/v1/*` and `/health` to `http://127.0.0.1:8443` (the manager)
