# tired-pc

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
  server/     # Node.js daemon — API-only, no web UI
  web/        # React + Vite SPA (standalone, deploy to nginx or run with `vite`)
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

### Run server

```powershell
$env:CLSSW_TOKEN = "my-secret-12345"
npm run dev:server -- --port 8443 --data ./packages/server/data
```

### Run web (dev mode)

```powershell
npm run dev:web
# Open http://localhost:5173
# Vite proxies /v1/* to http://127.0.0.1:8443 automatically
```

### In the web UI

1. "+ Add Server" → URL: `http://127.0.0.1:8443`, Token: `my-secret-12345`
2. Tap → "New Session" → enter `cmd.exe` (Windows) or `bash` (Unix)
3. The terminal view opens; read output and type commands

### Production deployment (nginx + server)

See [docs/nginx-tired-pc.conf](docs/nginx-tired-pc.conf) for an example nginx config that serves the web SPA at `/` and reverse-proxies `/v1/*` to the server.

## Documentation

- [Design document](docs/superpowers/specs/2026-07-15-tired-pc-design.md)

## License

TBD
