param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [string]$WorkPath
)
$ErrorActionPreference = 'Stop'
$executable = [IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build the desktop executable first.' }
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
if ([version]$version.FileVersion -lt [version]'1.13.1.0') { throw 'This executable does not support the AppData redirection instance fixtures.' }
if (-not $WorkPath) { $WorkPath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-native-instance') }
$work = [IO.Path]::GetFullPath($WorkPath)
New-Item -ItemType Directory -Path $work -Force | Out-Null
$runId = [Guid]::NewGuid().ToString('N')
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executable
# This mode creates a fresh generated subdirectory and a message-only receiver.
# It never constructs MainWindow, reads installed settings or samples a game.
$start.Arguments = '--instance-self-test "' + $work.TrimEnd('\') + '"'
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
        $process.Kill() # Only this script's isolated fixture process.
        throw 'Isolated instance fixtures exceeded 30 seconds.'
    }
    $output = $outputTask.GetAwaiter().GetResult()
    $errors = $errorTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $work ($runId + '.stdout.json')), $output, (New-Object Text.UTF8Encoding($false)))
    [IO.File]::WriteAllText((Join-Path $work ($runId + '.stderr.txt')), $errors, (New-Object Text.UTF8Encoding($false)))
    if ($process.ExitCode -ne 0) { throw ('Instance fixtures failed: ' + $errors) }
} finally { $process.Dispose() }
$result = $output | ConvertFrom-Json
if ($result.mode -ne 'offline-instance-no-ui' -or $result.liveGameVerified -ne $false -or $result.checks -lt 22) { throw 'Unexpected instance fixture contract.' }
$result | ConvertTo-Json -Compress
