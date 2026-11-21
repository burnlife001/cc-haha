# cloudflared-service-install.ps1 — 把 cloudflared Named Tunnel 装成 Windows 服务（开机自启）
# 用法：右键「使用 PowerShell 运行」；或在 PowerShell 里执行本文件。
# 前提：已完成 cloudflared tunnel login + create，且 %USERPROFILE%\.cloudflared\config.yml 存在。

$ErrorActionPreference = 'Stop'

# ---------------- 自动提权 ----------------
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限，正在请求提升...' -ForegroundColor Yellow
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit
}

# ---------------- 定位用户配置 ----------------
$UserCfDir = Join-Path $env:USERPROFILE '.cloudflared'
$UserConfig = Join-Path $UserCfDir 'config.yml'
if (-not (Test-Path $UserConfig)) {
    Write-Host "找不到 $UserConfig`n请先完成：cloudflared tunnel login → cloudflared tunnel create <名字> → 写好 config.yml" -ForegroundColor Red
    Pause
    exit 1
}

$yaml = Get-Content $UserConfig -Raw
$tunnelId = [regex]::Match($yaml, '(?m)^tunnel:\s*(\S+)').Groups[1].Value
$hostname = [regex]::Match($yaml, '(?m)^\s*-\s*hostname:\s*(\S+)').Groups[1].Value
if (-not $tunnelId) {
    Write-Host 'config.yml 里缺少 tunnel: 字段，无法继续。' -ForegroundColor Red
    Pause
    exit 1
}
Write-Host "隧道: $tunnelId"
if ($hostname) { Write-Host "域名: $hostname" }

# ---------------- SYSTEM 账户的配置副本 ----------------
# 服务以 SYSTEM 运行，~ 解析到 systemprofile，读不到用户目录的配置；
# credentials-file 一并复制，并把副本里的路径改指向副本（不改动用户原文件）。
$SysCfDir = 'C:\Windows\System32\config\systemprofile\.cloudflared'
New-Item -ItemType Directory -Force $SysCfDir | Out-Null

$sysYaml = $yaml
$credMatch = [regex]::Match($yaml, '(?m)^credentials-file:\s*(\S+)')
if ($credMatch.Success) {
    $credSrc = $credMatch.Groups[1].Value
    $credName = Split-Path $credSrc -Leaf
    $credDst = Join-Path $SysCfDir $credName
    if (Test-Path $credSrc) {
        Copy-Item $credSrc $credDst -Force
        $sysYaml = $sysYaml.Replace($credMatch.Groups[1].Value, $credDst)
    } else {
        Write-Host "警告：凭证文件不存在 $credSrc" -ForegroundColor Yellow
    }
}
$sysYaml | Set-Content (Join-Path $SysCfDir 'config.yml') -Encoding UTF8 -NoNewline
Write-Host "已复制配置到 $SysCfDir" -ForegroundColor Green

# ---------------- 安装或启动服务 ----------------
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($null -eq $svc) {
    Write-Host '安装 cloudflared Windows 服务...'
    cloudflared service install
    $svc = Get-Service cloudflared -ErrorAction SilentlyContinue
} else {
    # MSI/Zero Trust 装的服务可能是 token 模式（--token-file），令牌文件
    # 缺失时启动必挂（Win32 1067）。存在本地 config.yml 就改回本地隧道模式。
    $binPath = (Get-CimInstance Win32_Service -Filter "Name='cloudflared'").PathName
    if ($binPath -match '--token-file') {
        $tokenFile = ([regex]::Match($binPath, '--token-file\s+(\S+)')).Groups[1].Value.Trim('"')
        if (-not (Test-Path $tokenFile)) {
            $exe = ([regex]::Match($binPath, '^"([^"]+)"')).Groups[1].Value
            if (-not $exe) { $exe = 'cloudflared.exe' }
            Write-Host "服务指向 token 模式但令牌文件缺失（$tokenFile），改为本地配置模式。" -ForegroundColor Yellow
            sc.exe config cloudflared binPath= "`"$exe`" tunnel run" | Out-Null
        }
    }
    Write-Host "服务已存在（状态 $($svc.Status)），直接启动。"
}
if ($svc.Status -ne 'Running') { Start-Service cloudflared }
Start-Sleep -Seconds 3
$svc = Get-Service cloudflared
Write-Host "服务状态: $($svc.Status)" -ForegroundColor $(if ($svc.Status -eq 'Running') { 'Green' } else { 'Red' })

# ---------------- 验证隧道 ----------------
if ($hostname) {
    try {
        $code = (Invoke-WebRequest -Uri "https://$hostname" -UseBasicParsing -TimeoutSec 15).StatusCode
        Write-Host "https://$hostname → HTTP $code（200 正常；若本地服务未启动也可能 502）" -ForegroundColor Green
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code) {
            Write-Host "https://$hostname → HTTP $code（502 = 隧道已通、本地服务未起；其余状态请检查配置）" -ForegroundColor Yellow
        } else {
            Write-Host "访问 https://$hostname 失败：$($_.Exception.Message)" -ForegroundColor Red
        }
    }
}
Write-Host ''
Write-Host '如需更换隧道域名：改用户 config.yml 的 hostname → 重新运行本脚本 → cloudflared tunnel route dns <名字> <新域名>' -ForegroundColor Cyan
Pause
