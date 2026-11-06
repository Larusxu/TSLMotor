<#
.SYNOPSIS
    Start the TSLViewer frontend in a browser for layout checks.
.DESCRIPTION
    只启动 Vite 开发服务器。上位机已不再内置任何模拟器/模拟数据，浏览器里没有串口与
    主控访问能力：页面结构、排版、主题可以看，但端口列表为空、所有硬件操作不可用。
    需要真实串口时用 scripts\start.ps1（已构建的 exe）或 npm run app:dev。
.EXAMPLE
    .\scripts\start-web.ps1
.EXAMPLE
    .\scripts\start-web.ps1 -NoOpen -Port 5184
#>
[CmdletBinding()]
param(
    [switch]$NoOpen,
    [ValidateRange(1024, 65535)]
    [int]$Port = 5183
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    Write-Host '[x] npm.cmd not found. Install Node.js and reopen this terminal.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'node_modules\vite\bin\vite.js'))) {
    Write-Host '[x] Dependencies are missing. Run npm ci in the TSLViewer directory first.' -ForegroundColor Red
    exit 1
}

Write-Host "==> TSLViewer web: http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host 'Source edits update automatically. Press Ctrl+C here to stop.'
Write-Host 'Layout only: no simulator and no serial backend in a browser. Use npm run app:dev or tslviewer.exe for hardware.' -ForegroundColor Yellow

$DevArgs = @('run', 'dev', '--', '--host', '127.0.0.1', '--port', "$Port", '--strictPort')
if (-not $NoOpen) { $DevArgs += '--open' }

Push-Location -LiteralPath $ProjectRoot
try {
    & npm.cmd @DevArgs
    $ResultCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $ResultCode