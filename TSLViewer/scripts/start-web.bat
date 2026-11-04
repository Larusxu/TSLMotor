@echo off
setlocal
rem Start the web development server without building the desktop application.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo Web server exited with code %RC%. See the message above.
    pause
)
endlocal & exit /b %RC%
