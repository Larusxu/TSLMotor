@echo off
chcp 65001 >nul
setlocal
rem 双击启动 TSL Viewer（直接运行已构建的 tslviewer.exe，不编译、不打包）
set "RC=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo TSL Viewer 启动失败，退出码 %RC%。请查看上面的提示。
    pause
)
endlocal & exit /b %RC%