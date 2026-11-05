<#
.SYNOPSIS
    launch-dsh-replay 安装器 / 卸载器（Windows）。
.DESCRIPTION
    把当前目录（解压后的包）安装到目标目录，校验 Node 版本，跑自检，
    可选创建桌面快捷方式「DSH 会话回放」和 ~/.dsh 转发入口。可完全卸载。
.PARAMETER Target
    安装目录，默认 %LOCALAPPDATA%\launch-dsh-replay。
.PARAMETER DesktopDir
    桌面目录（用于快捷方式），默认取系统桌面（可能被 OneDrive 重定向）。
.PARAMETER DshLauncherDir
    DSH 主目录（放转发入口 launch-dsh-replay.cmd），默认 ~/.dsh；目录不存在则跳过。
.PARAMETER Minimal
    只安装文件，不创建快捷方式/转发入口。
.PARAMETER NoTest
    跳过安装后的自检（默认会跑 tests/smoke.mjs，必须 8/8 通过）。
.PARAMETER Icon
    快捷方式图标路径（默认：存在 ~/.dsh/dsh.ico 就用它，否则用系统默认）。
.PARAMETER Uninstall
    卸载：移除快捷方式与转发入口；加 -Force 才删除安装目录。
.PARAMETER Force
    强制（卸载时删除安装目录；覆盖已有转发入口时备份旧文件）。
.EXAMPLE
    .\install.cmd
    .\install.cmd -Minimal
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -Force
#>
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'launch-dsh-replay'),
    [string]$DesktopDir = [Environment]::GetFolderPath('Desktop'),
    [string]$DshLauncherDir = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$Minimal,
    [switch]$NoTest,
    [string]$Icon,
    [switch]$Uninstall,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$ShortcutName = 'DSH 会话回放.lnk'
$ForwarderName = 'launch-dsh-replay.cmd'
$ServerScript = 'dsh-replay-web.mjs'
$MinNode = [version]'22.19.0'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Fail([string]$text) { Write-Host "[FAILED] $text" -ForegroundColor Red; exit 1 }

function Get-NodeExe {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { Fail '没有找到 node.exe。请先安装 Node.js >= 22.19（https://nodejs.org）。' }
    return $command.Source
}

function Test-NodeReady([string]$nodeExe) {
    $raw = (& $nodeExe --version 2>$null)
    if (-not $raw) { Fail 'node --version 执行失败。' }
    $version = [version]($raw.Trim().TrimStart('v'))
    if ($version -lt $MinNode) { Fail "Node 版本过低：$version（需要 >= $MinNode）。请升级 Node.js。" }
    $zstd = (& $nodeExe -e "process.stdout.write(typeof require('node:zlib').zstdDecompressSync)" 2>$null)
    if ($zstd -ne 'function') { Fail "当前 Node ($version) 没有内置 zstd，无法解析会话日志。请升级到 Node >= 22.19。" }
    Write-Ok "Node $version，内置 zstd 可用"
}

function Get-ShortcutPath { return (Join-Path $DesktopDir $ShortcutName) }
function Get-ForwarderPath { return (Join-Path $DshLauncherDir $ForwarderName) }

function New-DesktopShortcut([string]$nodeExe) {
    if (-not (Test-Path -LiteralPath $DesktopDir)) { Write-Warn "桌面目录不存在，跳过快捷方式：$DesktopDir"; return }
    $shortcutPath = Get-ShortcutPath
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\cmd.exe')
    $shortcut.Arguments = "/k `"$nodeExe`" `"$(Join-Path $Target $ServerScript)`""
    $shortcut.WorkingDirectory = $Target
    $shortcut.Description = 'DSH 会话回放（离线、只读）'
    if ($Icon) {
        if (Test-Path -LiteralPath $Icon) { $shortcut.IconLocation = $Icon }
        else { Write-Warn "图标不存在，使用默认图标：$Icon" }
    } elseif (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.dsh\dsh.ico')) {
        $shortcut.IconLocation = (Join-Path $env:USERPROFILE '.dsh\dsh.ico')
    }
    $shortcut.Save()
    Write-Ok "桌面快捷方式：$shortcutPath"
}

function New-DshForwarder {
    if (-not (Test-Path -LiteralPath $DshLauncherDir)) { Write-Warn "未发现 DSH 目录，跳过转发入口：$DshLauncherDir"; return }
    $forwarderPath = Get-ForwarderPath
    if (Test-Path -LiteralPath $forwarderPath) {
        $existing = Get-Content -LiteralPath $forwarderPath -Raw -ErrorAction SilentlyContinue
        if ($existing -notmatch [regex]::Escape($Target)) {
            $backup = "$forwarderPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
            Copy-Item -LiteralPath $forwarderPath -Destination $backup -Force
            Write-Warn "已有转发入口已备份：$backup"
        }
    }
    $scriptPath = (Join-Path $Target $ServerScript)
    $body = @"
@echo off
rem Forward to the launch-dsh-replay install at $Target
chcp 65001 >nul
title DSH Session Replay
cd /d "$Target"
node "$scriptPath" %*
if errorlevel 1 pause
"@
    Set-Content -LiteralPath $forwarderPath -Value $body -Encoding ASCII
    Write-Ok "DSH 转发入口：$forwarderPath"
}

function Remove-Integrations {
    $shortcutPath = Get-ShortcutPath
    if (Test-Path -LiteralPath $shortcutPath) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $isOurs = ($shortcut.Arguments -like "*$Target*") -or ($shortcut.WorkingDirectory -eq $Target)
        if ($isOurs) { Remove-Item -LiteralPath $shortcutPath -Force; Write-Ok "已删除快捷方式：$shortcutPath" }
        else { Write-Warn "快捷方式不属于本安装，保留：$shortcutPath" }
    }
    $forwarderPath = Get-ForwarderPath
    if (Test-Path -LiteralPath $forwarderPath) {
        $content = Get-Content -LiteralPath $forwarderPath -Raw -ErrorAction SilentlyContinue
        if ($content -match [regex]::Escape($Target)) { Remove-Item -LiteralPath $forwarderPath -Force; Write-Ok "已删除转发入口：$forwarderPath" }
        else { Write-Warn "转发入口不属于本安装，保留：$forwarderPath" }
    }
}

function Copy-Payload {
    if ((Resolve-Path -LiteralPath $Target -ErrorAction SilentlyContinue) -eq $Source) {
        Fail '安装目录不能与包目录相同。请指定 -Target 到其他目录。'
    }
    $excludeDirs = @('dist', '.git', 'node_modules', '.pnpm-store')
    $excludeFiles = @('*.zip', '*.replay.html')
    $result = robocopy $Source $Target /E /NFL /NDL /NJH /NJS /NP /XD @excludeDirs /XF @excludeFiles
    $code = $LASTEXITCODE
    if ($code -ge 8) { Fail "复制文件失败（robocopy 退出码 $code）。" }
    $LASTEXITCODE = 0
    Write-Ok "已复制到：$Target"
}

function Run-SelfTest([string]$nodeExe) {
    $testScript = Join-Path $Target 'tests\smoke.mjs'
    if (-not (Test-Path -LiteralPath $testScript)) { Fail '安装目录里缺少 tests\smoke.mjs，包不完整。' }
    Write-Step '运行自检（tests/smoke.mjs）'
    $output = & $nodeExe $testScript 2>&1
    $code = $LASTEXITCODE
    $output | ForEach-Object { Write-Host "    $_" }
    if ($code -ne 0) { Fail '自检未通过，安装中止。请检查 Node 版本后重试（或 -NoTest 跳过）。' }
    Write-Ok '自检通过'
}

Write-Host ''
Write-Host '  launch-dsh-replay 安装器' -ForegroundColor White
Write-Host '  离线、只读的 DSH 会话回放（v4 桌面端 / v3 旧 WEB）' -ForegroundColor DarkGray
Write-Host ''

if ($Uninstall) {
    Write-Step '卸载'
    Remove-Integrations
    if (Test-Path -LiteralPath $Target) {
        if ($Force) { Remove-Item -LiteralPath $Target -Recurse -Force; Write-Ok "已删除安装目录：$Target" }
        else { Write-Warn "未加 -Force，保留安装目录：$Target（可手动删除）" }
    } else { Write-Warn "安装目录不存在：$Target" }
    Write-Host ''
    Write-Host '卸载完成。' -ForegroundColor Green
    exit 0
}

Write-Step '检查 Node.js'
$nodeExe = Get-NodeExe
Test-NodeReady $nodeExe

Write-Step '复制文件'
Copy-Payload

if (-not $NoTest) { Run-SelfTest $nodeExe } else { Write-Warn '已按 -NoTest 跳过自检' }

if (-not $Minimal) {
    Write-Step '创建快捷方式与转发入口'
    New-DesktopShortcut $nodeExe
    New-DshForwarder
} else {
    Write-Warn '已按 -Minimal 跳过快捷方式/转发入口'
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "  安装目录：$Target"
Write-Host "  启动引导页：node `"$Target\$ServerScript`""
Write-Host '  引导页地址：http://127.0.0.1:7781/'
Write-Host '  卸载：install.cmd -Uninstall -Force'
Write-Host ''
exit 0
