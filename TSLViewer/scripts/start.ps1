<#
.SYNOPSIS
    启动 TSL Viewer 上位机。

.DESCRIPTION
    直接运行已构建好的 src-tauri/target/release/tslviewer.exe，不做任何编译、不打包、不起前端服务。
    不带参数即可。需要重新构建时请在 TSLViewer 目录手动执行：npm run app:exe
    若 src/ 或 src-tauri/src/ 里有文件比 exe 新，会打印一行黄色提示（仅提示，不编译）。

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

# 源码比 exe 新时提醒一句（不自动编译，保持"直接打开"的语义）
$newest = @(
    (Join-Path $Root 'src'),
    (Join-Path $Root 'src-tauri\src'),
    (Join-Path $Root 'index.html'),
    (Join-Path $Root 'package.json'),
    (Join-Path $Root 'src-tauri\tauri.conf.json')
) | Where-Object { Test-Path $_ } | ForEach-Object {
    if ((Get-Item $_).PSIsContainer) { Get-ChildItem $_ -Recurse -File } else { Get-Item $_ }
} | Where-Object { $_.LastWriteTime -gt (Get-Item $Exe).LastWriteTime } | Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($newest) {
    Write-Host "[!] 源码比 exe 新（$($newest.Name)），界面/逻辑可能不是最新的。" -ForegroundColor Yellow
    Write-Host '    需要时执行：npm run app:exe  再重新运行本脚本。' -ForegroundColor Yellow
}

Write-Host '==> 启动 TSL Viewer…' -ForegroundColor Cyan
$proc = Start-Process -FilePath $Exe -WorkingDirectory $Root -PassThru
Write-Host "[ok] 已启动（PID $($proc.Id)）：$Exe" -ForegroundColor Green