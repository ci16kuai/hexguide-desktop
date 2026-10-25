param([string]$Source, [ValidateSet('request','ack')][string]$Mode = 'request')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Import only protocol/payload functions: this fixture never initializes WinRT,
# calls a window API, reads a screen, or opens application/user data.
Add-Type -Path (Join-Path (Split-Path -Parent $Source) 'OcrWorkerProtocol.cs')
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production OCR script has parse errors.' }
foreach ($name in @('Update-TimingDiagnostics','New-ResultPayload','Read-WorkerRecord','Test-StageAccepted')) {
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $function) { throw 'Production OCR protocol helper was not found.' }
    Invoke-Expression $function.Extent.Text
}
$Worker = $true
$workerPoisoned = $false
$requestId = 7
$frameId = 'offline-protocol-fixture'
$stage = 'fixture'
$diagnostics = @{}
$initializationMs = 0
$captureMs = 0
$recognitionMs = 0
$scanDeadlineMs = 1000
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$selectionCapture = $null
$identityAnchors = $null
try {
    if ($Mode -eq 'ack') {
        $decision = Test-StageAccepted 'color' @()
        [Console]::WriteLine((@{accepted=$true; decision=$decision; poisoned=$workerPoisoned} | ConvertTo-Json -Compress))
    } else {
        $record = Read-WorkerRecord
        if ($null -eq $record) { throw 'Fixture requires one complete record.' }
        [Console]::WriteLine((@{accepted=$true; version=$record.version; type=$record.type; id=$record.id} | ConvertTo-Json -Compress))
    }
} catch {
    # Never echo raw input or exception messages, including invalid UTF-8.
    [Console]::WriteLine((@{accepted=$false; poisoned=$workerPoisoned} | ConvertTo-Json -Compress))
    exit 1
}
