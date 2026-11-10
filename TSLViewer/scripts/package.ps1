<#
.SYNOPSIS
    打包 TSL Viewer 的 Windows 安装包（NSIS）。

.DESCRIPTION
    一条命令完成：tsc 类型检查 → vite 前端产物 → cargo release 编译 → NSIS 打包。
    等价于 `npm run app:package`（= tauri build --bundles nsis），只产出 NSIS 安装包：
      src-tauri\target\release\bundle\nsis\TSL Viewer_<版本>_x64-setup.exe
    全部输出同时落盘到 build-logs\package-<时间戳>.log。

    与 build.ps1 -Bundle 的区别：本脚本只负责发版安装包，不出单文件 exe、不启动程序；
    首次打包时 Tauri 会自动下载 NSIS 工具到 %LOCALAPPDATA%\tauri，需要联网。

.PARAMETER Test
    打包前先跑 `cargo test --lib`（协议/编解码单测），失败则不继续。

.PARAMETER Clean
    先删除 dist\、release\tslviewer.exe 与 bundle\，强制重建。
    不执行 `cargo clean`：那会把所有依赖一起删掉，下次要重编十几分钟。

.PARAMETER StopRunning
    若 tslviewer.exe 正在运行（会锁住 exe 导致链接失败），先结束它再打包。

.EXAMPLE
    .\scripts\package.ps1
    直接生成 NSIS 安装包。

.EXAMPLE
    .\scripts\package.ps1 -Test -Clean -StopRunning
    发版前的干净打包：先跑单测，清旧产物，自动关掉正在运行的程序。
#>
[CmdletBinding()]
param(
    [switch]$Test,
    [switch]$Clean,
    [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Exe       = Join-Path $Root 'src-tauri\target\release\tslviewer.exe'
$DistDir   = Join-Path $Root 'dist'
$BundleDir = Join-Path $Root 'src-tauri\target\release\bundle'
$NsisDir   = Join-Path $BundleDir 'nsis'
$LogDir    = Join-Path $Root 'build-logs'
$NpmScript = 'app:package'
$Total     = [Diagnostics.Stopwatch]::StartNew()

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "[ok] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Yellow }

function Fail([string]$Text) {
    Write-Host "[x] $Text" -ForegroundColor Red
    exit 1
}

# npm.ps1 在脚本上下文里会从 $MyInvocation.Statement 重建参数，把
# "npm run app:package" 截成 "pm run app:package"，所以一律显式调 npm.cmd。
function Get-NpmCommand {
    $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command 'npm' -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# 输出先攒起来，结束时统一打印，并原样落盘，便于贴出来排查打包错误。
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
Write-Host ' TSL Viewer · package (NSIS) ' -ForegroundColor Black -BackgroundColor Cyan
Write-Host " 项目目录 : $Root"
Write-Host " 打包命令 : npm run $NpmScript"
Write-Host " 安装包到 : $NsisDir"
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
        Write-Host "[x] TSL Viewer 正在运行（$list），会锁住 target\release\tslviewer.exe 导致打包失败。" -ForegroundColor Red
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
    if ($testCode -ne 0) { Fail "单测未通过（退出码 $testCode），已停止打包。" }
    Write-Ok ("单测通过，用时 {0:N0} 秒" -f $testWatch.Elapsed.TotalSeconds)
}

# ---------------------------------------------------------------- package
Write-Step "打包中（$NpmScript，前端 + Rust release + NSIS）…"
$buildWatch = [Diagnostics.Stopwatch]::StartNew()
$buildCode = Invoke-Native $npm @('run', $NpmScript) $Root
$buildWatch.Stop()

New-Item -ItemType Directory -Force $LogDir | Out-Null
$log = Join-Path $LogDir ("package-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
Set-Content -Path $log -Value $Transcript -Encoding UTF8

if ($buildCode -ne 0) {
    Fail "打包失败（退出码 $buildCode）。完整输出：$log"
}

# ---------------------------------------------------------------- artifacts
$installers = @(Get-ChildItem $NsisDir -File -Filter *.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
if (-not $installers.Count) {
    Write-Warn "打包结束但 $NsisDir 下没有安装包，检查日志：$log"
    exit 1
}

foreach ($installer in $installers) {
    Write-Ok ("安装包 {0}" -f $installer.FullName)
    Write-Host ("     {0:N2} MB · {1}" -f ($installer.Length / 1MB), $installer.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
}
Write-Host ("     编译打包用时 {0:N0} 秒，日志 {1}" -f $buildWatch.Elapsed.TotalSeconds, $log)

$Total.Stop()
Write-Host (" 总用时 {0:N0} 秒" -f $Total.Elapsed.TotalSeconds) -ForegroundColor DarkGray
Write-Host ' 安装：双击上面的 setup.exe（按用户/机器安装由安装向导决定）' -ForegroundColor DarkGray
