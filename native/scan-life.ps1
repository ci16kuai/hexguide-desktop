param(
    [string]$CalibrationJson,
    [string]$CalibrationBase64,
    [long]$WindowHandle = 0,
    [int]$ParentProcessId = 0,
    [switch]$ReadTimer,
    [switch]$SelfTest
)
# One-shot, local portrait-timer OCR. Cheap color sampling belongs to the
# native controller and ScreenLifePixels; this is never a full-screen scanner.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$bitmap = $null
$timerBitmap = $null
$previousDpi = [IntPtr]::Zero
$clock = [Diagnostics.Stopwatch]::StartNew()
$capturedAt = 0
$captureMetadata = $null
$sceneGray = $false
$sceneColorRestored = $false
$timerAttempted = $false

function Write-LifeResult([string]$Code, [string]$TimerStatus = 'unknown', $Seconds = $null) {
    $payload = @{version=1; source='screen-life-experimental'; status='unknown'; code=$Code; timerStatus=$TimerStatus; countdownSeconds=$Seconds; capturedAtMs=$script:capturedAt; windowHandle=0; clientBounds=$null; dpi=0; sceneGray=$script:sceneGray; sceneColorRestored=$script:sceneColorRestored; timerOcrAttempted=$script:timerAttempted; timerOcrComplete=($TimerStatus -in @('detected','absent')); elapsedMs=[Math]::Min(60000,$script:clock.ElapsedMilliseconds)}
    if ($script:captureMetadata) {
        $payload.windowHandle=$script:captureMetadata.windowHandle; $payload.clientBounds=$script:captureMetadata.clientBounds; $payload.dpi=$script:captureMetadata.dpi
    }
    [Console]::WriteLine(($payload | ConvertTo-Json -Compress -Depth 4))
}

try {
    if ($SelfTest) {
        Add-Type -AssemblyName System.Drawing
        Add-Type -Path (Join-Path $PSScriptRoot 'ScreenLifeObserver.cs') -ReferencedAssemblies System.Drawing
        $checks = [HexGuide.Desktop.ScreenLifeObserver]::ValidateFixtures()
        # Compile interop declarations without invoking any user32 method.
        # This validates the live-only branch without touching a live window.
        $source=[IO.File]::ReadAllText($PSCommandPath)
        $interop=[regex]::Match($source,"(?s)Add-Type -TypeDefinition @'\r?\n(.+?)\r?\n'@")
        if (-not $interop.Success) {throw 'Interop declaration fixture missing.'}
        Add-Type -TypeDefinition $interop.Groups[1].Value
        $checks++
        $fixture = New-Object Drawing.Bitmap(32, 32)
        try {
            $graphics = [Drawing.Graphics]::FromImage($fixture)
            try { $graphics.Clear([Drawing.Color]::FromArgb(60,60,60)) } finally { $graphics.Dispose() }
            $summary = [HexGuide.Desktop.ScreenLifePixels]::Measure($fixture)
            if ($summary.MeanSaturation -ne 0 -or $summary.Samples -ne 96 -or $summary.NonBlackRatio -ne 1) { throw 'Synthetic gray sample failed.' }
            $checks++
            $graphics = [Drawing.Graphics]::FromImage($fixture)
            try { $graphics.Clear([Drawing.Color]::FromArgb(20,80,160)) } finally { $graphics.Dispose() }
            $summary = [HexGuide.Desktop.ScreenLifePixels]::Measure($fixture)
            if ($summary.MeanSaturation -lt .8 -or $summary.NonBlackRatio -ne 1) { throw 'Synthetic color sample failed.' }
            $checks++
        } finally { $fixture.Dispose() }
        [Console]::WriteLine((@{mode='offline-no-ui'; liveGameVerified=$false; checks=$checks; version=1} | ConvertTo-Json -Compress))
        exit 0
    }
    # Fail closed before loading user32, querying a game or invoking WinRT.
    # A real reviewed death/alive sample is needed to fill this calibration.
    if (-not $CalibrationJson -and $CalibrationBase64) {
        if ($CalibrationBase64.Length -gt 5500) {Write-LifeResult 'calibration-invalid'; exit 0}
        $CalibrationJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CalibrationBase64))
    }
    if (-not $CalibrationJson -or [Text.Encoding]::UTF8.GetByteCount($CalibrationJson) -gt 4096) {
        Write-LifeResult 'experimental-calibration-required'
        exit 0
    }
    $calibration = $CalibrationJson | ConvertFrom-Json
    if ($calibration.version -isnot [int] -or $calibration.version -ne 1 -or $calibration.verified -isnot [bool] -or -not $calibration.verified -or $WindowHandle -le 0) {
        Write-LifeResult 'experimental-calibration-required'
        exit 0
    }
    foreach ($field in @('clientWidth','clientHeight','dpi')) {
        $value = $calibration.$field
        if ($value -isnot [int] -and $value -isnot [long]) { Write-LifeResult 'calibration-invalid'; exit 0 }
    }
    $width = [int]$calibration.clientWidth; $height = [int]$calibration.clientHeight
    if ($width -lt 640 -or $height -lt 360 -or $width -gt 8192 -or $height -gt 8192 -or $calibration.dpi -lt 72 -or $calibration.dpi -gt 768) {
        Write-LifeResult 'calibration-invalid'; exit 0
    }
    foreach ($field in @('x','y','width','height')) {
        $value = $calibration.timer.$field
        if ($value -isnot [int] -and $value -isnot [long]) { Write-LifeResult 'calibration-invalid'; exit 0 }
    }
    $scene = @($calibration.scene)
    if ($scene.Count -ne 3) { Write-LifeResult 'calibration-invalid'; exit 0 }
    foreach ($probe in $scene) {
        foreach ($field in @('x','y','width','height')) {
            $value=$probe.$field
            if ($value -isnot [int] -and $value -isnot [long]) { Write-LifeResult 'calibration-invalid'; exit 0 }
        }
        $saturation=$probe.aliveSaturation
        if (($saturation -isnot [int] -and $saturation -isnot [long] -and $saturation -isnot [double] -and $saturation -isnot [decimal]) -or
            [double]::IsNaN([double]$saturation) -or [double]::IsInfinity([double]$saturation) -or
            $probe.x -lt 0 -or $probe.y -lt 0 -or $probe.width -lt 16 -or $probe.height -lt 16 -or
            $probe.width -gt 512 -or $probe.height -gt 512 -or ($probe.x+$probe.width) -gt $width -or ($probe.y+$probe.height) -gt $height -or
            $probe.aliveSaturation -lt .15 -or $probe.aliveSaturation -gt 1) {
            Write-LifeResult 'calibration-invalid'; exit 0
        }
    }
} catch {
    Write-LifeResult 'calibration-invalid'
    exit 0
}

try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -Path (Join-Path $PSScriptRoot 'ScreenLifeObserver.cs') -ReferencedAssemblies System.Drawing
    $region = New-Object Drawing.Rectangle([int]$calibration.timer.x, [int]$calibration.timer.y, [int]$calibration.timer.width, [int]$calibration.timer.height)
    if ($region.X -lt 0 -or $region.Y -lt [int]($height * .65) -or $region.Width -lt 8 -or $region.Height -lt 8 -or
        $region.Width -gt 256 -or $region.Height -gt 160 -or $region.Right -gt $width -or $region.Bottom -gt $height) {
        Write-LifeResult 'calibration-invalid'; exit 0
    }
    $sceneBoxes=@()
    foreach ($probe in $scene) {
        $box=New-Object Drawing.Rectangle([int]$probe.x,[int]$probe.y,[int]$probe.width,[int]$probe.height)
        if ($box.IntersectsWith($region)) {Write-LifeResult 'calibration-invalid'; exit 0}
        foreach ($existing in $sceneBoxes) {if ($box.IntersectsWith($existing)) {Write-LifeResult 'calibration-invalid'; exit 0}}
        $sceneBoxes+=,$box
    }
    if (-not $ReadTimer) { Write-LifeResult 'timer-not-requested'; exit 0 }
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class HexGuideLifeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder path, ref uint size);
    public static bool Verified(IntPtr window) {
        if (window == IntPtr.Zero || GetForegroundWindow() != window || !IsWindowVisible(window) || IsIconic(window)) return false;
        uint pid; GetWindowThreadProcessId(window, out pid);
        try {
            using (Process process = Process.GetProcessById((int)pid)) {
                if (!String.Equals(process.ProcessName, "League of Legends", StringComparison.OrdinalIgnoreCase)) return false;
                string path = null; IntPtr query = OpenProcess(0x1000, false, pid);
                if (query != IntPtr.Zero) try { var text = new StringBuilder(32768); uint size = (uint)text.Capacity; if (QueryFullProcessImageName(query, 0, text, ref size)) path = text.ToString(); } finally { CloseHandle(query); }
                if (String.IsNullOrEmpty(path)) { var title = new StringBuilder(512); GetWindowText(window, title, title.Capacity); return title.ToString() == "League of Legends (TM) Client"; }
                return String.Equals(Path.GetFileName(path), "League of Legends.exe", StringComparison.OrdinalIgnoreCase)
                    && String.Equals(new DirectoryInfo(Path.GetDirectoryName(path)).Name, "Game", StringComparison.OrdinalIgnoreCase);
            }
        } catch { return false; }
    }
    // Conservative rectangular coverage: even unknown translucent overlays
    // reject this observation. No visual contents of other windows are read.
    public static bool TrustedParent(int processId, string expectedPath) {
        if (processId < 1) return false;
        try {
            using (Process process = Process.GetProcessById(processId)) {
                if (!String.Equals(process.ProcessName, "HexGuide", StringComparison.OrdinalIgnoreCase)) return false;
                IntPtr query = OpenProcess(0x1000, false, (uint)processId);
                if (query == IntPtr.Zero) return false;
                try { var path = new StringBuilder(32768); uint size = (uint)path.Capacity;
                    return QueryFullProcessImageName(query, 0, path, ref size) && String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(expectedPath), StringComparison.OrdinalIgnoreCase);
                } finally { CloseHandle(query); }
            }
        } catch { return false; }
    }
    public static bool Unoccluded(IntPtr window, int x, int y, int width, int height, int trustedProcessId) {
        int count = 0; var visited = new System.Collections.Generic.HashSet<IntPtr>();
        for (IntPtr above = GetWindow(window, 3); above != IntPtr.Zero; above = GetWindow(above, 3)) {
            if (++count > 256 || !visited.Add(above)) return false;
            if (!IsWindowVisible(above) || IsIconic(above)) continue;
            if (trustedProcessId > 0) { uint owner; GetWindowThreadProcessId(above, out owner); if (owner == trustedProcessId) continue; }
            Rect box; if (!GetWindowRect(above, out box)) return false;
            if (box.Left < x + width && box.Right > x && box.Top < y + height && box.Bottom > y) return false;
        }
        return true;
    }
}
'@
    $window = [IntPtr]$WindowHandle
    if (-not [HexGuideLifeWindow]::Verified($window)) { Write-LifeResult 'game-not-foreground'; exit 0 }
    $trustedParent=0
    if ($ParentProcessId -gt 0) {
        $expectedParent=Join-Path (Split-Path -Parent $PSScriptRoot) 'HexGuide.exe'
        if (-not [HexGuideLifeWindow]::TrustedParent($ParentProcessId,$expectedParent)) {Write-LifeResult 'parent-unverified'; exit 0}
        $trustedParent=$ParentProcessId
    }
    $previousDpi = [HexGuideLifeWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
    if ($previousDpi -eq [IntPtr]::Zero) { $previousDpi = [HexGuideLifeWindow]::SetThreadDpiAwarenessContext([IntPtr](-3)) }
    if ($previousDpi -eq [IntPtr]::Zero) { Write-LifeResult 'dpi-unavailable'; exit 0 }
    $client = New-Object HexGuideLifeWindow+Rect
    $origin = New-Object HexGuideLifeWindow+Point
    if (-not [HexGuideLifeWindow]::GetClientRect($window,[ref]$client) -or -not [HexGuideLifeWindow]::ClientToScreen($window,[ref]$origin) -or
        ($client.Right-$client.Left) -ne $width -or ($client.Bottom-$client.Top) -ne $height -or
        [HexGuideLifeWindow]::GetDpiForWindow($window) -ne $calibration.dpi) { Write-LifeResult 'geometry-changed'; exit 0 }
    $x = $origin.X + $region.X; $y = $origin.Y + $region.Y
    if (-not [HexGuideLifeWindow]::Unoccluded($window,$x,$y,$region.Width,$region.Height,0)) { Write-LifeResult 'region-occluded'; exit 0 }
    # Same-frame evidence uses a complete game-client capture, so refuse any
    # external covering window before that capture. Only a separately verified
    # parent HexGuide.exe from this same installation may be ignored here;
    # sampled scene/timer ROIs below never ignore even that helper's windows.
    if (-not [HexGuideLifeWindow]::Unoccluded($window,$origin.X,$origin.Y,$width,$height,$trustedParent)) { Write-LifeResult 'game-frame-occluded'; exit 0 }
    if ([long]$width*$height -gt 24000000) { Write-LifeResult 'capture-size-unsupported'; exit 0 }
    # A rare timer request captures this single verified game frame in memory.
    # Color and timer evidence must never be combined across different frames.
    $bitmap = New-Object Drawing.Bitmap($width,$height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($origin.X,$origin.Y,0,0,$bitmap.Size,[Drawing.CopyPixelOperation]::SourceCopy) } finally { $graphics.Dispose() }
    $capturedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not [HexGuideLifeWindow]::Verified($window)) { Write-LifeResult 'game-not-foreground'; exit 0 }
    if (-not [HexGuideLifeWindow]::Unoccluded($window,$origin.X,$origin.Y,$width,$height,$trustedParent)) {Write-LifeResult 'game-frame-occluded'; exit 0}
    $captureMetadata=@{windowHandle=$WindowHandle; clientBounds=@{x=$origin.X;y=$origin.Y;width=$width;height=$height}; dpi=[int]$calibration.dpi}
    $grayCount=0; $colorCount=0
    foreach ($probe in $scene) {
        if (-not [HexGuideLifeWindow]::Unoccluded($window,($origin.X+$probe.x),($origin.Y+$probe.y),$probe.width,$probe.height,0)) { Write-LifeResult 'region-occluded'; exit 0 }
        $box=New-Object Drawing.Rectangle([int]$probe.x,[int]$probe.y,[int]$probe.width,[int]$probe.height)
        $crop=$bitmap.Clone($box,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
        try {$summary=[HexGuide.Desktop.ScreenLifePixels]::Measure($crop)} finally {$crop.Dispose()}
        if ($summary.NonBlackRatio -ge .6 -and $summary.MeanLuminance -gt .06) {
            if ($summary.MeanSaturation -le [Math]::Min(.15,([double]$probe.aliveSaturation*.35))) {$grayCount++}
            if ($summary.MeanSaturation -ge [Math]::Max(.12,([double]$probe.aliveSaturation*.75))) {$colorCount++}
        }
    }
    $sceneGray=($grayCount -eq 3); $sceneColorRestored=($colorCount -eq 3)
    $timerBitmap=$bitmap.Clone($region,[Drawing.Imaging.PixelFormat]::Format32bppArgb)

    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Foundation,ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
    $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
    $language = $languages | Where-Object {$_.LanguageTag -like 'en*'} | Select-Object -First 1
    if (-not $language) { $language = $languages | Select-Object -First 1 }
    if (-not $language) { Write-LifeResult 'ocr-language-missing'; exit 0 }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if (-not $engine) { Write-LifeResult 'ocr-unavailable'; exit 0 }
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    function Await-LifeOcr($Operation,[Type]$ResultType) {
        $remaining=[int](8000-$script:clock.ElapsedMilliseconds)
        if ($remaining -lt 100) {throw 'Local operation budget exhausted.'}
        $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation))
        if (-not $task.Wait([Math]::Min(2500,$remaining))) { throw 'Local operation timeout.' }
        return $task.Result
    }
    function Read-LifeDigits([bool]$Contrast) {
        $enlarged = $null; $memory = $null; $stream = $null; $writer = $null; $software = $null
        try {
            $enlarged = New-Object Drawing.Bitmap(($script:timerBitmap.Width*4),($script:timerBitmap.Height*4))
            $resize = [Drawing.Graphics]::FromImage($enlarged)
            $attributes=$null
            try {
                $resize.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                if ($Contrast) {
                    $matrix=New-Object Drawing.Imaging.ColorMatrix
                    $matrix.Matrix00=-.38268; $matrix.Matrix01=-.38268; $matrix.Matrix02=-.38268
                    $matrix.Matrix10=-1.28736; $matrix.Matrix11=-1.28736; $matrix.Matrix12=-1.28736
                    $matrix.Matrix20=-.12996; $matrix.Matrix21=-.12996; $matrix.Matrix22=-.12996
                    $matrix.Matrix40=1.4; $matrix.Matrix41=1.4; $matrix.Matrix42=1.4
                    $attributes=New-Object Drawing.Imaging.ImageAttributes; $attributes.SetColorMatrix($matrix)
                    $target=New-Object Drawing.Rectangle(0,0,$enlarged.Width,$enlarged.Height)
                    $resize.DrawImage($script:timerBitmap,$target,[single]0,[single]0,[single]$script:timerBitmap.Width,[single]$script:timerBitmap.Height,[Drawing.GraphicsUnit]::Pixel,$attributes)
                } else {$resize.DrawImage($script:timerBitmap,0,0,$enlarged.Width,$enlarged.Height)}
            } finally {if ($attributes) {$attributes.Dispose()}; $resize.Dispose()}
            $memory = New-Object IO.MemoryStream
            $enlarged.Save($memory,[Drawing.Imaging.ImageFormat]::Png)
            $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
            $writer.WriteBytes($memory.ToArray()); $null = Await-LifeOcr ($writer.StoreAsync()) ([uint32]); $stream.Seek(0)
            $decoder = Await-LifeOcr ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $software = Await-LifeOcr ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,[Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Await-LifeOcr ($script:engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($result.Lines | Where-Object {-not [string]::IsNullOrWhiteSpace($_.Text)})
            if ($lines.Count -eq 0) { return -1 }
            # Never strip arbitrary surrounding text into a guessed digit.
            if ($lines.Count -ne 1 -or $lines[0].Text.Trim() -notmatch '^[0-9]{1,3}$') { return -2 }
            $value = [int]$lines[0].Text.Trim()
            if ($value -lt 1 -or $value -gt 180) { return -2 }
            return $value
        } finally {
            if ($software) {$software.Dispose()}; if ($writer) {$writer.Dispose()}; if ($stream) {$stream.Dispose()}
            if ($memory) {$memory.Dispose()}; if ($enlarged) {$enlarged.Dispose()}
        }
    }
    $timerAttempted=$true
    $original = Read-LifeDigits $false
    $contrast = Read-LifeDigits $true
    $finalClient=New-Object HexGuideLifeWindow+Rect; $finalOrigin=New-Object HexGuideLifeWindow+Point
    if (-not [HexGuideLifeWindow]::Verified($window) -or -not [HexGuideLifeWindow]::GetClientRect($window,[ref]$finalClient) -or
        -not [HexGuideLifeWindow]::ClientToScreen($window,[ref]$finalOrigin) -or
        $finalOrigin.X -ne $origin.X -or $finalOrigin.Y -ne $origin.Y -or
        $finalClient.Right -ne $client.Right -or $finalClient.Bottom -ne $client.Bottom -or
        [HexGuideLifeWindow]::GetDpiForWindow($window) -ne $calibration.dpi) { Write-LifeResult 'geometry-changed'; exit 0 }
    if (-not [HexGuideLifeWindow]::Unoccluded($window,$x,$y,$region.Width,$region.Height,0)) { Write-LifeResult 'region-occluded'; exit 0 }
    if ($trustedParent -gt 0 -and -not [HexGuideLifeWindow]::TrustedParent($trustedParent,$expectedParent)) {Write-LifeResult 'parent-unverified'; exit 0}
    if (-not [HexGuideLifeWindow]::Unoccluded($window,$origin.X,$origin.Y,$width,$height,$trustedParent)) {Write-LifeResult 'game-frame-occluded'; exit 0}
    foreach ($probe in $scene) {
        if (-not [HexGuideLifeWindow]::Unoccluded($window,($origin.X+$probe.x),($origin.Y+$probe.y),$probe.width,$probe.height,0)) { Write-LifeResult 'region-occluded'; exit 0 }
    }
    if ($original -eq -1 -and $contrast -eq -1) { Write-LifeResult 'timer-absent-consensus' 'absent'; exit 0 }
    if ($original -ge 1 -and $original -eq $contrast) { Write-LifeResult 'timer-digit-consensus' 'detected' $original; exit 0 }
    Write-LifeResult 'timer-ambiguous'
} catch {
    # No raw OCR strings, exception text, paths, screenshots or identity leave
    # this child process. All temporary images are held in memory only.
    Write-LifeResult 'screen-life-unavailable'
} finally {
    if ($bitmap) {$bitmap.Dispose()}
    if ($timerBitmap) {$timerBitmap.Dispose()}
    if ($previousDpi -ne [IntPtr]::Zero) { try { [void][HexGuideLifeWindow]::SetThreadDpiAwarenessContext($previousDpi) } catch {} }
}
