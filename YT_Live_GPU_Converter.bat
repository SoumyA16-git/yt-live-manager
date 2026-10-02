@echo off
setlocal
title YT Live Manager - Smart GPU Converter

where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo [ERROR] FFmpeg was not found in your PATH.
    echo Please ensure FFmpeg is installed and accessible in cmd.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0YT_Live_GPU_Converter.ps1"