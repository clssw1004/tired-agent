# tired-agent

> *Let your home PC work overtime, even while you're out.*

A self-hostable system that lets you run interactive CLI tools (like `claude`, `aider`, `codex`) on your home computer and access them from anywhere via a web SPA — without remote desktop, without losing context when you disconnect.

**Key property:** "即用即连" — you can disconnect at any time. The server keeps running, captures all output to disk. When you reconnect, the client fetches missed output by byte offset and resumes exactly where you left off.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Web SPA (React + Vite)                     │
│   ├─ Server List / Login                    │
│   ├─ Session List (with auto-refresh)       │
│   └─ Terminal View (xterm.js + input bar)   │
│              ▲                              │
│              │  Transport (HTTP REST + SSE)  │
└──────────────┼──────────────────────────────┘
               │  HTTPS + Bearer Token
┌──────────────▼──────────────────────────────┐
│  Server Daemon (Node.js)                    │
│   ├─ Fastify HTTP — REST + SSE              │
│   ├─ Session Manager (node-pty)             │
│   └─ Storage (pluggable: SQLite | MySQL | PG)│
│       └─ Append-only log files (PTY)        │
└─────────────────────────────────────────────┘
```

## Repository Layout

```
packages/
  protocol/   # Shared TypeScript types + Transport interface + HttpSseTransport
  agent/      # PTY executor daemon — runs on controlled machines
  manager/    # Web portal + agent proxy + SPA host
  web/        # React + Vite SPA
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Windows / macOS / Linux

### Install

```bash
# from repo root
npm install
npm run build:protocol
npm run build:web
```

### Run agent

```powershell
$env:CLSSW_TOKEN = "my-secret-12345"
npm run dev:agent -- --port 8444 --data ./packages/agent/data
```

### Run manager

```powershell
$env:CLSSW_MANAGER_TOKEN = "admin-token-xxx"
npm run dev:manager -- --port 8443
```

### Run web (dev mode)

```powershell
npm run dev:web
# Open http://localhost:5173
# Vite proxies /v1/* to http://127.0.0.1:8443 automatically
```

### In the web UI

1. Enter the Manager URL and sign in with the admin token
2. "+ Add Agent" → URL of the agent daemon + its token
3. Tap an agent → "New Session" → enter `cmd.exe` (Windows) or `bash` (Unix)
4. The terminal view opens; read output and type commands

## Documentation

- [Design document](docs/superpowers/specs/2026-07-15-tired-agent-design.md)

## License

TBD
