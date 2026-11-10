@echo off
chcp 65001 >nul
setlocal
rem 打包 TSL Viewer 的 NSIS 安装包。参数原样传给 package.ps1：
rem   package.bat              生成 NSIS 安装包
rem   package.bat -Test        先跑单测，通过才打包
rem   package.bat -Clean       先清 dist 与 release 产物
rem   package.bat -StopRunning 自动关闭正在运行的 TSL Viewer
set "RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0package.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo 打包失败，退出码 %RC%。请查看上面的报错与 build-logs 里的日志。
    pause
)
endlocal & exit /b %RC%
