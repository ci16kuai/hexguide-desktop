param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object {$_.LanguageTag -like 'zh-Hans*'} | Select-Object -First 1
if (-not $language) {
    [Console]::WriteLine('{"unavailable":true,"reason":"Chinese OCR language is not installed on this Windows host."}')
    exit 0
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
$maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$helpers = [regex]::Match([IO.File]::ReadAllText($Source), '(?s)# OCR_REGION_HELPERS_BEGIN\r?\n(.*?)# OCR_REGION_HELPERS_END').Groups[1].Value
if (-not $helpers) { throw 'Production OCR helpers were not found.' }
Invoke-Expression $helpers
$frameId = 'synthetic-fixture-not-live-game'
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 25000
$bitmap = New-Object System.Drawing.Bitmap(2560, 1440)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 32, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 224, 181))
try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(22, 33, 44))
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    # The same three headings and approximate coordinates observed in the real
    # match. This generated image is deliberately NOT claimed as a game capture.
    $names = @(([string][char]0x5347 + [char]0x7ea7 + [char]0xff1a + [char]0x8000 + [char]0x5149), ([string][char]0x8d2a + [char]0x6b32 + [char]0x675f + [char]0x7f1a), ([string][char]0x6025 + [char]0x6025 + [char]0x5c0f + [char]0x5b50))
    $xs = @(721, 1228, 1715)
    for ($column = 0; $column -lt 3; $column++) { $graphics.DrawString($names[$column], $font, $brush, [single]$xs[$column], [single]580) }
    $graphics.Dispose()
    $graphics = $null
    $lines = @()
    foreach ($variant in @(@{name='card-titles-color'; contrast=$false}, @{name='card-titles-contrast'; contrast=$true})) {
        foreach ($region in @(Get-TitleRegions 2560 1440)) {
            $lines += @(Invoke-ImageRegionOcr $bitmap $region 3.0 $variant.name $variant.contrast)
        }
    }
    # Crop geometry is also checked on small, ultrawide and over-limit images.
    $geometries = @()
    foreach ($size in @(@(1280, 720), @(2560, 1440), @(3440, 1440), @(8192, 8192))) {
        $geometries += @{width=$size[0]; height=$size[1]; regions=@(Get-TitleRegions $size[0] $size[1])}
    }
    [Console]::WriteLine((@{status='recognized'; frameId=$frameId; capture=@{width=2560; height=1440}; lines=$lines; geometries=$geometries; elapsedMs=$scanClock.ElapsedMilliseconds} | ConvertTo-Json -Compress -Depth 8))
} finally {
    if ($graphics) { $graphics.Dispose() }
    $brush.Dispose()
    $font.Dispose()
    $bitmap.Dispose()
}
