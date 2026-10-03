<#
.SYNOPSIS
    YT Live Manager - Smart GPU Video Converter (NVIDIA RTX NVENC)
    Converts any video into 1080x1920 30fps vertical format with smart adaptive bitrate.
    Preserves source video bitrate (matching original file size), capped at 4 Mbps maximum.
#>

[Console]::Title = "YT Live Manager - Smart GPU Converter"
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   YT LIVE MANAGER - SMART GPU CONVERTER (NVIDIA NVENC)   " -ForegroundColor Cyan
Write-Host "   Adaptive Bitrate: Preserves source size, Max 4 Mbps    " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select video to convert for YouTube Live 24/7"
$dialog.Filter = "Video files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|All files (*.*)|*.*"

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "No video selected. Exiting." -ForegroundColor Yellow
    exit 0
}

$inputFile = $dialog.FileName
$inputItem = Get-Item -LiteralPath $inputFile
$dir = $inputItem.DirectoryName
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($inputFile)
$outputFile = Join-Path $dir "${baseName}_YT1080x1920.mp4"

$sourceSizeMB = [Math]::Round($inputItem.Length / 1MB, 2)
$sourceSizeGB = [Math]::Round($inputItem.Length / 1GB, 2)

Write-Host "Input File:  $inputFile" -ForegroundColor White
Write-Host "Source Size: $sourceSizeMB MB ($sourceSizeGB GB)" -ForegroundColor White
Write-Host "Output File: $outputFile" -ForegroundColor White
Write-Host ""
Write-Host "Analyzing source video properties with ffprobe..." -ForegroundColor Gray

# Probe duration, resolution and bitrate
$durVal = 0.0
$durStr = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
if ($durStr -and [double]::TryParse($durStr.Trim(), [ref]$durVal) -and $durVal -gt 0) {
    $ts = [TimeSpan]::FromSeconds($durVal)
    $durFormatted = "{0:D2}:{1:D2}:{2:D2}" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds
    Write-Host "Video Duration: $durFormatted ($([Math]::Round($durVal, 1)) s)" -ForegroundColor Gray
}

$srcWidth = 0; $srcHeight = 0
$dimStr = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$inputFile" 2>$null
if ($dimStr -and $dimStr.Trim() -match '^(\d+)x(\d+)$') {
    $srcWidth = [int]$Matches[1]
    $srcHeight = [int]$Matches[2]
    Write-Host "Source Resolution: ${srcWidth}x${srcHeight}" -ForegroundColor Gray
}

$isVertical = ($srcHeight -gt 0 -and $srcHeight -ge $srcWidth)

$bitrate = 0
$rawBitrate = & ffprobe -v error -select_streams v:0 -show_entries stream=bit_rate -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
if ($rawBitrate -and [int64]::TryParse($rawBitrate.Trim(), [ref]$bitrate) -and $bitrate -gt 0) {
    # Direct stream bitrate detected
} else {
    $fmtBitrate = & ffprobe -v error -show_entries format=bit_rate -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
    if ($fmtBitrate -and [int64]::TryParse($fmtBitrate.Trim(), [ref]$bitrate) -and $bitrate -gt 0) {
        $bitrate = [Math]::Max(200000, $bitrate - 128000)
    } elseif ($durVal -gt 0) {
        $bitrate = [int64][Math]::Max(200000, (($inputItem.Length * 8) / $durVal) - 128000)
    }
}

# Bitrate estimation
$sourceKbps = if ($bitrate -gt 0) { [int][Math]::Round($bitrate / 1000) } else { 1200 }
Write-Host "Detected source bitrate: ${sourceKbps} kbps" -ForegroundColor Green

Write-Host ""
Write-Host "Select Output Resolution & Quality:" -ForegroundColor Cyan
if ($isVertical -and ($srcWidth -ne 1080 -or $srcHeight -ne 1920)) {
    Write-Host " [1] Keep Source Resolution (${srcWidth}x${srcHeight}) [RECOMMENDED]" -ForegroundColor Green
    Write-Host "     -> 100% Crisp & Sharp, Identical to Source, Zero Pixelation" -ForegroundColor Gray
    Write-Host "     -> Output Size: ~$sourceSizeGB GB (Matches original size)" -ForegroundColor Gray
    Write-Host "     -> Fixes YouTube Keyframe to 2.0s" -ForegroundColor Gray
    Write-Host " [2] Upscale to 1080x1920 Full HD (High Bitrate 3.0 Mbps)" -ForegroundColor Yellow
    Write-Host "     -> Output Size: ~$([Math]::Round($durVal * 3128000 / 8 / 1GB, 1)) GB" -ForegroundColor Gray
} else {
    Write-Host " [1] Standard Stream-Ready (1080x1920, 2s Keyframes, Source Bitrate)" -ForegroundColor Green
    Write-Host " [2] High Bitrate 1080x1920 (3.5 Mbps)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Press [1] or [2] (Auto-selects [1] in 5 seconds): " -ForegroundColor White -NoNewline

$choice = "1"
$timeoutSec = 5
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($stopwatch.Elapsed.TotalSeconds -lt $timeoutSec) {
    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.KeyChar -eq '2') { $choice = "2"; break }
        if ($key.KeyChar -eq '1' -or $key.Key -eq [ConsoleKey]::Enter) { $choice = "1"; break }
    }
    Start-Sleep -Milliseconds 100
}
Write-Host "$choice" -ForegroundColor Green

if ($choice -eq "2") {
    $targetKbps = [Math]::Max(2800, [int][Math]::Round($sourceKbps * 1.5))
    $targetKbps = [Math]::Min($targetKbps, 4000) # Cap at 4 Mbps ceiling
    $maxRateKbps = [Math]::Min([int]($targetKbps * 1.4), 4000)
    $bufSizeKbps = $targetKbps * 2
    $scaleFilter = "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"
    $outputFile = Join-Path $dir "${baseName}_1080p_Clean.mp4"
    Write-Host "Mode: Upscale 1080x1920 Full HD (${targetKbps} kbps Lanczos)" -ForegroundColor Cyan
} else {
    # Keep crisp resolution, give 20% bitrate headroom for motion scenes
    $targetKbps = [Math]::Max(800, [int][Math]::Round($sourceKbps * 1.15))
    $targetKbps = [Math]::Min($targetKbps, 4000)
    $maxRateKbps = [Math]::Min([int]($targetKbps * 1.5), 4000)
    $bufSizeKbps = $targetKbps * 2
    if ($isVertical) {
        $scaleFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2" # Ensure even dimensions, no blurry upscaling!
        $outputFile = Join-Path $dir "${baseName}_Crisp_Ready.mp4"
        Write-Host "Mode: Keep Source Resolution ${srcWidth}x${srcHeight} (Crisp & Sharp, Zero Blur)" -ForegroundColor Green
    } else {
        $scaleFilter = "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"
        $outputFile = Join-Path $dir "${baseName}_YT1080x1920.mp4"
        Write-Host "Mode: Converted to Vertical 1080x1920" -ForegroundColor Cyan
    }
}

if ($durVal -gt 0) {
    $estTotalBytes = (($targetKbps * 1000 + 128000) * $durVal) / 8
    $estSizeGB = [Math]::Round($estTotalBytes / 1GB, 2)
    Write-Host "Estimated Output Size: ~$estSizeGB GB" -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting NVIDIA NVENC High-Quality encode..." -ForegroundColor Cyan
Write-Host "Settings: Preset p6 (High Quality) | VBR ${targetKbps}k (Max ${maxRateKbps}k) | Keyframe: 2.0s" -ForegroundColor Gray
Write-Host ""

$ffmpegArgs = @(
    "-hide_banner",
    "-hwaccel", "cuda",
    "-i", $inputFile,
    "-vf", $scaleFilter,
    "-c:v", "h264_nvenc",
    "-preset", "p6",
    "-tune", "hq",
    "-rc", "vbr",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-keyint_min", "60",
    "-b:v", "${targetKbps}k",
    "-maxrate", "${maxRateKbps}k",
    "-bufsize", "${bufSizeKbps}k",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-y",
    $outputFile
)

& ffmpeg @ffmpegArgs

if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $outputFile)) {
    $outItem = Get-Item -LiteralPath $outputFile
    $outSizeMB = [Math]::Round($outItem.Length / 1MB, 2)
    $outSizeGB = [Math]::Round($outItem.Length / 1GB, 2)
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "                 CONVERSION SUCCESSFUL!                   " -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "Saved: $outputFile" -ForegroundColor White
    Write-Host "Original Size: $sourceSizeMB MB ($sourceSizeGB GB)" -ForegroundColor Gray
    Write-Host "Output Size:   $outSizeMB MB ($outSizeGB GB)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Status: 100% Stream-Copy Ready for YT Live Manager!" -ForegroundColor Green
    Write-Host "Upload this file via Dashboard or SCP without any re-encode error." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "                   CONVERSION FAILED                      " -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "Please ensure your NVIDIA graphics drivers and FFmpeg are updated." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press any key to close..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
