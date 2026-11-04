@echo off
chcp 65001 >nul
setlocal
rem 构建 TSL Viewer。参数原样传给 build.ps1：
rem   build.bat              只构建 exe（不打包）
rem   build.bat -Test        先跑单测再构建
rem   build.bat -Bundle      同时生成 NSIS 安装包
rem   build.bat -Clean       先清 dist 与 release 产物
rem   build.bat -StopRunning 自动关闭正在运行的 TSL Viewer
rem   build.bat -Launch      构建完成后直接启动
set "RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo 构建失败，退出码 %RC%。请查看上面的报错与 build-logs 里的日志。
    pause
)
endlocal & exit /b %RC%