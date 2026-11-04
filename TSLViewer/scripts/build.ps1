<#
.SYNOPSIS
    构建 TSL Viewer（默认只出 exe，不打安装包）。

.DESCRIPTION
    一条命令完成前端产物 + Rust release 编译，并把全部输出同时写进 build-logs\。
    默认调用 `npm run app:exe`（= tauri build --no-bundle）：
      tsc --noEmit → vite build → cargo build --release，只产出
      src-tauri\target\release\tslviewer.exe，不生成 msi/nsis。

    带 -Bundle 时才调用 `npm run app:build`（tauri build，含 NSIS 安装包）。

.PARAMETER Bundle
    同时生成 Windows 安装包（NSIS），落在 src-tauri\target\release\bundle\nsis\。

.PARAMETER Test
    编译前先跑 `cargo test --lib`（协议/编解码单测），失败则不继续构建。

.PARAMETER Clean
    先删除 dist\ 与 release 下的 tslviewer.exe / bundle\，强制重建前端与程序。
    不执行 `cargo clean`：那会把所有依赖一起删掉，下次要重编十几分钟。

.PARAMETER StopRunning
    若 tslviewer.exe 正在运行（会锁住 exe 导致链接失败），先结束它再构建。

.PARAMETER Launch
    构建成功后直接启动新程序。

.EXAMPLE
    .\scripts\build.ps1
    只构建 exe（日常改完代码用这个）。

.EXAMPLE
    .\scripts\build.ps1 -Test -Launch
    先跑单测，通过后构建并启动。

.EXAMPLE
    .\scripts\build.ps1 -Bundle
    构建并生成安装包（发版用）。
#>
[CmdletBinding()]
param(
    [switch]$Bundle,
    [switch]$Test,
    [switch]$Clean,
    [switch]$StopRunning,
    [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Exe       = Join-Path $Root 'src-tauri\target\release\tslviewer.exe'
$DistDir   = Join-Path $Root 'dist'
$BundleDir = Join-Path $Root 'src-tauri\target\release\bundle'
$LogDir    = Join-Path $Root 'build-logs'
$NpmScript = if ($Bundle) { 'app:build' } else { 'app:exe' }
$Total     = [Diagnostics.Stopwatch]::StartNew()

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[ok] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Yellow }

function Fail([string]$Text) {
    Write-Host "[x] $Text" -ForegroundColor Red
    exit 1
}

# npm.ps1 在脚本上下文里会从 $MyInvocation.Statement 重建参数，把
# "npm run app:exe" 截成 "pm run app:exe"，所以一律显式调 npm.cmd。
function Get-NpmCommand {
    $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command 'npm' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# 构建输出先攒起来，结束时统一打印，并原样落盘，便于贴出来排查链接错误。
$Transcript = New-Object System.Collections.Generic.List[string]
function Add-Line([string]$Text) {
    $Transcript.Add($Text)
    Write-Host $Text
}

# npm / cargo 会把进度和信息写到 stderr。$ErrorActionPreference='Stop' 下 PowerShell 会把
# 这些行当成终止错误（NativeCommandError），所以调用外部命令时临时降到 Continue。
function Invoke-Native([string]$File, [string[]]$Arguments, [string]$WorkDir) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location $WorkDir
    try {
        & $File @Arguments 2>&1 | ForEach-Object {
            # stderr 行到这里是 ErrorRecord，直接 [string] 只会得到异常类型名，
            # 要取 .Exception.Message 才是原始文本。
            if ($_ -is [System.Management.Automation.ErrorRecord]) {
                Add-Line ([string]$_.Exception.Message)
            } else {
                Add-Line ([string]$_)
            }
        }
        return $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $prev
    }
}

Write-Host ''
Write-Host ' TSL Viewer · build ' -ForegroundColor Black -BackgroundColor Cyan
Write-Host " 项目目录 : $Root"
Write-Host " 构建命令 : npm run $NpmScript"
Write-Host ''

# ---------------------------------------------------------------- toolchain
$npm = Get-NpmCommand
if (-not $npm) { Fail '未找到 npm。请安装 Node.js 18+（https://nodejs.org/）后重开终端。' }
foreach ($tool in @('node', 'cargo')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Fail "未找到 $tool。cargo 缺失请装 Rust 工具链（https://rustup.rs/）。"
    }
}
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Warn '缺少 node_modules，正在安装前端依赖…'
    $ciCode = Invoke-Native $npm @('ci') $Root
    if ($ciCode -ne 0) {
        Write-Warn "npm ci 失败（$ciCode），改用 npm install"
        $ciCode = Invoke-Native $npm @('install') $Root
    }
    if ($ciCode -ne 0) { Fail "前端依赖安装失败（$ciCode）" }
}

# ------------------------------------------------------------ running app
$running = @(Get-Process tslviewer -ErrorAction SilentlyContinue)
if ($running.Count) {
    $list = ($running | ForEach-Object { "PID $($_.Id)" }) -join ', '
    if ($StopRunning) {
        Write-Step "正在运行的 TSL Viewer 会锁住 exe，先结束：$list"
        $running | ForEach-Object { Stop-Process -Id $_.Id -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
        $left = @(Get-Process tslviewer -ErrorAction SilentlyContinue)
        if ($left.Count) { Fail '结束进程失败，请手动关闭 TSL Viewer 后重试。' }
    } else {
        Write-Host "[x] TSL Viewer 正在运行（$list），会锁住 target\release\tslviewer.exe 导致链接失败。" -ForegroundColor Red
        Write-Host '    关掉窗口后重试，或加 -StopRunning 让脚本自动关闭。' -ForegroundColor Yellow
        exit 1
    }
}

# ------------------------------------------------------------------ clean
if ($Clean) {
    Write-Step '清理旧产物（dist、release\tslviewer.exe、bundle）'
    if (Test-Path $DistDir) { Remove-Item $DistDir -Recurse -Force }
    if (Test-Path $Exe) { Remove-Item $Exe -Force }
    if (Test-Path $BundleDir) { Remove-Item $BundleDir -Recurse -Force }
}

# ------------------------------------------------------------------- test
if ($Test) {
    Write-Step '运行 Rust 单测（cargo test --lib）'
    $testWatch = [Diagnostics.Stopwatch]::StartNew()
    $testCode = Invoke-Native 'cargo' @('test', '--lib') (Join-Path $Root 'src-tauri')
    $testWatch.Stop()
    if ($testCode -ne 0) { Fail "单测未通过（退出码 $testCode），已停止构建。" }
    Write-Ok ("单测通过，用时 {0:N0} 秒" -f $testWatch.Elapsed.TotalSeconds)
}

# ------------------------------------------------------------------ build
Write-Step "构建中（$NpmScript）…"
$buildWatch = [Diagnostics.Stopwatch]::StartNew()
$buildCode = Invoke-Native $npm @('run', $NpmScript) $Root
$buildWatch.Stop()

New-Item -ItemType Directory -Force $LogDir | Out-Null
$log = Join-Path $LogDir ("build-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Set-Content -Path $log -Value $Transcript -Encoding UTF8

if ($buildCode -ne 0) {
    Fail "构建失败（退出码 $buildCode）。完整输出：$log"
}

# ---------------------------------------------------------------- artifacts
if (-not (Test-Path $Exe)) { Fail "构建结束但未找到 $Exe（日志：$log）" }
$exe = Get-Item $Exe
Write-Ok ("已生成 {0}" -f $exe.FullName)
Write-Host ("     {0:N2} MB · {1}" -f ($exe.Length / 1MB), $exe.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ("     编译用时 {0:N0} 秒，日志 {1}" -f $buildWatch.Elapsed.TotalSeconds, $log)

if ($Bundle) {
    $installers = @(Get-ChildItem $BundleDir -Recurse -File -Include *.exe, *.msi -ErrorAction SilentlyContinue)
    if ($installers.Count) {
        $installers | ForEach-Object {
            Write-Ok ("安装包 {0}（{1:N2} MB）" -f $_.FullName, ($_.Length / 1MB))
        }
    } else {
        Write-Warn "未找到安装包，检查 $BundleDir"
    }
}

$Total.Stop()

if ($Launch) {
    Write-Step '启动 TSL Viewer…'
    $proc = Start-Process -FilePath $Exe -WorkingDirectory $Root -PassThru
    Write-Ok "已启动（PID $($proc.Id)）"
} else {
    Write-Host ' 启动：.\scripts\start.ps1' -ForegroundColor DarkGray
}

Write-Host (" 总用时 {0:N0} 秒" -f $Total.Elapsed.TotalSeconds) -ForegroundColor DarkGray