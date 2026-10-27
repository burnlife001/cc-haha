# fix-cc-haha-h5.ps1 — cc-haha H5 局域网访问：自动检测端口并配置 Windows 防火墙
# 用法：右键「使用 PowerShell 运行」；或在 PowerShell 里执行本文件。

$ErrorActionPreference = 'Stop'
$RuleBaseName = 'cc-haha H5'

# ---------------- 自动提权 ----------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限，正在请求提升...' -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit
}

# ---------------- 端口探测 ----------------
function Get-ClaudeConfigDir {
    if ($env:CLAUDE_CONFIG_DIR) { return $env:CLAUDE_CONFIG_DIR }
    return Join-Path $env:USERPROFILE '.claude'
}

function Get-FixedPort {
    $settingsPath = Join-Path (Get-ClaudeConfigDir) 'cc-haha\settings.json'
    if (-not (Test-Path $settingsPath)) { return $null }
    try {
        $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
        $port = $json.h5Access.fixedPort
        if ($port -is [int] -and $port -ge 1024 -and $port -le 65535) { return $port }
    } catch {}
    return $null
}

function Get-LastPort {
    $statePath = Join-Path (Get-ClaudeConfigDir) 'desktop-server-state.json'
    if (-not (Test-Path $statePath)) { return $null }
    try {
        $json = Get-Content $statePath -Raw | ConvertFrom-Json
        if ($json.lastPort -is [int]) { return $json.lastPort }
    } catch {}
    return $null
}

function Find-H5Listener {
    # 返回 @{ Port; Bind; Pid; Name } 或 $null
    $candidates = @()
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
        $_.LocalAddress -in @('0.0.0.0', '127.0.0.1', '::', '::1')
    }
    foreach ($l in $listeners) {
        $proc = Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue
        if ($null -eq $proc) { continue }
        if ($proc.Name -notlike 'claude-sidecar*' -and $proc.Name -notlike '*Claude Code Haha*') { continue }
        $candidates += [pscustomobject]@{
            Port = $l.LocalPort
            Bind = $l.LocalAddress
            Pid  = $l.OwningProcess
            Name = $proc.Name
        }
    }
    if ($candidates.Count -eq 0) { return $null }

    $fixed = Get-FixedPort
    if ($fixed) {
        $hit = $candidates | Where-Object { $_.Port -eq $fixed } | Select-Object -First 1
        if ($hit) { return $hit }
    }
    $last = Get-LastPort
    if ($last) {
        $hit = $candidates | Where-Object { $_.Port -eq $last } | Select-Object -First 1
        if ($hit) { return $hit }
    }
    $hit = $candidates | Where-Object { $_.Bind -in @('0.0.0.0', '::') } | Select-Object -First 1
    if ($hit) { return $hit }
    return $candidates | Select-Object -First 1
}

function Get-PreferredLanIp {
    $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[0-1])\.)' -and -not ($_.InterfaceAlias -match '(?i)wsl|docker|hyper|vmware|virtual') } |
        ForEach-Object { $_.IPAddress }
    if ($ips -match '^192\.168\.') { return ($ips -match '^192\.168\.')[0] }
    if ($ips) { return $ips[0] }
    return $null
}

# ---------------- 防火墙操作 ----------------
function Ensure-H5Rule([int]$Port) {
    $name = "$RuleBaseName (TCP $Port)"
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-NetFirewallRule -Name $_.Name }
    New-NetFirewallRule -DisplayName $name `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
        -RemoteAddress LocalSubnet -Profile Any `
        -Description 'cc-haha H5 局域网访问（fix-cc-haha-h5.ps1 生成）' | Out-Null
}

function Get-PortBlockers([int]$Port) {
    Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True -ErrorAction SilentlyContinue |
        ForEach-Object {
            $rule = $_
            $pf = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
            if ($null -eq $pf) { return }
            $ports = @($pf.LocalPort)
            if (($pf.Protocol -in @('6', '256')) -and ($ports -contains $Port -or $ports -contains 'Any')) {
                [pscustomobject]@{ DisplayName = $rule.DisplayName; Name = $rule.Name }
            }
        }
}

function Show-Status {
    Write-Host ''
    Write-Host '================ 当前状态 ================' -ForegroundColor Cyan
    $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
    foreach ($p in $profiles) {
        Write-Host ("网络 [{0}] 类别: {1}" -f $p.InterfaceAlias, $p.NetworkCategory)
    }
    $lanIp = Get-PreferredLanIp
    if ($lanIp) { Write-Host "本机局域网 IP: $lanIp" }

    $listener = Find-H5Listener
    if ($null -eq $listener) {
        Write-Host '未检测到 cc-haha 服务监听。请先在桌面 App 里打开 H5 访问，再重跑本脚本。' -ForegroundColor Yellow
        return @{ Listener = $null; Port = (Get-FixedPort) }
    }
    Write-Host ("服务监听: {0}:{1}  (进程 {2}, PID {3})" -f $listener.Bind, $listener.Port, $listener.Name, $listener.Pid)
    if ($listener.Bind -in @('127.0.0.1', '::1')) {
        Write-Host '警告：服务只绑定在回环地址上，防火墙放行也没用。请通过安装版桌面 App 启动（它默认绑定 0.0.0.0），不要从源码 CLI 直接起服务。' -ForegroundColor Red
    }
    return @{ Listener = $listener; Port = $listener.Port }
}

function Invoke-Fix {
    Clear-Host
    Write-Host '================ 自动修复 ================' -ForegroundColor Cyan
    $status = Show-Status
    $port = $status.Port
    if (-not $port) {
        Write-Host '拿不到端口，跳过防火墙配置。' -ForegroundColor Yellow
        return
    }

    try {
        Ensure-H5Rule -Port $port
        Write-Host "已创建/更新入站放行规则: $RuleBaseName (TCP $port)，范围 LocalSubnet，专用+公用网络都生效。" -ForegroundColor Green
    } catch {
        Write-Host "创建规则失败: $($_.Exception.Message)" -ForegroundColor Red
        return
    }

    $blockers = @(Get-PortBlockers -Port $port)
    if ($blockers.Count -gt 0) {
        Write-Host ''
        Write-Host "注意：发现 $($blockers.Count) 条针对该端口的「阻止」规则（阻止优先级高于允许），可用菜单 2 禁用：" -ForegroundColor Yellow
        $blockers | ForEach-Object { Write-Host "  - $($_.DisplayName)" }
    }

    $lanIp = Get-PreferredLanIp
    if ($lanIp) {
        Write-Host ''
        Write-Host "手机测试：连同一 Wi-Fi 后打开完整令牌链接，地址部分应为  http://$lanIp`:$port" -ForegroundColor Green
    }
    Write-Host '提示：端口若未固定，App 重启后可能变化。建议在 设置 → H5 访问 设固定端口，防火墙规则和书签都更稳定。'
}

function Invoke-DisableBlockers {
    Clear-Host
    Write-Host '================ 禁用阻止规则 ================' -ForegroundColor Cyan
    $port = (Show-Status).Port
    if (-not $port) { return }
    $blockers = @(Get-PortBlockers -Port $port)
    if ($blockers.Count -eq 0) {
        Write-Host '该端口没有阻止规则。'
        return
    }
    Write-Host "将禁用以下 $($blockers.Count) 条入站阻止规则（TCP $port）："
    $blockers | ForEach-Object { Write-Host "  - $($_.DisplayName)" }
    $confirm = Read-Host '确认禁用？[y/N]'
    if ($confirm -eq 'y') {
        $blockers | ForEach-Object { Disable-NetFirewallRule -Name $_.Name }
        Write-Host '已禁用。' -ForegroundColor Green
    } else {
        Write-Host '已取消。'
    }
}

function Invoke-PrivateProfile {
    Clear-Host
    Write-Host '================ 切换网络为「专用」 ================' -ForegroundColor Cyan
    $public = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
    if (-not $public) {
        Write-Host '当前没有「公用」网络，无需切换。'
        return
    }
    $public | ForEach-Object { Write-Host "  - $($_.InterfaceAlias) ($($_.Name))" }
    $confirm = Read-Host '把以上网络切换为「专用」（家庭网络推荐）？[y/N]'
    if ($confirm -eq 'y') {
        $public | Set-NetConnectionProfile -NetworkCategory Private
        Write-Host '已切换。' -ForegroundColor Green
    } else {
        Write-Host '已取消。'
    }
}

# ---------------- 主流程：先自动修一次，再进菜单 ----------------
Invoke-Fix

while ($true) {
    Write-Host ''
    Write-Host '================ cc-haha H5 防火墙工具 ================' -ForegroundColor Cyan
    Write-Host '1. 重新检测并重置放行规则'
    Write-Host '2. 列出并禁用该端口的阻止规则'
    Write-Host '3. 把当前网络从「公用」切换为「专用」'
    Write-Host '0. exit'
    $choice = Read-Host '请选择'
    switch ($choice) {
        '1' { Invoke-Fix }
        '2' { Invoke-DisableBlockers }
        '3' { Invoke-PrivateProfile }
        '0' { exit }
        default { Write-Host '无效选择。' -ForegroundColor Yellow }
    }
}
