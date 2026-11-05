@echo off
rem DSH Session Replay - desktop port of the WEB launch-dsh-replay launcher.
rem Starts a local guide server on 127.0.0.1:7781 and opens the browser.
rem Pure ASCII on purpose: cmd.exe parses .cmd files in the OEM code page,
rem so non-ASCII text here would corrupt the batch lines.
chcp 65001 >nul
title DSH Session Replay
cd /d "%~dp0"
node "%~dp0dsh-replay-web.mjs" %*
if errorlevel 1 goto err
exit /b 0
:err
echo.
echo [START FAILED] review the messages above, then press any key to exit.
pause >nul
