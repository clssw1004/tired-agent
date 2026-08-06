# 部署 tired-agent 为系统服务

将 agent 作为受管服务运行，实现**开机自启**与**崩溃自动重启**。推荐用内置的生命周期命令（跨平台），也可以手动部署。

> 关键：服务模式下 agent 必须运行在**前台**（不要用 `-D`），由系统服务管理器负责生命周期（Linux=systemd、macOS=launchd）。

## 一键生命周期命令

`tired-agent` CLI 内置完整服务生命周期（Linux=systemd 用户级、macOS=launchd；Windows 暂未支持服务化）：

| 命令 | 说明 |
|------|------|
| `tired-agent install service` | 安装为系统服务（生成配置 + enable + 开机自启 + 崩溃自愈） |
| `tired-agent uninstall service` | 卸载（默认**保留** `~/.tiredagent` 数据；`--purge` 删除数据目录） |
| `tired-agent update [版本]` | 升级服务所用 npm 包并重启（默认 `latest`） |
| `tired-agent start / stop / restart / status` | 已装服务时**自动重定向**到 systemd / launchctl |

所有破坏性命令支持 `--dry-run` 预览。

### 安装

```bash
tired-agent install service                        # Linux: systemd 用户级
tired-agent install service --register "<base64>"  # 需要自动注册到 manager 时
tired-agent install service --dry-run              # 先预览配置与命令
```

- **Linux**：写入 `~/.config/systemd/user/tired-agent.service` → `systemctl --user enable --now`，并尝试开启 `linger`（开机免登录自启；若失败会提示 `sudo loginctl enable-linger <user>`）。若端口被旧 `-D` 守护占用，**只警告不自动杀**（可能正承载当前会话），提示先 `tired-agent stop` 再 `systemctl --user restart tired-agent`。
- **macOS**：写入 `~/Library/LaunchAgents/com.tiredagent.agent.plist` → `launchctl bootstrap gui/<uid>`。登录自启；开机免登录自启需 LaunchDaemon（`sudo cp … /Library/LaunchDaemons/`）。
- **Windows**：暂不支持服务化（计划后续用计划任务 schtasks 实现；OpenClaw 亦未实现服务启动）。`install service` 会给出引导；当前可用 `tired-agent start -D` 后台运行，或手动 nssm（见下）。

### 更新（升级 npm 包并重启服务）

```bash
tired-agent update          # npm i -g @tired-agent/agent@latest + 重启服务
tired-agent update 0.2.3    # 指定版本
```

### 卸载

```bash
tired-agent uninstall service          # 停服务 + 移除配置，保留 ~/.tiredagent 数据
tired-agent uninstall service --purge  # 一并删除数据目录
```

### 管理

服务模式下请用系统服务管理器，**勿依赖 PID 文件**（服务模式下 `agent.pid` 未必存在；`tired-agent stop/restart` 已自动重定向）：

```bash
# Linux
systemctl --user status  tired-agent
systemctl --user restart tired-agent
journalctl --user -u tired-agent -f     # 跟随日志

# macOS
launchctl print gui/$UID/com.tiredagent.agent
launchctl kickstart -k gui/$UID/com.tiredagent.agent
```

---

## 手动部署

### Linux (systemd，系统级)

1. 编辑 `tired-agent.service`：把 `User=CHANGE_ME` 改成运行用户；把 `ExecStart=` 改成 `tired-agent` 的实际路径（`which tired-agent`）；按需加 `--register`/`--port` 等参数或 `Environment=` 变量。
2. 安装并启用：

   ```bash
   sudo cp tired-agent.service /etc/systemd/system/tired-agent.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now tired-agent
   ```

3. 常用管理：

   ```bash
   systemctl status tired-agent
   systemctl restart tired-agent
   journalctl -u tired-agent -f     # 跟随日志
   ```

`Restart=always` + `RestartSec=3` 保证进程异常退出后自动拉起。

### Windows (nssm)

推荐用 [nssm](https://nssm.cc/) 把 agent 包装成 Windows 服务（自带崩溃重启 + 开机自启）。在**管理员 PowerShell** 中：

```powershell
# tired-agent 已全局安装（npm i -g @tired-agent/agent）
./install-service.ps1

# 或显式指定 node 与脚本路径
./install-service.ps1 -Node "C:\Program Files\nodejs\node.exe" `
                      -Script "C:\path\to\packages\agent\dist\cli.js"

# 需要自动注册到 manager 时
./install-service.ps1 -RegisterArg "<base64>"
```

管理：

```powershell
nssm status  tired-agent
nssm restart tired-agent
nssm remove  tired-agent confirm    # 卸载
```

#### 无 nssm 的回退方案（schtasks，仅开机自启，无崩溃重启）

```powershell
schtasks /Create /TN tired-agent /SC ONSTART /RL HIGHEST /RU SYSTEM `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\dist\cli.js\" start"
```

> 注意：`packages/agent/service/*.ps1` 不在 npm 包发布范围内（`files` 只含 `dist/**`），仅供仓库内/源码部署手动使用。
