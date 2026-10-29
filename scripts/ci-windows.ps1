param(
    [Parameter(Mandatory = $true)][string]$WorkPath,
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$work = [IO.Path]::GetFullPath($WorkPath)
# Require an empty, separate work directory. Never clean a caller's files.
if ($work -eq [IO.Path]::GetPathRoot($work) -or
    $work.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $work.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $projectRoot.StartsWith($work.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'CI work must be outside the repository and cannot be a drive root or its ancestor.'
}
if (Test-Path -LiteralPath $work) {
    if ((Get-Item -LiteralPath $work -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'CI work cannot be a junction or symbolic link.' }
    if (@(Get-ChildItem -LiteralPath $work -Force).Count) { throw 'Use a new empty CI work directory for every run.' }
}
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$verification = Join-Path $work 'verification'
$diagnostics = Join-Path $work 'artifacts\diagnostics'
$packages = Join-Path $work 'artifacts\packages'
New-Item -ItemType Directory -Path $diagnostics, $packages -Force | Out-Null
$run = $null
try {
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-desktop.ps1') -NodePath $NodePath -WorkPath $verification
    $verifyExit = $LASTEXITCODE
    $runs = @(Get-ChildItem -LiteralPath $verification -Directory -Filter 'run-*')
    if ($runs.Count -ne 1) { throw 'Expected exactly one isolated verification run.' }
    $run = $runs[0].FullName
    $summary = [IO.File]::ReadAllText((Join-Path $run 'summary.json')) | ConvertFrom-Json
    if ($verifyExit -ne 0 -or $summary.status -ne 'passed') { throw 'Offline verification failed; see the diagnostics artifact.' }
    $version = [string]$summary.appVersion
    $stage = Join-Path $run 'portable'
    $installer = Join-Path $packages ("HexGuide-Setup-$version.exe")
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-installer.ps1') -StagePath $stage -AppVersion $version -CachePath (Join-Path $work 'nsis-tools') -OutputPath $installer *> (Join-Path $diagnostics 'installer-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed; see installer-build.log.' }
    # The verification stage is freshly built from the packaging allowlist.
    # Runtime appdata, local configuration, credentials and test scratch stay out.
    $archive = Join-Path $packages ("HexGuide-$version-windows-x64.zip")
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
    Copy-Item -LiteralPath (Join-Path $stage 'build-info.json') -Destination $packages
    $checksums = @($installer, $archive) | ForEach-Object {
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_)
    }
    [IO.File]::WriteAllLines((Join-Path $packages 'SHA256SUMS.txt'), $checksums, (New-Object Text.UTF8Encoding($false)))
    if ($env:GITHUB_STEP_SUMMARY) {
        @(
            '## HexGuide Windows verification passed',
            '',
            ('Version: **' + $version + '**'),
            '',
            'Node tests, native selection, instance handling, isolated main-window recovery and sidebar fixtures passed.',
            'Download the installer or portable ZIP from this run''s Windows artifact; SHA-256 checksums are included.',
            'These are unsigned CI builds. Offline checks do not establish live-game recognition accuracy.'
        ) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding UTF8
    }
    Write-Output ('Windows packages: ' + $packages)
} finally {
    # Keep only bounded verification output, never the entire work/cache tree.
    if ($run) {
        foreach ($entry in @('summary.json', 'logs', 'previews')) {
            $source = Join-Path $run $entry
            if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $diagnostics -Recurse -Force }
        }
    }
}
