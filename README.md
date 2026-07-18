# tired-agent

> *让你的电脑加班，你只管躺平。*

[**中文版**](README.zh.md)

A self-hostable system for running interactive CLI tools (like `claude`, `aider`, `codex`) on remote machines and accessing them from anywhere via a web browser. Disconnect any time — the session keeps running.

## How it works

Tired-agent has three service roles, deployed separately:

### Manager — the control plane

A Fastify HTTP server that acts as the central hub:
- **Portal** — serves the web SPA at `http://<manager>:8443`
- **Auth** — admin login, session management, access control
- **Agent registry** — keeps track of all registered agents (name, URL, token) in SQLite
- **Proxy** — browser never talks to agents directly. The manager proxies all session API calls and SSE streams to the right agent, injecting the agent's bearer token transparently
- **Onboarding** — generates base64 registration strings for zero-config agent setup

The manager is the **only component you expose to the outside world** (phone, tablet, browser).

### Agent — the PTY executor

A Node.js daemon installed on each machine you want to control:
- **PTY sessions** — spawns interactive shells (`bash`, `cmd`, `claude`, etc.) via `node-pty`
- **Output streaming** — pushes PTY output over SSE with byte-offset replay for reconnection
- **Append-log persistence** — all output is written to disk so disconnected clients can catch up
- **Self-registration** — on first start, the agent calls the manager's register endpoint with an admin-generated one-shot payload, receives an API token, and persists its identity (`agentKey`) for dedup

### Web SPA — the browser client

A React + Vite application served by the manager:
- **Login** — point it at any manager URL and authenticate with the admin token
- **Session list** — browse running / exited sessions per agent
- **Terminal** — xterm.js full terminal emulator with mobile keyboard bridge
- **Onboarding** — step-by-step guide to add new agents (auto-register or manual)

```
┌──────────┐    HTTPS   ┌───────────────────┐    HTTP    ┌──────────────┐
│  Phone / │───────────→│  Manager (:8443)   │───────────→│  Agent (:8444)│
│  Browser │            │                    │            │  (one per PC) │
│  (SPA)   │            │  Portal + Auth +   │            ├──────────────┤
└──────────┘            │  Proxy + Registry  │            │  spawns PTY   │
                        │                    │            │  sessions     │
                        └───────────────────┘            └──────────────┘
```

Agents self-register with the manager on first start — no manual config per machine.

---

## 1. Deploy the Manager

The manager is the entry point. You need one publicly reachable instance (or LAN-reachable, if you only access it from within your network).

### Docker (recommended)

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent

# Set your admin token (change this!)
export CLSSW_MANAGER_TOKEN=your-admin-token

# Start
docker compose up -d

# Open http://localhost:8443
```

Log in with the admin token you set. That's it — the manager is ready.

### From source

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent
npm install
npm run build

CLSSW_MANAGER_TOKEN=your-admin-token npm run dev:manager
# Listening on 0.0.0.0:8443
```

### Manager configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLSSW_MANAGER_TOKEN` | — | Admin login token (required, min 8 chars) |
| `CLSSW_MANAGER_HOST` | `127.0.0.1` | Bind address |
| `CLSSW_MANAGER_PORT` | `8443` | Listen port |
| `CLSSW_MANAGER_DATA` | `./data` | SQLite database directory |
| `CORS_ORIGIN` | `*` | CORS policy |

**Important:** The agent registration endpoint (`/v1/manager/agents/register`) is public — it does not require a session token. Anyone who can reach the manager's network can register an agent. Do not expose the manager directly to the public internet without a firewall or VPN.

---

## 2. Add Agents

Once the manager is running, log in and go to the **Onboarding** page (`/#/onboarding`).

### Auto-register (one click)

Click **Generate registration command** — the page creates a one-liner that
installs the agent and registers it with your manager:

```bash
npm install -g @tired-agent/agent && tired-agent start --register "..." --daemon
```

Paste that on any machine with Node.js. The agent:
- Uses its **hostname** as the display name
- **Auto-generates** a bearer token and saves it to `~/.tiredagent/.env`
- Registers itself with the manager via `POST /v1/manager/agents/register`
- Starts listening on `0.0.0.0:8444`

Re-run the same command on the same machine — the agent reuses its saved
`agentKey`, so no duplicate entry is created.

### Manual add

If the agent is already running somewhere, paste its URL and token into the
**Manual add** form on the onboarding page.

---

## 3. Agent CLI

```bash
tired-agent start [options]       # Start the daemon (add --daemon to background it)
tired-agent status                # Show registration state + health
tired-agent stop                  # Stop the daemon
tired-agent restart               # Restart the daemon
tired-agent register <base64>     # One-shot register, then exit
```

| Option | Env | Default | Description |
|--------|-----|---------|-------------|
| `-p, --port` | `PORT` | `8444` | Listen port |
| `-H, --host` | `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` with `--register`) |
| `-t, --token` | `CLSSW_TOKEN` | auto-generated | Bearer token |
| `-n, --name` | `CLSSW_AGENT_NAME` | `os.hostname()` | Display name in manager |
| `--register` | `CLSSW_REGISTER` | — | Base64 registration string |
| `-d, --data-dir` | `CLSSW_DATA` | `~/.tiredagent` | Data directory |
| `--log-level` | `CLSSW_LOG_LEVEL` | `info` | Log level |

When `--register` is set, the agent automatically binds to `0.0.0.0` so the
manager can reach it. Its LAN IP is auto-detected for registration.

---

## 4. Development

```bash
git clone https://github.com/clssw1004/tired-agent.git
cd tired-agent
npm install

# Build dependencies
npm run build:protocol
npm run build:web

# Start manager + agent + dev server in separate terminals
CLSSW_MANAGER_TOKEN=admin-token-12345678 npm run dev:manager

node packages/agent/dist/cli.js start \
  --register "$(echo -n '{"managerUrl":"http://localhost:8443"}' | base64 -w0)"

npm run dev:web
# Open http://localhost:5173
```

The Vite dev server proxies `/v1/*` to the manager at `127.0.0.1:8443`.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@tired-agent/agent`](packages/agent) | [![npm](https://img.shields.io/npm/v/@tired-agent/agent)](https://www.npmjs.com/package/@tired-agent/agent) | PTY executor (CLI + daemon) |
| [`@tired-agent/manager`](packages/manager) | — | Web portal + proxy (Docker) |
| [`@tired-agent/protocol`](packages/protocol) | [![npm](https://img.shields.io/npm/v/@tired-agent/protocol)](https://www.npmjs.com/package/@tired-agent/protocol) | Shared types and Transport interface |
| [`@tired-agent/web`](packages/web) | — | React + Vite SPA (embedded in manager) |

## Features

- **Session persistence** — disconnect any time. The PTY keeps running, output is captured to disk. Reconnect and resume by byte offset.
- **Mobile-friendly** — xterm.js terminal with a native input bridge for mobile keyboards.
- **Manager-Agent isolation** — the manager is a pure proxy with no PTY access; agents run independently.
- **SSE streaming** — Server-Sent Events for live output with replay from arbitrary byte offsets.

## Documentation

- [Design document (zh)](docs/superpowers/specs/2026-07-15-tired-agent-design.md)
- [Engineering optimizations](docs/superpowers/specs/2026-07-18-engineering-optimizations.md)

## License

TBD
