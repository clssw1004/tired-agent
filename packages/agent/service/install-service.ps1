# install-service.ps1 — install tired-agent as a Windows service via nssm.
#
# Requires: nssm (https://nssm.cc/) on PATH, and `tired-agent` installed
# (npm i -g @tired-agent/agent) or a known path to dist/cli.js.
#
# nssm supervises the process: auto-restart on crash + start on boot
# (Startup type = Automatic). The agent runs in the FOREGROUND (no -D);
# nssm owns the lifecycle.
#
# ── Usage (run in an elevated PowerShell) ───────────────────────────────
#   ./install-service.ps1                       # uses `tired-agent` on PATH
#   ./install-service.ps1 -RegisterArg "<base64>"   # auto-register on start
#   ./install-service.ps1 -Node "C:\Program Files\nodejs\node.exe" `
#                         -Script "C:\path\to\packages\agent\dist\cli.js"
#
# ── Manage ──────────────────────────────────────────────────────────────
#   nssm status  tired-agent
#   nssm restart tired-agent
#   nssm remove  tired-agent confirm     # uninstall
#
# ── No nssm? schtasks fallback (boot autostart only, no crash-restart) ──
#   schtasks /Create /TN tired-agent /SC ONSTART /RL HIGHEST /RU SYSTEM `
#     /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\dist\cli.js\" start"

param(
  [string]$ServiceName = "tired-agent",
  [string]$Node = "",
  [string]$Script = "",
  [string]$RegisterArg = ""
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Error "nssm not found on PATH. Install from https://nssm.cc/ or use the schtasks fallback (see header)."
  exit 1
}

# Resolve how to launch the agent.
if ($Node -and $Script) {
  $app  = $Node
  $args = "`"$Script`" start"
} else {
  $cmd = Get-Command tired-agent -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Error "tired-agent not found on PATH. Install with 'npm i -g @tired-agent/agent' or pass -Node and -Script."
    exit 1
  }
  $app  = $cmd.Source
  $args = "start"
}

if ($RegisterArg) {
  $args = "$args --register `"$RegisterArg`""
}

Write-Host "Installing service '$ServiceName' -> $app $args"

# Remove any prior instance so the script is idempotent.
nssm stop   $ServiceName 2>$null | Out-Null
nssm remove $ServiceName confirm 2>$null | Out-Null

nssm install $ServiceName $app $args
nssm set $ServiceName Start SERVICE_AUTO_START
# Restart on exit, throttle to avoid crash loops.
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 3000
nssm set $ServiceName AppThrottle 5000

nssm start $ServiceName
Write-Host "Done. Manage with: nssm status $ServiceName"
