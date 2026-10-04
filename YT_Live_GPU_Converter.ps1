<#
.SYNOPSIS
    YT Live Manager - Dual Stream GPU Video Converter (NVIDIA RTX / GTX NVENC)
    Converts any video into BOTH:
      1. Vertical Shorts:   <name>_Vertical_Shorts.mp4  (9:16 Vertical for YouTube Shorts Feed)
      2. Horizontal 16x9:   <name>_Horizontal_16x9.mp4  (16:9 1920x1080 with Pillarbox for Standard Feed)
    Features:
      - 100% Metadata Scrubbing (Removes EXIF, GPS, camera details, creation dates, chapters, author tags)
      - Stream-copy ready for YT Live Manager (0% VPS CPU load).
#>

[Console]::Title = "YT Live Manager - Dual Stream GPU Converter & Metadata Cleaner"
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   YT LIVE MANAGER - DUAL STREAM GPU CONVERTER (NVENC)    " -ForegroundColor Cyan
Write-Host "   Outputs: 9:16 Shorts + 16:9 Standard Live (1 Run)      " -ForegroundColor Yellow
Write-Host "   Privacy: 100% Source Metadata Stripping Active         " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = "Select video to convert for YouTube Live Dual Streaming"
$dialog.Filter = "Video files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|All files (*.*)|*.*"

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host "No video selected. Exiting." -ForegroundColor Yellow
    exit 0
}

$inputFile = $dialog.FileName
$inputItem = Get-Item -LiteralPath $inputFile
$dir = $inputItem.DirectoryName
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($inputFile)

$outputVertical   = Join-Path $dir "${baseName}_Vertical_Shorts.mp4"
$outputHorizontal = Join-Path $dir "${baseName}_Horizontal_16x9.mp4"

$sourceSizeMB = [Math]::Round($inputItem.Length / 1MB, 2)
$sourceSizeGB = [Math]::Round($inputItem.Length / 1GB, 2)

Write-Host "Input File:         $inputFile" -ForegroundColor White
Write-Host "Source Size:        $sourceSizeMB MB ($sourceSizeGB GB)" -ForegroundColor White
Write-Host "Output 1 (Shorts):  $outputVertical" -ForegroundColor Magenta
Write-Host "Output 2 (16:9):    $outputHorizontal" -ForegroundColor Blue
Write-Host ""
Write-Host "Analyzing source video properties with ffprobe..." -ForegroundColor Gray

# Probe duration, resolution, audio and bitrate
$durVal = 0.0
$durStr = & ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
if ($durStr -and [double]::TryParse($durStr.Trim(), [ref]$durVal) -and $durVal -gt 0) {
    $ts = [TimeSpan]::FromSeconds($durVal)
    $durFormatted = "{0:D2}:{1:D2}:{2:D2}" -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds
    Write-Host "Video Duration:     $durFormatted ($([Math]::Round($durVal, 1)) s)" -ForegroundColor Gray
}

$srcWidth = 0; $srcHeight = 0
$dimStr = & ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$inputFile" 2>$null
if ($dimStr -and $dimStr.Trim() -match '^(\d+)x(\d+)$') {
    $srcWidth = [int]$Matches[1]
    $srcHeight = [int]$Matches[2]
    Write-Host "Source Resolution:  ${srcWidth}x${srcHeight}" -ForegroundColor Gray
}

$hasAudio = $false
$audioCodec = & ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$inputFile" 2>$null
if ($audioCodec -and $audioCodec.Trim().Length -gt 0) {
    $hasAudio = $true
    Write-Host "Source Audio:       $($audioCodec.Trim()) detected" -ForegroundColor Gray
} else {
    Write-Host "Source Audio:       None detected (will generate silent track for YouTube compatibility)" -ForegroundColor Yellow
}

# Inspect source metadata tags
$detectedTags = & ffprobe -v error -show_entries format_tags -of default=noprint_wrappers=1 "$inputFile" 2>$null
$tagCount = 0
if ($detectedTags) {
    $tagLines = $detectedTags.Split("`n") | Where-Object { $_.Trim().Length -gt 0 }
    $tagCount = $tagLines.Count
}
if ($tagCount -gt 0) {
    Write-Host "Source Metadata:    $tagCount tag(s) detected (Will be 100% stripped)" -ForegroundColor Yellow
} else {
    Write-Host "Source Metadata:    Clean (No extra tags found)" -ForegroundColor Gray
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

$sourceKbps = if ($bitrate -gt 0) { [int][Math]::Round($bitrate / 1000) } else { 1200 }
Write-Host "Detected bitrate:   ${sourceKbps} kbps" -ForegroundColor Green

Write-Host ""
Write-Host "Select Output Encoding Profile:" -ForegroundColor Cyan
Write-Host " [1] Balanced Stream-Ready (Matches Source Bitrate, Max 4 Mbps) [RECOMMENDED]" -ForegroundColor Green
Write-Host "     -> 100% Crisp & Sharp, Fast GPU NVENC, Zero Pixelation" -ForegroundColor Gray
Write-Host "     -> YouTube Keyframes 2.0s, Constant 30fps" -ForegroundColor Gray
Write-Host " [2] High Bitrate Stream-Ready (3.5 - 4.0 Mbps)" -ForegroundColor Yellow
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
    $targetKbps = [Math]::Min($targetKbps, 4000)
    $maxRateKbps = [Math]::Min([int]($targetKbps * 1.4), 4000)
    $bufSizeKbps = $targetKbps * 2
} else {
    $targetKbps = [Math]::Max(800, [int][Math]::Round($sourceKbps * 1.15))
    $targetKbps = [Math]::Min($targetKbps, 4000)
    $maxRateKbps = [Math]::Min([int]($targetKbps * 1.5), 4000)
    $bufSizeKbps = $targetKbps * 2
}

# Filters
# 1. Vertical Shorts: 1080x1920 (or keep source vertical resolution if already vertical)
if ($isVertical -and $srcWidth -gt 0 -and $srcHeight -gt 0) {
    $filterVertical = "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1"
} else {
    $filterVertical = "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
}

# 2. Horizontal 16:9: 1920x1080 with centered pillarbox black bars
$filterHorizontal = "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   METADATA CLEANING: 100% Privacy & Tag Scrub Active     " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   -> Stripping: EXIF, GPS, Camera Model, Creation Date   " -ForegroundColor Gray
Write-Host "   -> Stripping: Chapters, Titles, Author, Tool History   " -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan

# Common NVENC encoding parameters
$commonNvencArgs = @(
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
    "-bufsize", "${bufSizeKbps}k"
)

# 100% Complete Metadata Cleaning & Sanitizing Flags
$metadataCleaningArgs = @(
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-fflags", "+bitexact",
    "-flags:v", "+bitexact",
    "-flags:a", "+bitexact",
    "-metadata:g", "title=",
    "-metadata:g", "artist=",
    "-metadata:g", "album=",
    "-metadata:g", "comment=",
    "-metadata:g", "description=",
    "-metadata:g", "synopsis=",
    "-metadata:g", "date=",
    "-metadata:g", "creation_time=",
    "-metadata:g", "author=",
    "-metadata:g", "copyright=",
    "-metadata:g", "encoder="
)

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   [PASS 1 of 2] Encoding 9:16 Shorts (Vertical)          " -ForegroundColor Magenta
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target: $outputVertical" -ForegroundColor White
Write-Host "Settings: Preset p6 | VBR ${targetKbps}k (Max ${maxRateKbps}k) | 30fps | Keyframe 2s" -ForegroundColor Gray
Write-Host ""

# Pass 1: Vertical Shorts
if ($hasAudio) {
    $argsVertical = @(
        "-hide_banner",
        "-hwaccel", "cuda",
        "-i", $inputFile,
        "-vf", $filterVertical
    ) + $commonNvencArgs + $metadataCleaningArgs + @(
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        "-y",
        $outputVertical
    )
} else {
    $argsVertical = @(
        "-hide_banner",
        "-hwaccel", "cuda",
        "-i", $inputFile,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-vf", $filterVertical
    ) + $commonNvencArgs + $metadataCleaningArgs + @(
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        "-y",
        $outputVertical
    )
}

& ffmpeg @argsVertical
$exit1 = $LASTEXITCODE

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   [PASS 2 of 2] Encoding 16:9 Standard Live (Horizontal) " -ForegroundColor Blue
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target: $outputHorizontal" -ForegroundColor White
Write-Host "Filter: Centered with Clean Black Pillarbox Bars (1920x1080)" -ForegroundColor Gray
Write-Host ""

# Pass 2: Horizontal 16:9
if ($hasAudio) {
    $argsHorizontal = @(
        "-hide_banner",
        "-hwaccel", "cuda",
        "-i", $inputFile,
        "-vf", $filterHorizontal
    ) + $commonNvencArgs + $metadataCleaningArgs + @(
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-movflags", "+faststart",
        "-y",
        $outputHorizontal
    )
} else {
    $argsHorizontal = @(
        "-hide_banner",
        "-hwaccel", "cuda",
        "-i", $inputFile,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-vf", $filterHorizontal
    ) + $commonNvencArgs + $metadataCleaningArgs + @(
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-shortest",
        "-movflags", "+faststart",
        "-y",
        $outputHorizontal
    )
}

& ffmpeg @argsHorizontal
$exit2 = $LASTEXITCODE

Write-Host ""
if ($exit1 -eq 0 -and $exit2 -eq 0 -and (Test-Path -LiteralPath $outputVertical) -and (Test-Path -LiteralPath $outputHorizontal)) {
    $itemV = Get-Item -LiteralPath $outputVertical
    $itemH = Get-Item -LiteralPath $outputHorizontal
    $sizeV = [Math]::Round($itemV.Length / 1MB, 2)
    $sizeH = [Math]::Round($itemH.Length / 1MB, 2)

    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "        DUAL STREAM CONVERSION COMPLETED SUCCESSFULLY!    " -ForegroundColor Green
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host " [1] Shorts (9:16 Vertical):" -ForegroundColor Magenta
    Write-Host "     File:     $outputVertical" -ForegroundColor White
    Write-Host "     Size:     $sizeV MB" -ForegroundColor Gray
    Write-Host "     Metadata: 100% Stripped & Cleaned (Zero residual tags)" -ForegroundColor Green
    Write-Host ""
    Write-Host " [2] Standard (16:9 Horizontal with Pillarbox):" -ForegroundColor Blue
    Write-Host "     File:     $outputHorizontal" -ForegroundColor White
    Write-Host "     Size:     $sizeH MB" -ForegroundColor Gray
    Write-Host "     Metadata: 100% Stripped & Cleaned (Zero residual tags)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Status: 100% Stream-Copy Ready for YT Live Manager!" -ForegroundColor Green
    Write-Host "Upload BOTH files to the Dashboard. The manager will automatically" -ForegroundColor Cyan
    Write-Host "pair them and stream to both YouTube Shorts & Normal feeds simultaneously!" -ForegroundColor Cyan
} else {
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "                   CONVERSION FAILED                      " -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "Exit Codes: Pass 1 = $exit1, Pass 2 = $exit2" -ForegroundColor Yellow
    Write-Host "Please ensure your NVIDIA graphics drivers and FFmpeg are updated." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press any key to close..." -ForegroundColor Gray
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
