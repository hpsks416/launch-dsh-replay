@echo off
rem One-click installer wrapper for launch-dsh-replay (Windows).
rem Pure ASCII on purpose: cmd.exe parses this file in the OEM code page.
setlocal
where powershell >nul 2>&1
if errorlevel 1 goto nops
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set RC=%errorlevel%
echo.
if not "%RC%"=="0" echo [INSTALL FAILED] exit code %RC%
pause
exit /b %RC%
:nops
echo [ERROR] Windows PowerShell not found.
pause
exit /b 1
