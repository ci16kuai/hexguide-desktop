param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Production OCR script has parse errors.' }
foreach ($name in @('Await-WinRT','Get-TitleRegions','Invoke-StagedOcr')) {
    $function = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    if (-not $function) { throw 'Production OCR safety helper was not found.' }
    Invoke-Expression $function.Extent.Text
}

# An intentionally unfinished task models a native call that does not complete
# even after cancellation. No WinRT engine, window API, or screen is read here.
Add-Type -TypeDefinition @'
using System;
using System.Threading.Tasks;
public class FixturePendingOperation {
    public bool Cancelled;
    public void Cancel() { Cancelled = true; }
}
public class FixturePendingTask {
    public readonly TaskCompletionSource<string> Completion = new TaskCompletionSource<string>();
    public FixturePendingTask MakeGenericMethod(Type resultType) { return this; }
    public Task<string> Invoke(object target, object[] arguments) { return Completion.Task; }
}
'@
$asTaskMethod = New-Object FixturePendingTask
$pendingOperation = New-Object FixturePendingOperation
$workerPoisoned = $false
$diagnostics = @{}
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 1500
$passesInvoked = 0
function Invoke-ImageRegionOcr($Image, $Region, $Scale, $Pass, $Contrast) {
    $script:passesInvoked++
    $null = Await-WinRT $script:pendingOperation ([string])
    @{text='unexpected completion'}
}
function Test-StageAccepted($Name, $Lines) { throw 'A pending call cannot publish a stage.' }
$caught = $false
try { $null = @(Invoke-StagedOcr $null 2560 1440) } catch { $caught = $true }
$pending = @{caught=$caught; poisoned=$workerPoisoned; cancelled=$pendingOperation.Cancelled; taskStillPending=(-not $asTaskMethod.Completion.Task.IsCompleted); passesInvoked=$passesInvoked}

# A normal failed color region is recoverable; its incomplete group must never
# emit a stage. A complete contrast group can still be offered to Node.
$workerPoisoned = $false
$diagnostics = @{}
$scanClock = [Diagnostics.Stopwatch]::StartNew()
$scanDeadlineMs = 10000
$passesInvoked = 0
$stages = New-Object System.Collections.ArrayList
function Invoke-ImageRegionOcr($Image, $Region, $Scale, $Pass, $Contrast) {
    $script:passesInvoked++
    if ($Pass -eq 'card-titles-color' -and $Region.column -eq 0) { throw 'Generated color region failure.' }
    @{text='generated region'; pass=$Pass}
}
function Test-StageAccepted($Name, $Lines) {
    [void]$script:stages.Add($Name)
    return $Name -eq 'contrast'
}
$lines = @(Invoke-StagedOcr $null 2560 1440)
$recoverable = @{passesInvoked=$passesInvoked; passesCompleted=$diagnostics.passesCompleted; passesFailed=$diagnostics.passesFailed; stages=@($stages); lines=$lines.Count; poisoned=$workerPoisoned; fullWindow=($diagnostics.passCodes -contains 'full-window')}

[Console]::WriteLine((@{pending=$pending; recoverable=$recoverable} | ConvertTo-Json -Compress -Depth 5))
