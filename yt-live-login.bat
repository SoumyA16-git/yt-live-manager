@echo off
title YT Live Manager - OCI SSH
color 0A

echo ==========================================
echo    YT LIVE MANAGER - OCI LOGIN
echo ==========================================
echo.
echo Starting SSH tunnel...
echo.

ssh -i "C:\Users\Beauty Patra\Downloads\instance-20261002-0811.key" -L 8443:127.0.0.1:3000 ubuntu@80.225.240.247

echo.
echo SSH connection closed.
pause