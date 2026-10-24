param([string]$WorkPath)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $projectRoot 'native\OwnedAugmentVerification.cs'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Owned verification source is missing.' }
if (-not $WorkPath) { $WorkPath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-owned-augment-verification') }
$work = [IO.Path]::GetFullPath($WorkPath)
New-Item -ItemType Directory -Path $work -Force | Out-Null
$run = Join-Path $work ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$harness = Join-Path $run 'OwnedVerificationHarness.cs'
$executable = Join-Path $run 'OwnedVerificationFixtures.exe'
@'
using System;
using System.Web.Script.Serialization;
namespace HexGuide.Desktop {
    internal static class OwnedVerificationHarness {
        private static int Main() {
            try { Console.WriteLine(new JavaScriptSerializer().Serialize(OwnedAugmentVerificationFixtures.Run())); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
        }
    }
}
'@ | Set-Content -LiteralPath $harness -Encoding UTF8
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw '.NET Framework compiler is required.' }
# Compile only the pure evidence core and this console fixture harness. Do not
# launch HexGuide.exe, load WinForms, capture a screen, or contact any service.
& $compiler '/nologo' '/target:exe' '/platform:x64' '/optimize+' '/utf8output' '/codepage:65001' '/langversion:4' '/reference:System.dll' '/reference:System.Core.dll' '/reference:System.Web.Extensions.dll' ('/out:' + $executable) $source $harness
if ($LASTEXITCODE -ne 0) { throw 'Owned verification fixture compilation failed.' }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executable
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = New-Object Diagnostics.Process
$process.StartInfo = $start
try {
    $null = $process.Start()
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(30000)) {
        $process.Kill() # Only this script's newly created, isolated fixture child.
        throw 'Owned verification fixtures exceeded 30 seconds.'
    }
    $output = $outputTask.GetAwaiter().GetResult()
    $errorOutput = $errorTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $run 'result.json'), $output, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $run 'stderr.txt'), $errorOutput, (New-Object Text.UTF8Encoding($false)))
    if ($process.ExitCode -ne 0) { throw ('Owned verification fixtures failed: ' + $errorOutput) }
} finally { $process.Dispose() }
$result = $output | ConvertFrom-Json
if ($result.mode -ne 'offline-no-ui' -or $result.liveGameVerified -ne $false -or $result.provisional -ne $true -or
    $result.runtimePanelLocatorImplemented -ne $false -or $result.actualSelectionConfirmed -ne $false -or
    $result.feature -ne 'owned-augment-visual-evidence-core' -or
    $result.limitation -ne 'shape-only-cannot-distinguish-unseen-identical-icons' -or $result.checks -lt 1) {
    throw 'Owned verification fixture output did not meet its offline contract.'
}
$result | ConvertTo-Json -Compress
