param(
    [string]$DataDir,
    [switch]$CheckOnly
)
# Windows PowerShell 5.1 hosts the built-in WinRT OCR engine. No model or screenshot is uploaded.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$bitmap = $null
$stage = 'initializing'
$diagnostics = @{}
$frameId = [Guid]::NewGuid().ToString('N')
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 10000
$selectionCapture = $null
$previousDpiContext = [IntPtr]::Zero

function Write-Result([string]$Status, [string]$Message, [object[]]$Lines = @(), [string]$Text = '', [string]$Code = 'ok') {
    $payload = @{status=$Status; code=$Code; stage=$script:stage; diagnostics=$script:diagnostics; frameId=$script:frameId; message=$Message; text=$Text; lines=@($Lines)}
    if ($script:selectionCapture -and $Status -eq 'recognized') { $payload.selectionCapture = $script:selectionCapture }
    [Console]::WriteLine(($payload | ConvertTo-Json -Compress -Depth 7))
}

# A small RGB thumbnail is a temporary visual baseline, not a screenshot file.
# Keep this identical to ScreenSelectionWatcher.ReadSignature (8x8, row-major).
function Get-SelectionRegions($Image, [int]$Width, [int]$Height) {
    $viewportWidth = [Math]::Min($Width, $Height * 16.0 / 9.0)
    $viewportLeft = ($Width - $viewportWidth) / 2.0
    for ($column = 0; $column -lt 3; $column++) {
        $left = [int][Math]::Floor($viewportLeft + (.21 + .20 * $column) * $viewportWidth)
        $right = [int][Math]::Ceiling($viewportLeft + (.39 + .20 * $column) * $viewportWidth)
        $top = [int][Math]::Floor($Height * .20)
        $bottom = [int][Math]::Ceiling($Height * .70)
        $sourceRectangle = New-Object System.Drawing.Rectangle($left, $top, ($right-$left), ($bottom-$top))
        $regionBitmap = $Image.Clone($sourceRectangle, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $thumbnail = New-Object System.Drawing.Bitmap(8, 8, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
        $resize = [System.Drawing.Graphics]::FromImage($thumbnail)
        try {
            $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
            $resize.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $resize.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
            $destination = New-Object System.Drawing.Rectangle(0, 0, 8, 8)
            $resize.DrawImage($regionBitmap, $destination, [single]0, [single]0, [single]$regionBitmap.Width, [single]$regionBitmap.Height, [System.Drawing.GraphicsUnit]::Pixel)
            $signature = New-Object 'System.Collections.Generic.List[int]'
            for ($row = 0; $row -lt 8; $row++) {
                for ($cell = 0; $cell -lt 8; $cell++) {
                    $pixel = $thumbnail.GetPixel($cell, $row)
                    $signature.Add([int]$pixel.R); $signature.Add([int]$pixel.G); $signature.Add([int]$pixel.B)
                }
            }
            @{column=$column; x=$left; y=$top; width=$right-$left; height=$bottom-$top; signature=@($signature.ToArray())}
        } finally { $resize.Dispose(); $thumbnail.Dispose(); $regionBitmap.Dispose() }
    }
}

# OCR_REGION_HELPERS_BEGIN
function Get-TitleRegions([int]$Width, [int]$Height) {
    # The three cards occupy the centered 16:9 game viewport, including on an
    # ultrawide display. Keep generous overlapping columns and the whole title
    # band; this avoids assuming a particular title length or a single baseline.
    $viewportWidth = [Math]::Min($Width, $Height * 16.0 / 9.0)
    $viewportLeft = ($Width - $viewportWidth) / 2.0
    $ranges = @(@(.17, .43), @(.38, .62), @(.57, .83))
    for ($column = 0; $column -lt 3; $column++) {
        $left = [int][Math]::Floor($viewportLeft + $ranges[$column][0] * $viewportWidth)
        $right = [int][Math]::Ceiling($viewportLeft + $ranges[$column][1] * $viewportWidth)
        $top = [int][Math]::Floor($Height * .33)
        $bottom = [int][Math]::Ceiling($Height * .49)
        @{x=$left; y=$top; width=$right-$left; height=$bottom-$top; column=$column}
    }
}

function Await-WinRT($Operation, [Type]$ResultType) {
    # The parent process also has a 15 second timeout. A single slow recognition
    # must not consume that entire budget and discard already completed passes.
    $remaining = [int]($script:scanDeadlineMs - $script:scanClock.ElapsedMilliseconds)
    if ($remaining -lt 100) { throw 'OCR operation timed out.' }
    $task = $script:asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait([Math]::Min(4000, $remaining))) { throw 'OCR operation timed out.' }
    return $task.Result
}

function Invoke-ImageRegionOcr($Image, $Region, [double]$RequestedScale, [string]$Pass, [bool]$Contrast = $false) {
    $regionBitmap = $null
    $regionMemory = $null
    $regionStream = $null
    $regionWriter = $null
    $regionSoftwareBitmap = $null
    try {
        $scale = [Math]::Min($RequestedScale, $script:maxDimension / [double][Math]::Max($Region.width, $Region.height))
        $targetWidth = [Math]::Max(1, [int][Math]::Floor($Region.width * $scale))
        $targetHeight = [Math]::Max(1, [int][Math]::Floor($Region.height * $scale))
        # Use the actual rounded horizontal/vertical scale for the inverse map.
        $scaleX = $targetWidth / [double]$Region.width
        $scaleY = $targetHeight / [double]$Region.height
        $regionBitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
        $resize = [System.Drawing.Graphics]::FromImage($regionBitmap)
        $attributes = $null
        try {
            $resize.Clear([System.Drawing.Color]::White)
            $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $destination = New-Object System.Drawing.Rectangle(0, 0, $targetWidth, $targetHeight)
            if ($Contrast) {
                # Grayscale, invert and increase contrast: pale gold/white card
                # headings become dark text on a light background. The original
                # color pass remains independent, so no OCR guesses are merged.
                $matrix = New-Object System.Drawing.Imaging.ColorMatrix
                $matrix.Matrix00 = -.38268; $matrix.Matrix01 = -.38268; $matrix.Matrix02 = -.38268
                $matrix.Matrix10 = -1.28736; $matrix.Matrix11 = -1.28736; $matrix.Matrix12 = -1.28736
                $matrix.Matrix20 = -.12996; $matrix.Matrix21 = -.12996; $matrix.Matrix22 = -.12996
                $matrix.Matrix40 = 1.4; $matrix.Matrix41 = 1.4; $matrix.Matrix42 = 1.4
                $attributes = New-Object System.Drawing.Imaging.ImageAttributes
                $attributes.SetColorMatrix($matrix)
                $resize.DrawImage($Image, $destination, [single]$Region.x, [single]$Region.y, [single]$Region.width, [single]$Region.height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
            } else {
                $resize.DrawImage($Image, $destination, [single]$Region.x, [single]$Region.y, [single]$Region.width, [single]$Region.height, [System.Drawing.GraphicsUnit]::Pixel)
            }
        } finally {
            if ($attributes) { $attributes.Dispose() }
            $resize.Dispose()
        }
        $script:stage = 'encode'
        $regionMemory = New-Object System.IO.MemoryStream
        $regionBitmap.Save($regionMemory, [System.Drawing.Imaging.ImageFormat]::Png)
        $script:stage = 'stream-write'
        $regionStream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $regionWriter = New-Object Windows.Storage.Streams.DataWriter($regionStream)
        $regionWriter.WriteBytes($regionMemory.ToArray())
        $null = Await-WinRT ($regionWriter.StoreAsync()) ([uint32])
        $regionStream.Seek(0)
        $script:stage = 'decode'
        $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($regionStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $script:stage = 'software-bitmap'
        $regionSoftwareBitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $script:stage = 'recognize'
        $result = Await-WinRT ($script:engine.RecognizeAsync($regionSoftwareBitmap)) ([Windows.Media.Ocr.OcrResult])
        foreach ($line in $result.Lines) {
            $words = @($line.Words)
            if (-not $words.Count) { continue }
            $left = ($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
            $top = ($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
            $right = ($words | ForEach-Object {$_.BoundingRect.X + $_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
            $bottom = ($words | ForEach-Object {$_.BoundingRect.Y + $_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
            $entry = @{
                text=$line.Text; frameId=$script:frameId; pass=$Pass
                x=[Math]::Round($Region.x + $left / $scaleX, 1); y=[Math]::Round($Region.y + $top / $scaleY, 1)
                width=[Math]::Round(($right-$left) / $scaleX, 1); height=[Math]::Round(($bottom-$top) / $scaleY, 1)
                words=@($words | ForEach-Object {@{
                    text=$_.Text; x=[Math]::Round($Region.x + $_.BoundingRect.X / $scaleX, 1); y=[Math]::Round($Region.y + $_.BoundingRect.Y / $scaleY, 1)
                    width=[Math]::Round($_.BoundingRect.Width / $scaleX, 1); height=[Math]::Round($_.BoundingRect.Height / $scaleY, 1)
                }})
            }
            if ($Region.ContainsKey('column')) {
                $entry.region = 'card-title'
                $entry.column = $Region.column
                $entry.crop = @{x=$Region.x; y=$Region.y; width=$Region.width; height=$Region.height}
            }
            $entry
        }
    } finally {
        if ($regionSoftwareBitmap) { $regionSoftwareBitmap.Dispose() }
        if ($regionWriter) { $regionWriter.Dispose() }
        if ($regionStream) { $regionStream.Dispose() }
        if ($regionMemory) { $regionMemory.Dispose() }
        if ($regionBitmap) { $regionBitmap.Dispose() }
    }
}
# OCR_REGION_HELPERS_END

try {
    $stage = 'native-window'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HexGuideGameWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
    $stage = 'foreground-check'
    if (-not $CheckOnly) {
        $window = [HexGuideGameWindow]::GetForegroundWindow()
        [uint32]$gameProcessId = 0
        [void][HexGuideGameWindow]::GetWindowThreadProcessId($window, [ref]$gameProcessId)
        $gameProcess = Get-Process -Id $gameProcessId -ErrorAction SilentlyContinue
        if (-not $gameProcess -or $gameProcess.ProcessName -ne 'League of Legends') {
            Write-Result 'waiting' '请先将英雄联盟游戏窗口切到前台，再扫描三选一。' @() '' 'game-not-foreground'
            exit 0
        }
    }

    $stage = 'winrt-runtime'
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -AssemblyName System.Drawing
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
    $stage = 'ocr-language'
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
    # Favor Chinese when installed; all returned proposals still require the player's confirmation.
    $language = $languages | Where-Object {$_.LanguageTag -like 'zh-Hans*' -or $_.LanguageTag -eq 'zh-CN'} | Select-Object -First 1
    if (-not $language) { $language = $languages | Where-Object {$_.LanguageTag -like 'zh*'} | Select-Object -First 1 }
    if (-not $language) { $language = $languages | Where-Object {$_.LanguageTag -like 'en*'} | Select-Object -First 1 }
    if (-not $language) { $language = $languages | Select-Object -First 1 }
    if (-not $language) {
        Write-Result 'unavailable' 'Windows 未安装文字识别语言。可在系统语言设置添加中文，或手动选择海克斯。' @() '' 'ocr-language-missing'
        exit 0
    }
    $diagnostics.language = $language.LanguageTag
    $diagnostics.availableLanguages = @($languages | ForEach-Object {$_.LanguageTag})
    $stage = 'ocr-engine'
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if (-not $engine) {
        Write-Result 'unavailable' 'Windows 文字识别暂不可用，请手动选择海克斯。' @() '' 'ocr-engine-unavailable'
        exit 0
    }
    if ($CheckOnly) {
        Write-Result 'recognized' ('Windows OCR 可用：' + $language.LanguageTag + '。本次未读取屏幕。')
        exit 0
    }

    $stage = 'window-bounds'
    # Capture metadata and native mouse observations share physical pixels.
    $previousDpiContext = [HexGuideGameWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($previousDpiContext -eq [IntPtr]::Zero) { $previousDpiContext = [HexGuideGameWindow]::SetThreadDpiAwarenessContext([IntPtr](-3)) }
    $rect = New-Object HexGuideGameWindow+Rect
    $point = New-Object HexGuideGameWindow+Point
    if (-not [HexGuideGameWindow]::GetClientRect($window, [ref]$rect) -or -not [HexGuideGameWindow]::ClientToScreen($window, [ref]$point)) {
        Write-Result 'unavailable' '无法读取游戏窗口区域，请使用无边框或窗口模式后重试。' @() '' 'window-bounds-unavailable'
        exit 0
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $diagnostics.width = $width
    $diagnostics.height = $height
    $diagnostics.dpi = [HexGuideGameWindow]::GetDpiForWindow($window)
    $diagnostics.dpiAwareness = [HexGuideGameWindow]::GetAwarenessFromDpiAwarenessContext([HexGuideGameWindow]::GetThreadDpiAwarenessContext())
    if ($width -lt 640 -or $height -lt 360 -or $width -gt 8192 -or $height -gt 8192) {
        Write-Result 'unavailable' '游戏窗口尺寸暂不支持，请使用正常大小的游戏窗口。' @() '' 'window-size-unsupported'
        exit 0
    }
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        exit 0
    }
    $stage = 'capture'
    $capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        # Capture only the confirmed foreground game's client rectangle, never the entire desktop.
        $graphics.CopyFromScreen($point.X, $point.Y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $graphics.Dispose() }
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        exit 0
    }
    if ($previousDpiContext -ne [IntPtr]::Zero) {
        $selectionCapture = @{capturedAt=$capturedAt; width=$width; height=$height; originX=$point.X; originY=$point.Y; windowHandle=$window.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture); regions=@(Get-SelectionRegions $bitmap $width $height)}
        [void][HexGuideGameWindow]::SetThreadDpiAwarenessContext($previousDpiContext)
        $previousDpiContext = [IntPtr]::Zero
    }
    $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $diagnostics.ocrMaxDimension = $maxDimension
    $diagnostics.passesCompleted = 0
    $diagnostics.passesFailed = 0
    $diagnostics.passCodes = @()
    $regions = @(Get-TitleRegions $width $height)
    $passes = @()
    foreach ($region in $regions) { $passes += @{region=$region; name='card-titles-color'; scale=3.0; contrast=$false} }
    foreach ($region in $regions) { $passes += @{region=$region; name='card-titles-contrast'; scale=3.0; contrast=$true} }
    $passes += @{region=@{x=0; y=0; width=$width; height=$height}; name='full-window'; scale=1.0; contrast=$false}
    $lines = @()
    foreach ($pass in $passes) {
        if ($scanClock.ElapsedMilliseconds -gt ($scanDeadlineMs - 700)) {
            $diagnostics.budgetReached = $true
            break
        }
        try {
            # All crops are derived from the one captured frame. Coordinates are
            # mapped back to that frame; different recognition variants never
            # share a pass identifier and therefore cannot fabricate a triple.
            $lines += @(Invoke-ImageRegionOcr $bitmap $pass.region $pass.scale $pass.name $pass.contrast)
            $diagnostics.passesCompleted++
            $diagnostics.passCodes += ($pass.name + $(if ($pass.region.ContainsKey('column')) { ':' + $pass.region.column } else { '' }))
        } catch {
            $diagnostics.passesFailed++
            $passException = $_.Exception
            while ($passException.InnerException) { $passException = $passException.InnerException }
            $diagnostics.lastPassErrorType = $passException.GetType().FullName
        }
    }
    # Do not publish observations if the player switched away during OCR.
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        exit 0
    }
    $diagnostics.elapsedMs = $scanClock.ElapsedMilliseconds
    $diagnostics.lineCount = $lines.Count
    $stage = 'result'
    if (-not $lines.Count -and $diagnostics.passesFailed) {
        Write-Result 'unavailable' '本机文字识别未完成，请在三选一画面保持稳定后重试。' @() '' 'ocr-passes-incomplete'
    } elseif (-not $lines.Count) {
        Write-Result 'recognized' '未识别到文字。请在三选一界面重试；独占全屏时可尝试无边框窗口。'
    } else {
        Write-Result 'recognized' '文字匹配仅识别候选，实际选择另由屏幕证据核对。' $lines (($lines | ForEach-Object {$_.text}) -join "`n")
    }
} catch {
    # Return stage/type only: exception messages can contain paths or OCR data and are deliberately omitted.
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    $diagnostics.errorType = $exception.GetType().FullName
    $diagnostics.hresult = ('0x{0:X8}' -f $exception.HResult)
    $message = switch ($stage) {
        'capture' {'无法读取前台游戏画面。请稍后重试；独占全屏时可使用无边框窗口。'}
        'window-bounds' {'无法读取游戏窗口区域，请使用正常大小的游戏窗口后重试。'}
        'ocr-language' {'Windows OCR 语言读取失败，请确认系统已安装中文 OCR 语言。'}
        'ocr-engine' {'Windows OCR 引擎初始化失败，请稍后重试。'}
        'recognize' {'本机文字识别失败或超时，请在三选一画面保持稳定后重试。'}
        default {'本机海克斯识别流程失败，请稍后重试或手动选择海克斯。'}
    }
    Write-Result 'unavailable' $message @() '' ('ocr-' + $stage + '-failed')
} finally {
    if ($previousDpiContext -ne [IntPtr]::Zero) { try { [void][HexGuideGameWindow]::SetThreadDpiAwarenessContext($previousDpiContext) } catch {} }
    if ($bitmap) { $bitmap.Dispose() }
    # Images are held in memory only. DataDir is accepted for compatibility; no files are created.
}
