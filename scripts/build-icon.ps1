param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not $OutputPath) { $OutputPath = Join-Path $PSScriptRoot '..\native\assets\hexguide.ico' }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null

# Code-native Windows rendering of native/assets/hexguide.svg, with transparent corners.
# Every image is rendered at its own resolution; no rescaled 16-pixel tray icon.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bitmap = New-Object Drawing.Bitmap($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $background = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#0b1420'))
    $core = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#66dfec'))
    $strokeWidth = if ($size -eq 16) { 4.0 } else { 3.5 }
    $outline = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#d7b575'), [single]$strokeWidth)
    $outline.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
    $rounded = New-Object Drawing.Drawing2D.GraphicsPath
    $memory = New-Object IO.MemoryStream
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $scale = [single]($size / 64.0)
        $graphics.ScaleTransform($scale, $scale)
        $rounded.AddArc(0, 0, 28, 28, 180, 90)
        $rounded.AddArc(36, 0, 28, 28, 270, 90)
        $rounded.AddArc(36, 36, 28, 28, 0, 90)
        $rounded.AddArc(0, 36, 28, 28, 90, 90)
        $rounded.CloseFigure()
        $graphics.FillPath($background, $rounded)
        $outerPoints = [Drawing.PointF[]]@(
            (New-Object Drawing.PointF(32, 6)), (New-Object Drawing.PointF(54, 32)),
            (New-Object Drawing.PointF(32, 58)), (New-Object Drawing.PointF(10, 32)))
        $innerPoints = [Drawing.PointF[]]@(
            (New-Object Drawing.PointF(32, 16)), (New-Object Drawing.PointF(40, 32)),
            (New-Object Drawing.PointF(32, 48)), (New-Object Drawing.PointF(24, 32)))
        $graphics.DrawPolygon($outline, $outerPoints)
        $graphics.FillPolygon($core, $innerPoints)
        $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
        $images += ,$memory.ToArray()
    }
    finally {
        $memory.Dispose(); $rounded.Dispose(); $outline.Dispose()
        $core.Dispose(); $background.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
}

# PNG entries in ICO are supported on Windows Vista and later; the app targets 10/11.
$output = [IO.File]::Open($OutputPath, [IO.FileMode]::Create, [IO.FileAccess]::Write)
$writer = New-Object IO.BinaryWriter($output)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($index = 0; $index -lt $sizes.Count; $index++) {
        $dimension = if ($sizes[$index] -eq 256) { 0 } else { $sizes[$index] }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$images[$index].Length)
        $writer.Write([uint32]$offset)
        $offset += $images[$index].Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image) }
}
finally { $writer.Dispose(); $output.Dispose() }
Write-Output "Windows icon: $OutputPath"
