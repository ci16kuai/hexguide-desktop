param(
    [string]$NodePath,
    [string]$WorkPath
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $WorkPath) {
    if (-not (Test-Path -LiteralPath 'H:\Chatgpt' -PathType Container)) {
        throw 'Pass -WorkPath to choose where verification logs, temporary files and previews are saved.'
    }
    $WorkPath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-verification')
}
$work = [IO.Path]::GetFullPath($WorkPath)
$run = Join-Path $work ('run-' + (Get-Date -Format 'yyyyMMddTHHmmssfff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work -Force | Out-Null
# Never reuse a staging directory or clean another run's files.
New-Item -ItemType Directory -Path $run | Out-Null
$logs = Join-Path $run 'logs'
$temporary = Join-Path $run 'tmp'
$testWork = Join-Path $run 'test-work'
$previews = Join-Path $run 'previews'
$stage = Join-Path $run 'portable'
New-Item -ItemType Directory -Path $logs, $temporary, $testWork, $previews -Force | Out-Null
$summaryPath = Join-Path $run 'summary.json'
$utf8 = New-Object Text.UTF8Encoding($false)
$summary = [ordered]@{
    schemaVersion = 1
    scope = 'offline-desktop'
    liveGameVerified = $false
    status = 'running'
    projectRoot = $projectRoot
    runPath = $run
    startedAt = [DateTime]::UtcNow.ToString('o')
    finishedAt = $null
    failedStage = $null
    error = $null
    stages = @()
}
foreach ($name in @('preflight', 'node-tests', 'build', 'native-selection', 'native-instance', 'sidebar-preview')) {
    $summary.stages += [ordered]@{ name = $name; status = 'not-run' }
}
$currentStage = 'preflight'

function Save-Summary {
    [IO.File]::WriteAllText($summaryPath, ($summary | ConvertTo-Json -Depth 12), $utf8)
}

function Quote-ProcessArgument([string]$Argument) {
    # Windows CommandLineToArgvW quoting; no shell interprets these arguments.
    '"' + (($Argument -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-Stage {
    param([string]$Name, [string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds, [scriptblock]$Validate)
    $entry = $summary.stages | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    $entry.status = 'running'
    $entry.startedAt = [DateTime]::UtcNow.ToString('o')
    $entry.stdoutPath = Join-Path $logs ($Name + '.stdout.txt')
    $entry.stderrPath = Join-Path $logs ($Name + '.stderr.txt')
    Save-Summary
    Write-Output ('Running ' + $Name + '...')
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $start.WorkingDirectory = $projectRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.Encoding]::UTF8
    $start.StandardErrorEncoding = [Text.Encoding]::UTF8
    $start.EnvironmentVariables['TEMP'] = $temporary
    $start.EnvironmentVariables['TMP'] = $temporary
    $start.EnvironmentVariables['HEXGUIDE_TEST_WORK'] = $testWork
    $start.EnvironmentVariables['PATH'] = (Split-Path -Parent $NodePath) + ';' + $env:PATH
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $outputTask = $null
    $errorTask = $null
    try {
        $null = $process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill() # Only the child created by this stage.
            $null = $process.WaitForExit(5000)
            throw ($Name + ' exceeded ' + $TimeoutSeconds + ' seconds.')
        }
        $entry.exitCode = $process.ExitCode
        if (-not $outputTask.Wait(5000) -or -not $errorTask.Wait(5000)) {
            throw ($Name + ' left an output stream open after its process exited.')
        }
        $output = $outputTask.GetAwaiter().GetResult()
        if ($entry.exitCode -ne 0) { throw ($Name + ' exited with code ' + $entry.exitCode + '. See the stage logs.') }
        if ($Validate) { $entry.result = & $Validate $output }
        $entry.status = 'passed'
    } catch {
        $entry.status = 'failed'
        $entry.error = $_.Exception.Message
        throw
    } finally {
        $clock.Stop()
        $entry.durationMs = $clock.ElapsedMilliseconds
        $entry.finishedAt = [DateTime]::UtcNow.ToString('o')
        $outputText = if ($outputTask -and $outputTask.IsCompleted -and -not $outputTask.IsFaulted) { $outputTask.GetAwaiter().GetResult() } else { 'Output unavailable: process did not close its output stream.' }
        $errorText = if ($errorTask -and $errorTask.IsCompleted -and -not $errorTask.IsFaulted) { $errorTask.GetAwaiter().GetResult() } else { 'Error output unavailable: process did not close its error stream.' }
        [IO.File]::WriteAllText($entry.stdoutPath, $outputText, $utf8)
        [IO.File]::WriteAllText($entry.stderrPath, $errorText, $utf8)
        $process.Dispose()
        Save-Summary
    }
}

function Assert-PositiveInteger($Value, [string]$Name) {
    if ((-not ($Value -is [int]) -and -not ($Value -is [long])) -or $Value -lt 1) {
        throw ('The fixture contract requires a positive integer: ' + $Name)
    }
}

try {
    $summary.stages[0].status = 'running'
    if (-not $NodePath) {
        if ($env:HEXGUIDE_NODE_PATH) { $NodePath = $env:HEXGUIDE_NODE_PATH }
        else { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
    }
    $NodePath = [IO.Path]::GetFullPath($NodePath)
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js 20+ was not found. Pass -NodePath.' }
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $package = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json
    $summary.appVersion = [string]$package.version
    # Support the repository's plain node --test file list. Fail explicitly if
    # its structure changes; never evaluate package metadata as a shell command.
    $tokens = @(([string]$package.scripts.test).Trim() -split '\s+')
    if ($tokens.Count -lt 3 -or $tokens[0] -cne 'node' -or $tokens[1] -cne '--test') {
        throw 'Unsupported package.json test script. Expected node --test followed by tests/ or scripts/ .mjs paths.'
    }
    $testArguments = @('--test')
    foreach ($pattern in $tokens[2..($tokens.Count - 1)]) {
        if ($pattern -cnotmatch '^(tests|scripts)/[A-Za-z0-9_.*-]+\.mjs$') { throw ('Unsupported test argument: ' + $pattern) }
        $files = @(Get-ChildItem -Path (Join-Path $projectRoot $pattern) -File | Sort-Object FullName)
        if ($files.Count -eq 0) { throw ('No test files matched: ' + $pattern) }
        $testArguments += @($files | Select-Object -ExpandProperty FullName)
    }
    Invoke-Stage -Name 'preflight' -Executable $NodePath -Arguments @('--version') -TimeoutSeconds 30 -Validate {
        param($output)
        if ($output.Trim() -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 20) { throw 'Node.js 20+ is required.' }
        [ordered]@{ nodeVersion = $output.Trim(); testFiles = $testArguments.Count - 1 }
    }

    $currentStage = 'node-tests'
    Invoke-Stage -Name $currentStage -Executable $NodePath -Arguments $testArguments -TimeoutSeconds 1200
    $currentStage = 'build'
    Invoke-Stage -Name $currentStage -Executable $powershell -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'build-desktop.ps1'), '-NodePath', $NodePath, '-CachePath', (Join-Path $work 'build-cache'), '-StagePath', $stage) -TimeoutSeconds 600 -Validate {
        param($output)
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'HexGuide.exe') -PathType Leaf)) { throw 'The build did not produce the isolated executable.' }
        $build = [IO.File]::ReadAllText((Join-Path $stage 'build-info.json')) | ConvertFrom-Json
        if ($build.appVersion -ne $package.version -or $build.architecture -ne 'win-x64') { throw 'Unexpected build manifest.' }
        $build
    }
    $executable = Join-Path $stage 'HexGuide.exe'
    $currentStage = 'native-selection'
    Invoke-Stage -Name $currentStage -Executable $powershell -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-native-selection.ps1'), '-ExecutablePath', $executable, '-WorkPath', (Join-Path $run 'selection')) -TimeoutSeconds 60 -Validate {
        param($output)
        $result = $output | ConvertFrom-Json
        Assert-PositiveInteger $result.checks 'checks'
        if ($result.mode -ne 'offline-no-ui' -or $result.liveGameVerified -isnot [bool] -or $result.liveGameVerified) { throw 'Unexpected selection fixture contract.' }
        $result
    }
    $currentStage = 'native-instance'
    Invoke-Stage -Name $currentStage -Executable $powershell -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'test-native-instance.ps1'), '-ExecutablePath', $executable, '-WorkPath', (Join-Path $run 'instance')) -TimeoutSeconds 60 -Validate {
        param($output)
        $result = $output | ConvertFrom-Json
        Assert-PositiveInteger $result.checks 'checks'
        if ($result.mode -ne 'offline-instance-no-ui' -or $result.liveGameVerified -isnot [bool] -or $result.liveGameVerified -or $result.checks -lt 22) { throw 'Unexpected instance fixture contract.' }
        $result
    }
    $currentStage = 'sidebar-preview'
    Invoke-Stage -Name $currentStage -Executable $executable -Arguments @('--sidebar-self-test', (Join-Path $previews 'sidebar.png')) -TimeoutSeconds 60 -Validate {
        param($output)
        $result = $output | ConvertFrom-Json
        foreach ($field in @('checks', 'helpChecks', 'selectionChecks', 'pendingOfferChecks', 'passiveActivationChecks', 'augmentIconChecks', 'shortcutChecks', 'appearanceChecks', 'positionChecks', 'liveStateChecks', 'loadingPreviewChecks', 'buildStatisticsChecks', 'initialPlanChecks', 'visibilityChecks', 'width', 'height')) {
            Assert-PositiveInteger $result.$field $field
        }
        Add-Type -AssemblyName System.Drawing
        foreach ($field in @('previewPath', 'customPreviewPath', 'buildPreviewPath', 'placementPreviewPath', 'statusPreviewPath', 'loadingPreviewPath', 'earlyLivePreviewPath', 'iconPreviewPath', 'pendingPreviewPath')) {
            $imagePath = [string]$result.$field
            if (-not [IO.Path]::IsPathRooted($imagePath) -or -not ([IO.Path]::GetFullPath($imagePath)).StartsWith($previews + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $imagePath -PathType Leaf)) { throw ('Preview missing or outside this run: ' + $field) }
            $image = [Drawing.Image]::FromFile($imagePath)
            try {
                if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or $image.Width -lt 1 -or $image.Height -lt 1 -or $image.Width -gt 8192 -or $image.Height -gt 8192) { throw ('Invalid PNG preview: ' + $field) }
                if ($field -eq 'previewPath' -and ($image.Width -ne $result.width -or $image.Height -ne $result.height)) { throw 'Sidebar dimensions do not match the generated preview.' }
            } finally { $image.Dispose() }
        }
        $result
    }
    $summary.status = 'passed'
} catch {
    $summary.status = 'failed'
    $summary.failedStage = $currentStage
    $summary.error = $_.Exception.Message
    $entry = $summary.stages | Where-Object { $_.name -eq $currentStage } | Select-Object -First 1
    $entry.status = 'failed'
    $entry.error = $summary.error
} finally {
    $summary.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-Summary
}
Write-Output ('Verification summary: ' + $summaryPath)
if ($summary.status -ne 'passed') {
    [Console]::Error.WriteLine($summary.error)
    exit 1
}
Write-Output 'Offline verification passed. Live-game recognition and foreground transitions still require in-game acceptance.'
