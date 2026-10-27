param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType=WindowsRuntime]
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$null, [ref]$null)
foreach ($name in @('Await-WinRT','New-OcrSoftwareBitmap')) {
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $function) { throw 'Production pixel-buffer helper was not found.' }
    Invoke-Expression $function.Extent.Text
}
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 10000

function Read-SoftwarePixels($Bitmap) {
    $bytes = New-Object byte[] ($Bitmap.PixelWidth * $Bitmap.PixelHeight * 4)
    $Bitmap.CopyToBuffer([Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer($bytes))
    return ,$bytes
}

function New-PngReference($Bitmap) {
    # Reference the former PNG encode/write/decode conversion. It is kept only
    # in this generated-pixel fixture to detect BGRA, alpha or row-order drift.
    $memory = New-Object IO.MemoryStream
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
    try {
        $Bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
        $writer.WriteBytes($memory.ToArray())
        $null = Await-WinRT ($writer.StoreAsync()) ([uint32])
        $stream.Seek(0)
        $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        return Await-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
            [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } finally { $writer.Dispose(); $stream.Dispose(); $memory.Dispose() }
}

$results = @()
foreach ($kind in @('packed','padded','negative')) {
    $allocation = [IntPtr]::Zero
    $bitmap = $null
    $direct = $null
    $reference = $null
    try {
        if ($kind -eq 'packed') { $bitmap = New-Object Drawing.Bitmap(17, 9, ([Drawing.Imaging.PixelFormat]::Format32bppPArgb)) }
        else {
            $allocation = [Runtime.InteropServices.Marshal]::AllocHGlobal(80 * 9)
            $origin = if ($kind -eq 'negative') { [IntPtr]::Add($allocation, 80 * 8) } else { $allocation }
            $stride = if ($kind -eq 'negative') { -80 } else { 80 }
            $bitmap = New-Object Drawing.Bitmap(17, 9, $stride, ([Drawing.Imaging.PixelFormat]::Format32bppPArgb), $origin)
        }
        $draw = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $draw.Clear([Drawing.Color]::White)
            for ($row = 0; $row -lt 9; $row++) {
                $brush = New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(255, 20 + $row * 19, 200 - $row * 13, 30 + $row * 11))
                try { $draw.FillRectangle($brush, 0, $row, 17, 1) } finally { $brush.Dispose() }
            }
        } finally { $draw.Dispose() }
        $direct = New-OcrSoftwareBitmap $bitmap
        $reference = New-PngReference $bitmap
        $actual = Read-SoftwarePixels $direct
        $expected = Read-SoftwarePixels $reference
        $equal = $actual.Length -eq $expected.Length
        for ($index = 0; $equal -and $index -lt $actual.Length; $index++) { if ($actual[$index] -ne $expected[$index]) { $equal = $false } }
        # The deep copy must survive changes and disposal of its source bitmap.
        $bitmap.Dispose(); $bitmap = $null
        $afterDisposal = Read-SoftwarePixels $direct
        $stable = [Convert]::ToBase64String($actual) -ceq [Convert]::ToBase64String($afterDisposal)
        $results += @{kind=$kind; samePixels=$equal; survivesSourceDisposal=$stable; width=$direct.PixelWidth; height=$direct.PixelHeight; format=$direct.BitmapPixelFormat.ToString(); alpha=$direct.BitmapAlphaMode.ToString()}
    } finally {
        if ($reference) { $reference.Dispose() }
        if ($direct) { $direct.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
        if ($allocation -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($allocation) }
    }
}
[Console]::WriteLine((@{scope='Generated pixels only; no screen API or game input';results=$results} | ConvertTo-Json -Compress -Depth 4))
