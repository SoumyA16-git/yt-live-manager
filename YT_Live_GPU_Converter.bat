@echo off
setlocal
title YT Live Manager - RTX 4070 Super Converter

echo.
echo ==========================================
echo    YT LIVE MANAGER - GPU CONVERTER
echo    NVIDIA RTX 4070 SUPER NVENC
echo ==========================================
echo.

set "INPUT="

for /f "delims=" %%F in ('powershell -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='Video files|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|All files|*.*'; if($d.ShowDialog() -eq 'OK'){[Console]::WriteLine($d.FileName)}"') do set "INPUT=%%F"

if not defined INPUT (
    echo No video selected.
    pause
    exit /b
)

for %%A in ("%INPUT%") do (
    set "DIR=%%~dpA"
    set "NAME=%%~nA"
)

set "OUTPUT=%DIR%%NAME%_YT1080x1920.mp4"

echo.
echo Input:
echo "%INPUT%"
echo.
echo Output:
echo "%OUTPUT%"
echo.
echo NVIDIA NVENC encoding started...
echo.

ffmpeg -hide_banner -hwaccel cuda -i "%INPUT%" ^
-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ^
-c:v h264_nvenc ^
-profile:v high ^
-pix_fmt yuv420p ^
-r 30 ^
-g 60 ^
-keyint_min 60 ^
-b:v 4M ^
-maxrate 4M ^
-bufsize 8M ^
-c:a aac ^
-b:a 128k ^
-ar 48000 ^
-ac 2 ^
-movflags +faststart ^
"%OUTPUT%"

echo.

if errorlevel 1 (
    echo ==========================================
    echo          CONVERSION FAILED
    echo ==========================================
) else (
    echo ==========================================
    echo         CONVERSION COMPLETE
    echo ==========================================
    echo.
    echo Saved:
    echo "%OUTPUT%"
)

echo.
pause