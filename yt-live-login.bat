@echo off
title YT Live Manager - OCI SSH
color 0A

echo ==========================================
echo    YT LIVE MANAGER - OCI LOGIN (137.23.40.80)
echo ==========================================
echo Server IP: 137.23.40.80
echo Local Web UI: http://localhost:8443
echo.

set "KEY_FILE=%~dp0ssh-key-2026-10-05 (1).key"
if not exist "%KEY_FILE%" set "KEY_FILE=%USERPROFILE%\Downloads\ssh-key-2026-10-05 (1).key"
if not exist "%KEY_FILE%" set "KEY_FILE=%~dp0ssh-key-2026-10-05.key"
if not exist "%KEY_FILE%" set "KEY_FILE=%USERPROFILE%\Downloads\ssh-key-2026-10-05.key"

echo Using SSH Key: %KEY_FILE%
echo Starting SSH tunnel (Port 8443 -^> 127.0.0.1:3000)...
echo.

echo Opening http://localhost:8443 in browser...
start http://localhost:8443
ssh -i "%KEY_FILE%" -L 8443:127.0.0.1:3000 ubuntu@137.23.40.80

echo.
echo SSH connection closed.
pause