# 部署 tired-agent 为系统服务

将 agent 作为受管服务运行，实现**开机自启**与**崩溃自动重启**。两个平台的脚本都让 agent 运行在**前台**（不要用 `-D`），由服务管理器负责生命周期。

## Linux (systemd)

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

## Windows (nssm)

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

### 无 nssm 的回退方案（schtasks，仅开机自启，无崩溃重启）

```powershell
schtasks /Create /TN tired-agent /SC ONSTART /RL HIGHEST /RU SYSTEM `
  /TR "\"C:\Program Files\nodejs\node.exe\" \"C:\path\to\dist\cli.js\" start"
```

> 注意：不要在服务脚本里传 `--daemon` / `-D`。守护化交给 systemd / nssm，agent 必须留在前台，服务管理器才能监督它。
