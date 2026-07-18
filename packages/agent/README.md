# @tired-agent/agent

> PTY session executor — run interactive CLI tools remotely.

Part of the [tired-agent](https://github.com/clssw1004/tired-agent) ecosystem. This package runs on controlled machines and executes PTY sessions (bash, cmd, claude, aider, etc.). It is managed by a [tired-agent manager](https://www.npmjs.com/package/@tired-agent/manager) which proxies WebSocket-free access from a browser SPA.

## Install

```bash
npm install -g @tired-agent/agent
```

## Quick start

### 1. Create config

```bash
mkdir -p ~/.tiredagent
# Generate a random token
tired-agent init
```

Edit `~/.tiredagent/.env`:

```env
CLSSW_TOKEN=your-secret-token-here
HOST=0.0.0.0
PORT=8444
```

### 2. Start the daemon

```bash
tired-agent start
```

### 3. Verify

```bash
curl -H "Authorization: Bearer $CLSSW_TOKEN" http://localhost:8444/health
# → {"status":"ok","ts":...}
```

## Usage

```
Usage: tired-agent [options] [command]

Commands:
  start [options]    Start the agent daemon
  register <base64>  Register with a Manager using a connection string
  init [options]     Initialize the data directory with default config
  help [command]     Display help for a command
```

### `tired-agent start`

| Option | Env | Default | Description |
|--------|-----|---------|-------------|
| `-p, --port` | `PORT` | `8444` | Port to listen on |
| `-H, --host` | `HOST` | `127.0.0.1` | Host to bind to |
| `-t, --token` | `CLSSW_TOKEN` | — | Bearer token for API auth |
| `-d, --data-dir` | `CLSSW_DATA` | `~/.tiredagent` | Data directory |
| `-n, --name` | `CLSSW_AGENT_NAME` | — | Agent name for manager registration |
| `--register` | `CLSSW_REGISTER` | — | Base64-encoded manager registration string |
| `--log-level` | `CLSSW_LOG_LEVEL` | `info` | Log level |
| `--sse-format` | `CLSSW_SSE_FORMAT` | `base64` | SSE payload format (`base64` / `hex`) |
| `--sse-debug` | `CLSSW_DEBUG_SSE` | `false` | Enable SSE hex dump logging |

> `--host` defaults to `0.0.0.0` when `--register` is provided (so the manager can reach you), otherwise `127.0.0.1`.

### `tired-agent init`

```bash
tired-agent init                  # create ~/.tiredagent with generated token
tired-agent init --register <b64> # include registration string for auto-setup
tired-agent init -f               # overwrite existing config
```

### `tired-agent register`

```bash
tired-agent register "$REG_STRING"
```

Registers with a manager and prints the returned `{id, token}`. The `register` command is also run automatically at startup when `--register` is provided.

### `tired-agent reload`

```bash
tired-agent reload -t "$CLSSW_TOKEN"
```

Sends a reload signal to the running agent, causing it to re-read `~/.tiredagent/.env`.

## Auto-registration with a Manager

1. On the Manager machine, set `CLSSW_MANAGER_REGISTER_SECRET` in its `.env`.
2. Generate a registration string (base64-encoded JSON):

   ```bash
   echo -n '{"managerUrl":"http://manager:8443","agentName":"my-pc","registerSecret":"<the-secret>"}' | base64 -w0
   ```

3. Pass it to the agent on startup:

   ```bash
   tired-agent start --register "<base64-string>"
   ```

   The agent will call the Manager, receive an API token, and save it to `~/.tiredagent/.agent-credentials`. On subsequent restarts, the agent reuses the saved credentials and re-registers with its `agentKey` for dedup.

## Architecture

```
┌──────────────┐     HTTP + SSE      ┌──────────────────┐
│  Manager     │ ──────────────────→ │  Agent            │
│  (portal +   │    ?access_token=   │  :8444            │
│   proxy)     │                     │  node-pty sessions│
└──────────────┘                     └──────────────────┘
       ↑                                     ↑
       │ HTTPS / SPA                         │
  ┌────┴────┐                         ┌──────┴──────┐
  │ Browser │                         │ CLI / other │
  │ (mobile)│                         │ consumers   │
  └─────────┘                         └─────────────┘
```

The Agent is a pure PTY executor — no web UI, no proxy. It exposes a REST + SSE API for session management.

## Data directory layout

```
~/.tiredagent/
  .env                  # Configuration (created by `tired-agent init`)
  .agent-credentials    # Auto-generated on manager registration
  logs/
    agent.log           # Current log file
    agent.1.log         # Rotated logs (up to 5, 1 MB each)
    ...
  agent.sqlite          # Session metadata (SQLite)
  sessions/             # PTY output logs (append-only)
```

## Logging

The agent writes logs to `{dataDir}/logs/agent.log` with 1 MB rotation (5 backups). Configure with `--log-level` or `CLSSW_LOG_LEVEL` (`info`, `debug`, `warn`, `error`, `fatal`).

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/v1/sessions` | List sessions |
| `POST` | `/v1/sessions` | Create a session |
| `GET` | `/v1/sessions/:id` | Get session metadata |
| `DELETE` | `/v1/sessions/:id` | Kill / delete a session |
| `POST` | `/v1/sessions/:id/input` | Send input to PTY |
| `POST` | `/v1/sessions/:id/resize` | Resize PTY (cols/rows) |
| `GET` | `/v1/sessions/:id/output` | Fetch historical output |
| `GET` | `/v1/sessions/:id/stream` | SSE live stream |
| `POST` | `/v1/admin/reload` | Reload config from `.env` |

All endpoints (except `/health`) require `Authorization: Bearer <token>` header or `?access_token=<token>` query parameter.

## License

TBD
