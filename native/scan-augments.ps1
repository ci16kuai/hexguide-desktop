param(
    [string]$DataDir,
    [switch]$CheckOnly,
    [switch]$Worker
)
# Windows PowerShell 5.1 hosts the built-in WinRT OCR engine. No model or screenshot is uploaded.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$identityFeatureReady = $null
$runtimeReady = $false
$workerPoisoned = $false
$requestId = 0

function Update-TimingDiagnostics {
    $script:diagnostics.initializationMs = [int]$script:initializationMs
    $script:diagnostics.captureMs = [int]$script:captureMs
    $script:diagnostics.recognitionMs = [int]$script:recognitionMs
    $script:diagnostics.totalMs = [int]$script:scanClock.ElapsedMilliseconds
}

function New-ResultPayload([string]$Status, [string]$Message, [object[]]$Lines = @(), [string]$Text = '', [string]$Code = 'ok') {
    Update-TimingDiagnostics
    $payload = @{status=$Status; code=$Code; stage=$script:stage; diagnostics=$script:diagnostics; frameId=$script:frameId; message=$Message; text=$Text; lines=@($Lines)}
    if ($script:selectionCapture -and $Status -eq 'recognized') { $payload.selectionCapture = $script:selectionCapture }
    if ($script:identityAnchors -and $Status -eq 'recognized') {
        $anchorJson = $script:identityAnchors | ConvertTo-Json -Compress -Depth 6
        if ([Text.Encoding]::UTF8.GetByteCount($anchorJson) -le 32768) { $payload.identityAnchors = $script:identityAnchors }
    }
    return $payload
}

function Write-Result([string]$Status, [string]$Message, [object[]]$Lines = @(), [string]$Text = '', [string]$Code = 'ok') {
    $payload = New-ResultPayload $Status $Message $Lines $Text $Code
    if ($Worker) { [Console]::WriteLine((@{version=1; type='result'; id=$script:requestId; payload=$payload} | ConvertTo-Json -Compress -Depth 9)) }
    else { [Console]::WriteLine(($payload | ConvertTo-Json -Compress -Depth 8)) }
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
function Initialize-TitleIdentityFeature {
    if ($script:identityFeatureReady -eq $false) { return $false }
    try {
        if (-not ('HexGuide.Desktop.CardTitleIdentity' -as [type])) {
            Add-Type -Path (Join-Path $PSScriptRoot 'CardTitleIdentity.cs') -ReferencedAssemblies System.Drawing -ErrorAction Stop
        }
        $script:identityFeatureReady = $true
    } catch { $script:identityFeatureReady = $false }
    return $script:identityFeatureReady
}

function New-TitleIdentityAnchor($Image, $Region, $Entry, [string]$Pass) {
    # Use exactly the original OCR frame, never a later capture. Wide title
    # bands are discovery regions; only the actual whole OCR line gets an anchor.
    if (-not $script:selectionCapture -or -not $Region.ContainsKey('column') -or $Pass -notin @('card-titles-color','card-titles-contrast','card-titles-large')) { return $null }
    if (-not (Initialize-TitleIdentityFeature)) { return $null }
    if (-not $script:identityAnchorCounts) { $script:identityAnchorCounts = @{} }
    $countKey = $Pass + ':' + $Region.column
    if ([int]$script:identityAnchorCounts[$countKey] -ge 6) { return $null }
    if ($Entry.x -lt $Region.x -or $Entry.y -lt $Region.y -or ($Entry.x + $Entry.width) -gt ($Region.x + $Region.width) -or ($Entry.y + $Entry.height) -gt ($Region.y + $Region.height)) { return $null }
    $left = [int][Math]::Max($Region.x, [Math]::Floor($Entry.x) - 2)
    $top = [int][Math]::Max($Region.y, [Math]::Floor($Entry.y) - 2)
    $right = [int][Math]::Min(($Region.x + $Region.width), [Math]::Ceiling($Entry.x + $Entry.width) + 2)
    $bottom = [int][Math]::Min(($Region.y + $Region.height), [Math]::Ceiling($Entry.y + $Entry.height) + 2)
    if ($left -lt 0 -or $top -lt 0 -or $right -gt $Image.Width -or $bottom -gt $Image.Height -or ($right-$left) -lt 8 -or ($bottom-$top) -lt 8) { return $null }
    try {
        $box = New-Object System.Drawing.Rectangle($left, $top, ($right-$left), ($bottom-$top))
        $feature = [HexGuide.Desktop.CardTitleIdentity]::Extract($Image, $box)
        if (-not $script:identityAnchors) {
            $script:identityAnchors = @{version=1; algorithm=[HexGuide.Desktop.CardTitleIdentity]::Algorithm; frameId=$script:frameId; capturedAt=$script:selectionCapture.capturedAt; anchors=(New-Object System.Collections.ArrayList)}
        }
        if ($script:identityAnchors.anchors.Count -ge 36) { return $null }
        $index = $script:identityAnchors.anchors.Count
        $anchor = @{index=$index; pass=$Pass; column=$Region.column; box=@{x=$left; y=$top; width=$right-$left; height=$bottom-$top}; feature=@($feature.Feature); quality=@{usable=$feature.Usable; contrast=$feature.Contrast; edgePixels=$feature.EdgePixels; activeCells=$feature.ActiveCells}}
        [void]$script:identityAnchors.anchors.Add($anchor)
        $script:identityAnchorCounts[$countKey] = [int]$script:identityAnchorCounts[$countKey] + 1
        return $index
    } catch { return $null }
}

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
    if ($remaining -lt 100) {
        $script:workerPoisoned = $true
        try { $Operation.Cancel() } catch {}
        throw (New-Object System.TimeoutException('OCR operation timed out.'))
    }
    try { $task = $script:asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation)) }
    catch {
        # The operation has already started. If conversion failed its lifetime
        # is unknown, so this process cannot safely reuse the OCR engine.
        $script:workerPoisoned = $true
        try { $Operation.Cancel() } catch {}
        throw
    }
    if (-not $task.Wait([Math]::Min(4000, $remaining))) {
        $script:workerPoisoned = $true
        try { $Operation.Cancel() } catch {}
        throw (New-Object System.TimeoutException('OCR operation timed out.'))
    }
    return $task.Result
}

function New-OcrSoftwareBitmap($Bitmap) {
    # Windows OCR consumes BGRA pixels directly. PNG encoding, an asynchronous
    # stream write, and decoding only round-tripped these same in-memory pixels.
    # Match WinRT's premultiplied BGRA layout and copy just the packed rows;
    # BitmapData.Stride may include padding or run backwards for another bitmap.
    $width = $Bitmap.Width
    $height = $Bitmap.Height
    $rowBytes = [int]($width * 4)
    $bytes = New-Object byte[] ($rowBytes * $height)
    $rectangle = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    $pixels = $Bitmap.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppPArgb)
    try {
        if ($pixels.Stride -eq $rowBytes) {
            [Runtime.InteropServices.Marshal]::Copy($pixels.Scan0, $bytes, 0, $bytes.Length)
        } else {
            for ($row = 0; $row -lt $height; $row++) {
                [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($pixels.Scan0, $row * $pixels.Stride), $bytes, $row * $rowBytes, $rowBytes)
            }
        }
    } finally { $Bitmap.UnlockBits($pixels) }
    $buffer = [Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes)
    # This deep copy owns its pixels after the lock and local byte buffer leave
    # scope. It must be disposed by the caller after the awaited OCR operation.
    return [Windows.Graphics.Imaging.SoftwareBitmap]::CreateCopyFromBuffer($buffer,
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, $width, $height,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
}

function Invoke-ImageRegionOcr($Image, $Region, [double]$RequestedScale, [string]$Pass, [bool]$Contrast = $false) {
    $recognitionClock = [Diagnostics.Stopwatch]::StartNew()
    $regionBitmap = $null
    $regionSoftwareBitmap = $null
    try {
        $scale = [Math]::Min($RequestedScale, $script:maxDimension / [double][Math]::Max($Region.width, $Region.height))
        $targetWidth = [Math]::Max(1, [int][Math]::Floor($Region.width * $scale))
        $targetHeight = [Math]::Max(1, [int][Math]::Floor($Region.height * $scale))
        # Use the actual rounded horizontal/vertical scale for the inverse map.
        $scaleX = $targetWidth / [double]$Region.width
        $scaleY = $targetHeight / [double]$Region.height
        $regionBitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight, ([System.Drawing.Imaging.PixelFormat]::Format32bppPArgb))
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
        $script:stage = 'software-bitmap'
        $regionSoftwareBitmap = New-OcrSoftwareBitmap $regionBitmap
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
                $anchorIndex = New-TitleIdentityAnchor $Image $Region $entry $Pass
                if ($null -ne $anchorIndex) { $entry.identityAnchorIndex = $anchorIndex }
            }
            $entry
        }
    } finally {
        $script:recognitionMs += $recognitionClock.ElapsedMilliseconds
        if ($regionSoftwareBitmap) { $regionSoftwareBitmap.Dispose() }
        if ($regionBitmap) { $regionBitmap.Dispose() }
    }
}
# OCR_REGION_HELPERS_END

function Initialize-OcrRuntime {
    if ($script:runtimeReady) { return 'ok' }
    $script:stage = 'native-window'
    if (-not ('HexGuideGameWindow' -as [type])) { Add-Type -TypeDefinition @'
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
'@ }

    $script:stage = 'winrt-runtime'
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    Add-Type -AssemblyName System.Drawing
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
    $script:stage = 'ocr-language'
    $script:languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
    # Favor Chinese when installed; all returned proposals still require the player's confirmation.
    $script:language = $script:languages | Where-Object {$_.LanguageTag -like 'zh-Hans*' -or $_.LanguageTag -eq 'zh-CN'} | Select-Object -First 1
    if (-not $script:language) { $script:language = $script:languages | Where-Object {$_.LanguageTag -like 'zh*'} | Select-Object -First 1 }
    if (-not $script:language) { $script:language = $script:languages | Where-Object {$_.LanguageTag -like 'en*'} | Select-Object -First 1 }
    if (-not $script:language) { $script:language = $script:languages | Select-Object -First 1 }
    if (-not $script:language) { return 'ocr-language-missing' }
    $script:stage = 'ocr-engine'
    $script:engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($script:language)
    if (-not $script:engine) { return 'ocr-engine-unavailable' }
    $script:maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $script:asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if (-not $script:asTaskMethod) { throw 'WinRT task conversion is unavailable.' }
    $null = Initialize-TitleIdentityFeature
    $script:runtimeReady = $true
    return 'ok'
}

function Read-WorkerRecord([int]$TimeoutMs = -1) {
    $line = [HexGuideOcrWorkerProtocol]::ReadLine($TimeoutMs)
    if ($null -eq $line) { return $null }
    $record = $line | ConvertFrom-Json -ErrorAction Stop
    if ($null -eq $record -or $record -is [array] -or $record -is [string]) { throw 'Invalid OCR protocol record.' }
    $keys = @($record.PSObject.Properties.Name)
    if ($keys.Count -ne 3 -or -not ($keys -ccontains 'version') -or -not ($keys -ccontains 'type') -or -not ($keys -ccontains 'id')) { throw 'Invalid OCR protocol fields.' }
    if ($record.version -isnot [int] -or $record.version -ne 1 -or $record.type -isnot [string]) { throw 'Invalid OCR protocol version.' }
    if (($record.id -isnot [int] -and $record.id -isnot [long]) -or $record.id -lt 1 -or $record.id -gt 9007199254740991) { throw 'Invalid OCR protocol id.' }
    return $record
}

function Test-StageAccepted([string]$Name, [object[]]$Lines) {
    if (-not $Worker) { return $false }
    $script:stage = 'stage-' + $Name
    $payload = New-ResultPayload 'recognized' '文字匹配仅识别候选，实际选择另由屏幕证据核对。' $Lines (($Lines | ForEach-Object {$_.text}) -join "`n")
    [Console]::WriteLine((@{version=1; type='stage'; id=$script:requestId; stage=$Name; payload=$payload} | ConvertTo-Json -Compress -Depth 9))
    try {
        $remaining = [int]($script:scanDeadlineMs - $script:scanClock.ElapsedMilliseconds)
        if ($remaining -le 0) { throw 'OCR scan budget was exhausted.' }
        $ack = Read-WorkerRecord ([Math]::Min(5000, $remaining))
        if ($null -eq $ack -or $ack.id -ne $script:requestId -or $ack.type -cnotin @('accept','continue')) { throw 'Invalid OCR stage acknowledgement.' }
        return $ack.type -ceq 'accept'
    } catch {
        # Invalid/late/EOF acknowledgements make frame ownership ambiguous.
        # The outer finally releases the frame before this process exits.
        $script:workerPoisoned = $true
        throw
    }
}

function Invoke-StagedOcr($Image, [int]$Width, [int]$Height) {
    $script:diagnostics.passesCompleted = 0
    $script:diagnostics.passesFailed = 0
    $script:diagnostics.passCodes = @()
    $regions = @(Get-TitleRegions $Width $Height)
    $groups = @(
        @{name='card-titles-color'; stage='color'; scale=3.0; contrast=$false; regions=$regions},
        @{name='card-titles-contrast'; stage='contrast'; scale=3.0; contrast=$true; regions=$regions},
        # A short/thin heading can be missed at the first sampling scale. This
        # bounded fallback keeps all three columns in one independent pass on
        # the same captured frame; successful original passes still return first.
        @{name='card-titles-large'; stage='large'; scale=4.0; contrast=$false; regions=$regions},
        @{name='full-window'; stage=''; scale=1.0; contrast=$false; regions=@(@{x=0; y=0; width=$Width; height=$Height})}
    )
    $lines = @()
    foreach ($group in $groups) {
        $completed = 0
        foreach ($region in $group.regions) {
            if ($script:scanClock.ElapsedMilliseconds -gt ($script:scanDeadlineMs - 700)) {
                $script:diagnostics.budgetReached = $true
                return $lines
            }
            try {
                # Every crop belongs to the one captured frame. Variants keep
                # separate pass ids and cannot manufacture a mixed triple.
                $lines += @(Invoke-ImageRegionOcr $Image $region $group.scale $group.name $group.contrast)
                $completed++
                $script:diagnostics.passesCompleted++
                $script:diagnostics.passCodes += ($group.name + $(if ($region.ContainsKey('column')) { ':' + $region.column } else { '' }))
            } catch {
                $script:diagnostics.passesFailed++
                if ($script:workerPoisoned) { throw }
                $passException = $_.Exception
                while ($passException.InnerException) { $passException = $passException.InnerException }
                $script:diagnostics.lastPassErrorType = $passException.GetType().FullName
            }
        }
        # Only Node's existing matcher can accept a stage after verifying the
        # complete triple and its identity proof. Native never guesses success.
        if ($group.stage -and $completed -eq 3 -and (Test-StageAccepted $group.stage $lines)) { return $lines }
    }
    return $lines
}

function Invoke-OcrScan {
    # Nothing derived from a previous frame survives this boundary. Only the
    # immutable runtime/engine/language/reflection setup is kept by the host.
    $script:bitmap = $null
    $script:stage = 'initializing'
    $script:diagnostics = @{runtimeReused=[bool]$script:runtimeReady}
    $script:frameId = [Guid]::NewGuid().ToString('N')
    $script:scanClock = [Diagnostics.Stopwatch]::StartNew()
    $script:scanDeadlineMs = 10000
    $script:selectionCapture = $null
    $script:identityAnchors = $null
    $script:identityAnchorCounts = @{}
    $script:initializationMs = 0
    $script:captureMs = 0
    $script:recognitionMs = 0
    $previousDpiContext = [IntPtr]::Zero
    try {
        if (-not $script:runtimeReady) {
            $initializationClock = [Diagnostics.Stopwatch]::StartNew()
            try { $runtimeCode = Initialize-OcrRuntime }
            finally { $script:initializationMs = $initializationClock.ElapsedMilliseconds }
            if ($runtimeCode -ne 'ok') {
                $message = if ($runtimeCode -eq 'ocr-language-missing') { 'Windows 未安装文字识别语言。可在系统语言设置添加中文，或手动选择海克斯。' } else { 'Windows 文字识别暂不可用，请手动选择海克斯。' }
                Write-Result 'unavailable' $message @() '' $runtimeCode
                return
            }
        }
        $script:diagnostics.language = $script:language.LanguageTag
        $script:diagnostics.availableLanguages = @($script:languages | ForEach-Object {$_.LanguageTag})
        $script:diagnostics.ocrMaxDimension = $script:maxDimension
        if ($CheckOnly) {
            Write-Result 'recognized' ('Windows OCR 可用：' + $script:language.LanguageTag + '。本次未读取屏幕。')
            return
        }
        $script:stage = 'foreground-check'
        $window = [HexGuideGameWindow]::GetForegroundWindow()
        [uint32]$gameProcessId = 0
        [void][HexGuideGameWindow]::GetWindowThreadProcessId($window, [ref]$gameProcessId)
        $gameProcess = Get-Process -Id $gameProcessId -ErrorAction SilentlyContinue
        if (-not $gameProcess -or $gameProcess.ProcessName -ne 'League of Legends') {
            Write-Result 'waiting' '请先将英雄联盟游戏窗口切到前台，再扫描三选一。' @() '' 'game-not-foreground'
            return
        }

    $script:stage = 'window-bounds'
    # Capture metadata and native mouse observations share physical pixels.
    $previousDpiContext = [HexGuideGameWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($previousDpiContext -eq [IntPtr]::Zero) { $previousDpiContext = [HexGuideGameWindow]::SetThreadDpiAwarenessContext([IntPtr](-3)) }
    $rect = New-Object HexGuideGameWindow+Rect
    $point = New-Object HexGuideGameWindow+Point
    if (-not [HexGuideGameWindow]::GetClientRect($window, [ref]$rect) -or -not [HexGuideGameWindow]::ClientToScreen($window, [ref]$point)) {
        Write-Result 'unavailable' '无法读取游戏窗口区域，请使用无边框或窗口模式后重试。' @() '' 'window-bounds-unavailable'
        return
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    $diagnostics.width = $width
    $diagnostics.height = $height
    $diagnostics.dpi = [HexGuideGameWindow]::GetDpiForWindow($window)
    $diagnostics.dpiAwareness = [HexGuideGameWindow]::GetAwarenessFromDpiAwarenessContext([HexGuideGameWindow]::GetThreadDpiAwarenessContext())
    if ($width -lt 640 -or $height -lt 360 -or $width -gt 8192 -or $height -gt 8192) {
        Write-Result 'unavailable' '游戏窗口尺寸暂不支持，请使用正常大小的游戏窗口。' @() '' 'window-size-unsupported'
        return
    }
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        return
    }
    $script:stage = 'capture'
    $captureClock = [Diagnostics.Stopwatch]::StartNew()
    $capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        # Capture only the confirmed foreground game's client rectangle, never the entire desktop.
        $graphics.CopyFromScreen($point.X, $point.Y, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally { $graphics.Dispose() }
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        return
    }
    if ($previousDpiContext -ne [IntPtr]::Zero) {
        $script:selectionCapture = @{capturedAt=$capturedAt; width=$width; height=$height; originX=$point.X; originY=$point.Y; windowHandle=$window.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture); regions=@(Get-SelectionRegions $bitmap $width $height)}
        [void][HexGuideGameWindow]::SetThreadDpiAwarenessContext($previousDpiContext)
        $previousDpiContext = [IntPtr]::Zero
    }
    $script:captureMs = $captureClock.ElapsedMilliseconds
    $lines = @(Invoke-StagedOcr $bitmap $width $height)
    # Do not publish observations if the player switched away during OCR.
    if ([HexGuideGameWindow]::GetForegroundWindow() -ne $window) {
        Write-Result 'waiting' '前台窗口已切换，本次扫描已取消。' @() '' 'foreground-changed'
        return
    }
    $diagnostics.elapsedMs = $scanClock.ElapsedMilliseconds
    $diagnostics.lineCount = $lines.Count
    $script:stage = 'result'
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
    $script:bitmap = $null
    $script:selectionCapture = $null
    $script:identityAnchors = $null
    $script:identityAnchorCounts = @{}
    # Images are held in memory only. DataDir is accepted for compatibility; no files are created.
}
}

if ($Worker) {
    try {
        Add-Type -Path (Join-Path $PSScriptRoot 'OcrWorkerProtocol.cs') -ErrorAction Stop
        $lastRequestId = 0
        while (-not $script:workerPoisoned) {
            $request = Read-WorkerRecord
            if ($null -eq $request) { break }
            if ($request.type -cne 'scan' -or $request.id -le $lastRequestId) { throw 'Invalid OCR scan request.' }
            $script:requestId = $request.id
            $lastRequestId = $request.id
            Invoke-OcrScan
        }
    } catch {
        # Protocol failures terminate silently: never echo input or keep a
        # potentially pending stdin/WinRT operation available to future scans.
        exit 1
    }
    if ($script:workerPoisoned) { exit 1 }
} else { Invoke-OcrScan }
