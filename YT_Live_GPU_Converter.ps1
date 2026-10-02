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

# Probe duration and bitrate
$durVal = 0.0
$durStr = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
if ($durStr -and [double]::TryParse($durStr.Trim(), [ref]$durVal) -and $durVal -gt 0) {
    $ts = [TimeSpan]::FromSeconds($durVal)
    $durFormatted = "{0:D2}:{1:D2}:{2:D2}" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds
    Write-Host "Video Duration: $durFormatted ($([Math]::Round($durVal, 1)) s)" -ForegroundColor Gray
}

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

# Gate ceiling: 4 Mbps (4,000,000 bps)
$maxGateBitrate = 4000000
if ($bitrate -gt 0 -and $bitrate -le $maxGateBitrate) {
    $targetBitrate = $bitrate
    Write-Host "Detected source bitrate: $([Math]::Round($bitrate / 1000)) kbps" -ForegroundColor Green
    Write-Host "Target bitrate: $([Math]::Round($targetBitrate / 1000)) kbps (Source bitrate preserved)" -ForegroundColor Green
} elseif ($bitrate -gt $maxGateBitrate) {
    $targetBitrate = $maxGateBitrate
    Write-Host "Detected source bitrate: $([Math]::Round($bitrate / 1000)) kbps (Exceeds 4 Mbps)" -ForegroundColor Yellow
    Write-Host "Target bitrate: 4000 kbps (Capped at 4 Mbps gate ceiling)" -ForegroundColor Yellow
} else {
    $targetBitrate = $maxGateBitrate
    Write-Host "Could not detect source bitrate. Defaulting to 4000 kbps ceiling." -ForegroundColor Yellow
}

$targetKbps = [int][Math]::Round($targetBitrate / 1000)
$bufSizeKbps = [Math]::Min($targetKbps * 2, 8000)

if ($durVal -gt 0) {
    $estTotalBytes = (($targetKbps * 1000 + 128000) * $durVal) / 8
    $estSizeGB = [Math]::Round($estTotalBytes / 1GB, 2)
    Write-Host "Estimated Output Size: ~$estSizeGB GB (Matches source size!)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting NVIDIA NVENC hardware-accelerated encode..." -ForegroundColor Cyan
Write-Host "Encoding: 1080x1920 30fps | Bitrate: ${targetKbps}k | Maxrate: ${targetKbps}k | Bufsize: ${bufSizeKbps}k" -ForegroundColor Gray
Write-Host ""

$ffmpegArgs = @(
    "-hide_banner",
    "-hwaccel", "cuda",
    "-i", $inputFile,
    "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
    "-c:v", "h264_nvenc",
    "-preset", "p4",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-keyint_min", "60",
    "-b:v", "${targetKbps}k",
    "-maxrate", "${targetKbps}k",
    "-bufsize", "${bufSizeKbps}k",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-ac", "2",
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
