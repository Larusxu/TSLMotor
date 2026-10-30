<#
.SYNOPSIS
    启动 TSL Viewer 上位机。

.DESCRIPTION
    直接运行已构建好的 src-tauri/target/release/tslviewer.exe，不做任何编译、不打包、不起前端服务。
    不带参数即可。需要重新构建时请在 TSLViewer 目录手动执行：npm run app:exe

.EXAMPLE
    .\scripts\start.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Exe  = Join-Path $Root 'src-tauri\target\release\tslviewer.exe'

if (-not (Test-Path $Exe)) {
    Write-Host "[x] 未找到 $Exe" -ForegroundColor Red
    Write-Host '    请先在 TSLViewer 目录执行 npm run app:exe 生成程序。' -ForegroundColor Yellow
    exit 1
}

Write-Host '==> 启动 TSL Viewer…' -ForegroundColor Cyan
$proc = Start-Process -FilePath $Exe -WorkingDirectory $Root -PassThru
Write-Host "[ok] 已启动（PID $($proc.Id)）：$Exe" -ForegroundColor Green