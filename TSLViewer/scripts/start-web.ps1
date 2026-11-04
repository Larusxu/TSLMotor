<#
.SYNOPSIS
    Start the TSLViewer web frontend with live source updates.
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
Write-Host 'Web preview uses the browser environment; native Tauri motor control requires the desktop backend.' -ForegroundColor Yellow

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
