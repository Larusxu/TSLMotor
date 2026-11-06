@echo off
setlocal
rem Start the web layout preview (browser only, no simulator, no serial backend).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-web.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo Web server exited with code %RC%. See the message above.
    pause
)
endlocal & exit /b %RC%