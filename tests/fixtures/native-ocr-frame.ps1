param([string]$Source, [switch]$StageWorker, [switch]$BlankFrame,
    [int]$Width = 2560, [int]$Height = 1440, [switch]$WrappedTitle, [int]$MaximumDimension = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
# The fixture imports only production functions, never its screen-capture path.
# Preload the shared algorithm from the source directory because PSScriptRoot
# belongs to this synthetic fixture after function extraction.
Add-Type -Path (Join-Path (Split-Path -Parent $Source) 'CardTitleIdentity.cs') -ReferencedAssemblies System.Drawing
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
if ($MaximumDimension -gt 0) { $maxDimension = [Math]::Min($maxDimension, $MaximumDimension) }
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$helpers = [regex]::Match([IO.File]::ReadAllText($Source), '(?s)# OCR_REGION_HELPERS_BEGIN\r?\n(.*?)# OCR_REGION_HELPERS_END').Groups[1].Value
if (-not $helpers) { throw 'Production OCR helpers were not found.' }
Invoke-Expression $helpers
$parseErrors = $null
$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production OCR script has parse errors.' }
$selectionFunction = $sourceAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SelectionRegions'}, $true)
if (-not $selectionFunction) { throw 'Production card-region function was not found.' }
Invoke-Expression $selectionFunction.Extent.Text
if ($StageWorker) {
    # Import production staging/protocol functions, with a generated in-memory
    # frame instead of importing or invoking any foreground/capture code.
    foreach ($name in @('Update-TimingDiagnostics','New-ResultPayload','Write-Result','Read-WorkerRecord','Test-StageAccepted','Invoke-StagedOcr')) {
        $function = $sourceAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        if (-not $function) { throw 'Production staging helper was not found.' }
        Invoke-Expression $function.Extent.Text
    }
    Add-Type -Path (Join-Path (Split-Path -Parent $Source) 'OcrWorkerProtocol.cs')
    $Worker = $true
    $request = Read-WorkerRecord
    if ($null -eq $request -or $request.type -cne 'scan') { exit 1 }
    $requestId = $request.id
}
$frameId = 'synthetic-fixture-not-live-game'
$stage = 'fixture'
$diagnostics = @{width=$Width; height=$Height}
$initializationMs = 0
$captureMs = 0
$recognitionMs = 0
$workerPoisoned = $false
$fixtureExitCode = 0
$identityAnchors = $null
$identityAnchorCounts = @{}
$identityFeatureReady = $null
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 25000
$bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', ([single](32 * $Height / 1440.0)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 224, 181))
try {
    $graphics.Clear([System.Drawing.Color]::FromArgb(22, 33, 44))
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    # The same three headings and approximate coordinates observed in the real
    # match. This generated image is deliberately NOT claimed as a game capture.
    $names = @(([string][char]0x5347 + [char]0x7ea7 + [char]0xff1a + [char]0x8000 + [char]0x5149), ([string][char]0x8d2a + [char]0x6b32 + [char]0x675f + [char]0x7f1a), ([string][char]0x6025 + [char]0x6025 + [char]0x5c0f + [char]0x5b50))
    $viewportWidth = [Math]::Min($Width, $Height * 16.0 / 9.0)
    $viewportLeft = ($Width - $viewportWidth) / 2.0
    $xs = @(721, 1228, 1715) | ForEach-Object {$viewportLeft + $_ * $viewportWidth / 2560.0}
    if (-not $BlankFrame) {
        for ($column = 0; $column -lt 3; $column++) {
            if ($WrappedTitle -and $column -eq 1) {
                # Two complete OCR rows must retain their original crop and
                # individual same-frame anchors before the matcher joins them.
                $graphics.DrawString(([string][char]0x7075 + [char]0x9b42), $font, $brush, [single]$xs[$column], [single](566 * $Height / 1440.0))
                $graphics.DrawString(([string][char]0x8679 + [char]0x5438), $font, $brush, [single]$xs[$column], [single](600 * $Height / 1440.0))
            } else { $graphics.DrawString($names[$column], $font, $brush, [single]$xs[$column], [single](580 * $Height / 1440.0)) }
        }
    }
    $graphics.Dispose()
    $graphics = $null
    $selectionCapture = @{capturedAt=1000; width=$Width; height=$Height; originX=0; originY=0; windowHandle='42'; regions=@(Get-SelectionRegions $bitmap $Width $Height)}
    $lines = @()
    if ($StageWorker) {
        $scanDeadlineMs = 10000
        $lines = @(Invoke-StagedOcr $bitmap $Width $Height)
        $stage = 'result'
        Write-Result 'recognized' 'Generated offline fixture.' $lines
    } else {
        foreach ($variant in @(@{name='card-titles-color'; contrast=$false}, @{name='card-titles-contrast'; contrast=$true})) {
            foreach ($region in @(Get-TitleRegions $Width $Height)) {
                $lines += @(Invoke-ImageRegionOcr $bitmap $region 3.0 $variant.name $variant.contrast)
            }
        }
    # Crop geometry is also checked on small, ultrawide and over-limit images.
    $geometries = @()
    foreach ($size in @(@(1280, 720), @(2560, 1440), @(3440, 1440), @(8192, 8192))) {
        $geometries += @{width=$size[0]; height=$size[1]; regions=@(Get-TitleRegions $size[0] $size[1])}
    }
    [Console]::WriteLine((@{status='recognized'; frameId=$frameId; capture=@{width=$Width; height=$Height}; selectionCapture=$selectionCapture; identityAnchors=$identityAnchors; lines=$lines; geometries=$geometries; elapsedMs=$scanClock.ElapsedMilliseconds} | ConvertTo-Json -Compress -Depth 8))
    }
} catch {
    if (-not $StageWorker) { throw }
    Write-Result 'unavailable' 'Generated fixture failed.' @() '' 'fixture-failed'
    $fixtureExitCode = 1
} finally {
    if ($graphics) { $graphics.Dispose() }
    $brush.Dispose()
    $font.Dispose()
    $bitmap.Dispose()
}
if ($fixtureExitCode) { exit $fixtureExitCode }
