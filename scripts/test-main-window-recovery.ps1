param(
    [string]$WorkPath,
    [string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
$source = [IO.Path]::GetFullPath($SourceRoot)
if (-not $WorkPath) { $WorkPath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-main-window-recovery') }
$work = [IO.Path]::GetFullPath($WorkPath)
$run = Join-Path $work ('run-' + (Get-Date -Format 'yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $run -Force | Out-Null
$helper = Join-Path $source 'native\MainWindowRecovery.cs'
$fixture = Join-Path $source 'native\MainWindowRecoveryFixtures.cs'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($path in @($helper, $fixture, $compiler)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Required recovery fixture input is missing: ' + $path) }
}
$executable = Join-Path $run 'MainWindowRecoveryFixtures.exe'
$arguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    ('/out:' + $executable), $helper, $fixture)
$compileOutput = & $compiler @arguments 2>&1
$compileExitCode = $LASTEXITCODE
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $run 'compile.stdout.txt'), ($compileOutput -join [Environment]::NewLine), $utf8)
if ($compileExitCode -ne 0) { throw ('Recovery fixture compilation failed. See ' + (Join-Path $run 'compile.stdout.txt')) }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executable
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
# Only the newly compiled fixture process is launched. Its plain Forms live on
# a new desktop which is never switched into view; it loads no app/backend.
$process = New-Object Diagnostics.Process
$process.StartInfo = $start
try {
    $null = $process.Start()
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(25000)) {
        $process.Kill() # Only this script's generated, isolated fixture process.
        throw 'Isolated main-window recovery fixtures exceeded 25 seconds.'
    }
    $output = $outputTask.GetAwaiter().GetResult()
    $errors = $errorTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $run 'stdout.json'), $output, $utf8)
    [IO.File]::WriteAllText((Join-Path $run 'stderr.txt'), $errors, $utf8)
    [IO.File]::WriteAllText((Join-Path $run 'exitcode.txt'), [string]$process.ExitCode, $utf8)
    if ($process.ExitCode -ne 0) { throw ('Recovery fixtures failed: ' + $errors) }
} finally { $process.Dispose() }
$result = $output | ConvertFrom-Json
if ($result.mode -ne 'isolated-main-window-recovery' -or $result.desktop -ne 'isolated-not-switched' -or
    $result.liveGameVerified -ne $false -or $result.checks -lt 30) { throw 'Unexpected main-window recovery fixture contract.' }
$result | Add-Member -NotePropertyName runDirectory -NotePropertyValue $run
$result | Add-Member -NotePropertyName helperSha256 -NotePropertyValue (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
$result | Add-Member -NotePropertyName fixtureSha256 -NotePropertyValue (Get-FileHash -LiteralPath $fixture -Algorithm SHA256).Hash
$result | ConvertTo-Json -Compress
