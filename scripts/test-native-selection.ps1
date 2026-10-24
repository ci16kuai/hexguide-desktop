param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [string]$WorkPath
)
$ErrorActionPreference = 'Stop'
$executable = [IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build the desktop executable before running selection fixtures.' }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
if ([version]$version.FileVersion -lt [version]'1.10.2.0') {
    throw 'This executable predates the no-UI selection test entry point; it must not be launched by this script.'
}
if (-not $WorkPath) { $WorkPath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-native-selection') }
$work = [IO.Path]::GetFullPath($WorkPath)
New-Item -ItemType Directory -Path $work -Force | Out-Null
$runId = [Guid]::NewGuid().ToString('N')
$stdout = Join-Path $work ($runId + '.stdout.json')
$stderr = Join-Path $work ($runId + '.stderr.txt')
# This flag is handled before WinForms initialization and runs only generated
# numeric/bitmap fixtures. It never opens the application or accesses a game.
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executable
$start.Arguments = '--selection-self-test'
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
        $process.Kill() # Only this script's isolated fixture child, never an installed app.
        throw 'The isolated selection fixture process did not finish within 30 seconds.'
    }
    [IO.File]::WriteAllText($stdout, $outputTask.GetAwaiter().GetResult(), (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText($stderr, $errorTask.GetAwaiter().GetResult(), (New-Object Text.UTF8Encoding($false)))
    if ($process.ExitCode -ne 0) { throw ('Selection fixtures failed: ' + [IO.File]::ReadAllText($stderr)) }
} finally { $process.Dispose() }
$result = [IO.File]::ReadAllText($stdout) | ConvertFrom-Json
if ($result.mode -ne 'offline-no-ui' -or $result.liveGameVerified -ne $false -or $result.checks -lt 1) {
    throw 'The isolated fixture result did not match the no-UI test contract.'
}
$result | ConvertTo-Json -Compress
