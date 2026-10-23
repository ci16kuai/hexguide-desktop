param(
    [string]$DataDir,
    [switch]$CheckOnly
)
# Windows PowerShell 5.1 hosts the built-in WinRT OCR engine. No model or screenshot is uploaded.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$bitmap = $null
$scaled = $null
$memory = $null
$stream = $null
$writer = $null
$softwareBitmap = $null
$stage = 'initializing'
$diagnostics = @{}

function Write-Result([string]$Status, [string]$Message, [object[]]$Lines = @(), [string]$Text = '', [string]$Code = 'ok') {
    [Console]::WriteLine((@{status=$Status; code=$Code; stage=$script:stage; diagnostics=$script:diagnostics; message=$Message; text=$Text; lines=@($Lines)} | ConvertTo-Json -Compress -Depth 5))
}

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
    $stage = 'resize'
    $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $scale = [Math]::Min(1.0, $maxDimension / [double][Math]::Max($width, $height))
    if ($scale -lt 1) {
        $targetWidth = [Math]::Max(1, [int][Math]::Floor($width * $scale))
        $targetHeight = [Math]::Max(1, [int][Math]::Floor($height * $scale))
        $scaled = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
        $resize = [System.Drawing.Graphics]::FromImage($scaled)
        try {
            $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resize.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
        } finally { $resize.Dispose() }
    } else { $scaled = $bitmap }
    $diagnostics.ocrMaxDimension = $maxDimension
    $diagnostics.scale = $scale
    $stage = 'encode'
    $memory = New-Object System.IO.MemoryStream
    $scaled.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $memory.ToArray()

    $asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await-WinRT($Operation, [Type]$ResultType) {
        $task = $asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
        if (-not $task.Wait(15000)) { throw 'OCR operation timed out.' }
        return $task.Result
    }
    $stage = 'stream-write'
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    $writer.WriteBytes($bytes)
    $null = Await-WinRT ($writer.StoreAsync()) ([uint32])
    $stream.Seek(0)
    $stage = 'decode'
    $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $stage = 'software-bitmap'
    $softwareBitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $stage = 'recognize'
    $result = Await-WinRT ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
    $stage = 'result'
    $lines = @($result.Lines | ForEach-Object {
        $words = @($_.Words)
        if ($words.Count) {
            $left = ($words | ForEach-Object {$_.BoundingRect.X} | Measure-Object -Minimum).Minimum
            $top = ($words | ForEach-Object {$_.BoundingRect.Y} | Measure-Object -Minimum).Minimum
            $right = ($words | ForEach-Object {$_.BoundingRect.X + $_.BoundingRect.Width} | Measure-Object -Maximum).Maximum
            $bottom = ($words | ForEach-Object {$_.BoundingRect.Y + $_.BoundingRect.Height} | Measure-Object -Maximum).Maximum
        } else { $left = 0; $top = 0; $right = 0; $bottom = 0 }
        @{text=$_.Text; x=[Math]::Round($left / $scale, 1); y=[Math]::Round($top / $scale, 1); width=[Math]::Round(($right-$left) / $scale, 1); height=[Math]::Round(($bottom-$top) / $scale, 1); pass='full-window'; words=@($words | ForEach-Object {@{text=$_.Text; x=[Math]::Round($_.BoundingRect.X / $scale, 1); y=[Math]::Round($_.BoundingRect.Y / $scale, 1); width=[Math]::Round($_.BoundingRect.Width / $scale, 1); height=[Math]::Round($_.BoundingRect.Height / $scale, 1)}})}
    })
    if (-not $lines.Count) {
        Write-Result 'recognized' '未识别到文字。请在三选一界面重试；独占全屏时可尝试无边框窗口。'
    } else {
        Write-Result 'recognized' '已在本机识别游戏窗口文字。匹配结果需要你确认，不能据此自动判断已选海克斯。' $lines $result.Text
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
    if ($softwareBitmap) { $softwareBitmap.Dispose() }
    if ($writer) { $writer.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($memory) { $memory.Dispose() }
    if ($scaled -and -not [Object]::ReferenceEquals($scaled, $bitmap)) { $scaled.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    # Images are held in memory only. DataDir is accepted for compatibility; no files are created.
}
