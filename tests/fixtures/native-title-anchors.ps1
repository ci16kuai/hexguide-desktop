param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path (Split-Path -Parent $Source) 'CardTitleIdentity.cs') -ReferencedAssemblies System.Drawing
$parseErrors = $null
$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production OCR script has parse errors.' }
foreach ($name in @('Initialize-TitleIdentityFeature','New-TitleIdentityAnchor')) {
    $functionAst = $sourceAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $functionAst) { throw 'Production title-identity helper was not found.' }
    Invoke-Expression $functionAst.Extent.Text
}
$frameId = 'synthetic-anchor-boundary-not-live'
$selectionCapture = @{capturedAt=1000}
$identityAnchors = $null
$identityAnchorCounts = @{}
$identityFeatureReady = $null
$bitmap = New-Object System.Drawing.Bitmap(640, 360)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2)
try {
    $graphics.Clear([System.Drawing.Color]::Black)
    # Sparse artificial strokes test metadata plumbing only, not OCR accuracy.
    for ($x = 154; $x -le 218; $x += 16) { $graphics.DrawLine($pen, $x, 144, $x, 164) }
    $graphics.Dispose()
    $graphics = $null
    $region = @{x=108; y=118; width=168; height=59; column=0}
    $entry = @{x=150.5; y=140.5; width=74.5; height=26.5}
    $first = New-TitleIdentityAnchor $bitmap $region $entry 'card-titles-color'
    $blank = New-TitleIdentityAnchor $bitmap $region @{x=230; y=140; width=30; height=27} 'card-titles-color'
    $outside = New-TitleIdentityAnchor $bitmap $region @{x=100; y=140; width=30; height=27} 'card-titles-color'
    $full = New-TitleIdentityAnchor $bitmap $region $entry 'full-window'
    for ($i = 0; $i -lt 8; $i++) { $null = New-TitleIdentityAnchor $bitmap $region $entry 'card-titles-color' }
    $perPassLimit = $identityAnchors.anchors.Count
    # The extra scale fallback shares the original global descriptor budget.
    foreach ($pass in @('card-titles-color','card-titles-contrast','card-titles-large')) {
        foreach ($column in @(0,1,2)) {
            $region.column = $column
            for ($i = 0; $i -lt 8; $i++) { $null = New-TitleIdentityAnchor $bitmap $region $entry $pass }
        }
    }
    $anchorJson = $identityAnchors | ConvertTo-Json -Compress -Depth 6
    [Console]::WriteLine((@{first=$first; blank=$blank; outsideRejected=($null -eq $outside); fullWindowRejected=($null -eq $full); perPassLimit=$perPassLimit; metadataBytes=[Text.Encoding]::UTF8.GetByteCount($anchorJson); identityAnchors=$identityAnchors} | ConvertTo-Json -Compress -Depth 8))
} finally {
    if ($graphics) { $graphics.Dispose() }
    $pen.Dispose()
    $bitmap.Dispose()
}
