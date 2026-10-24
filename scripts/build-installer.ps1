param(
    [string]$StagePath,
    [string]$AppVersion,
    [string]$CachePath,
    [string]$OutputPath,
    [switch]$TestScope
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $AppVersion) { $AppVersion = ([IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json).version }
if ($AppVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer requires a three-component numeric version.' }
if (-not $StagePath) { $StagePath = Join-Path $projectRoot ('artifacts\portable-' + $AppVersion) }
elseif (-not [IO.Path]::IsPathRooted($StagePath)) { $StagePath = Join-Path $projectRoot $StagePath }
$StagePath = [IO.Path]::GetFullPath($StagePath).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $StagePath 'HexGuide.exe') -PathType Leaf)) { throw 'Build the portable app first; no HexGuide.exe found in staging.' }
if ((Get-Item -LiteralPath $StagePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Staging path must not be a symbolic link or junction.' }
if (-not $CachePath) { $CachePath = 'H:\Chatgpt\work\2026-10-23\hexguide-desktop\nsis-tools' }
$CachePath = [IO.Path]::GetFullPath($CachePath)
if (-not $OutputPath) { $OutputPath = Join-Path (Split-Path -Parent $projectRoot) ("HexGuide-Setup-$AppVersion.exe") }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if ($OutputPath.StartsWith($StagePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer output must be outside the staging folder.' }
New-Item -ItemType Directory -Path $CachePath, (Split-Path -Parent $OutputPath) -Force | Out-Null

# Official NSIS portable compiler. Digest published on the SourceForge download page.
$nsisVersion = '3.13'
$nsisSha256 = 'BA63DFFC4410EE89193E1CB5A41989991BD77C61068DA17E3156D136B7B0B3D8'
$nsisUrl = "https://sourceforge.net/projects/nsis/files/NSIS%203/$nsisVersion/nsis-$nsisVersion.zip/download"
$archive = Join-Path $CachePath "nsis-$nsisVersion.zip"
if (-not (Test-Path -LiteralPath $archive)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $downloadPage = Invoke-WebRequest -UseBasicParsing -Uri $nsisUrl
    $mirrorPattern = 'https://downloads\.sourceforge\.net/project/nsis/NSIS%203/' + [regex]::Escape($nsisVersion) + '/nsis-' + [regex]::Escape($nsisVersion) + '\.zip[^"\s<>]*'
    $downloadUrl = [Net.WebUtility]::HtmlDecode([regex]::Match($downloadPage.Content, $mirrorPattern).Value)
    if (-not $downloadUrl) { throw 'The official NSIS download page did not provide a download URL.' }
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archive
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $nsisSha256) { throw 'NSIS compiler archive digest mismatch; remove cached archive and retry.' }
$toolRoot = Join-Path $CachePath "nsis-$nsisVersion"
$compiler = Join-Path $toolRoot 'makensis.exe'
if (-not (Test-Path -LiteralPath $compiler)) { Expand-Archive -LiteralPath $archive -DestinationPath $CachePath -Force }
Copy-Item -LiteralPath (Join-Path $toolRoot 'COPYING') -Destination (Join-Path $StagePath 'licenses\NSIS-LICENSE.txt') -Force

# Enumerate an allowlist of shipped files. appdata, credentials, logs and caches are excluded.
$entryNames = @('HexGuide.exe', 'HexGuide.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'runtime', 'licenses', 'dist', 'server', 'native', 'docs', 'package.json', 'build-info.json', '开始使用.txt', 'README.md', 'README-data.md', 'README-statistics.md', 'PRIVACY.md', 'THIRD-PARTY-NOTICES.md')
$files = @()
foreach ($entryName in $entryNames) {
    $entryPath = Join-Path $StagePath $entryName
    if (-not (Test-Path -LiteralPath $entryPath)) { continue }
    $entry = Get-Item -LiteralPath $entryPath -Force
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cannot package staging link: $entryName" }
    if ($entry.PSIsContainer) {
        $children = @(Get-ChildItem -LiteralPath $entryPath -Recurse -Force)
        if ($children | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "Cannot package staging links inside: $entryName" }
        $files += @($children | Where-Object { -not $_.PSIsContainer })
    } else { $files += $entry }
}
$files = @($files | Sort-Object FullName)
if (-not $files.Count) { throw 'No payload files found.' }
function ConvertTo-NsisLiteral([string]$Value) {
    return $Value.Replace('$', '$$').Replace('"', '$\"').Replace("`r", '').Replace("`n", '')
}
$installLines = [Collections.Generic.List[string]]::new()
$removeLines = [Collections.Generic.List[string]]::new()
$payloadDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$installLines.Add('!macro InstallPayload')
$removeLines.Add('!macro RemovePayload')
$totalBytes = 0L
foreach ($file in $files) {
    $relative = $file.FullName.Substring($StagePath.Length + 1)
    $relativeDirectory = [IO.Path]::GetDirectoryName($relative)
    $destination = '$INSTDIR'
    if ($relativeDirectory) {
        $destination += '\' + (ConvertTo-NsisLiteral $relativeDirectory)
        $directory = $relativeDirectory
        while ($directory) { [void]$payloadDirectories.Add($directory); $directory = [IO.Path]::GetDirectoryName($directory) }
    }
    $installLines.Add('  SetOutPath "' + $destination + '"')
    $installLines.Add('  File "' + (ConvertTo-NsisLiteral $file.FullName) + '"')
    $removeLines.Add('  Delete "$INSTDIR\' + (ConvertTo-NsisLiteral $relative) + '"')
    $totalBytes += $file.Length
}
foreach ($directory in @($payloadDirectories | Sort-Object { $_.Length } -Descending)) { $removeLines.Add('  RMDir "$INSTDIR\' + (ConvertTo-NsisLiteral $directory) + '"') }
$installLines.Add('!macroend')
$removeLines.Add('!macroend')
$manifestPath = Join-Path $CachePath ('payload-' + $AppVersion + $(if ($TestScope) { '-test' } else { '' }) + '.nsh')
[IO.File]::WriteAllLines($manifestPath, @($installLines.ToArray()) + @($removeLines.ToArray()), [Text.UTF8Encoding]::new($true))
$identity = if ($TestScope) { 'HexGuideInstallerTest' } else { 'HexGuide' }
$shortcutName = if ($TestScope) { 'HexGuide Installer Test' } else { '海克斯指南' }
$title = if ($TestScope) { '海克斯指南（安装验证）' } else { '海克斯指南' }
$arguments = @('/V2', '/INPUTCHARSET', 'UTF8', "/DAPP_VERSION=$AppVersion", "/DPAYLOAD_MANIFEST=$manifestPath", "/DSETUP_OUTPUT=$OutputPath", "/DAPP_ICON=$(Join-Path $projectRoot 'native\assets\hexguide.ico')", "/DPRODUCT_ID=$identity", "/DSHORTCUT_NAME=$shortcutName", "/DAPP_TITLE=$title", ('/DESTIMATED_SIZE_KB=' + [Math]::Ceiling($totalBytes / 1024)), (Join-Path $projectRoot 'installer\hexguide.nsi'))
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'NSIS installer compilation failed.' }
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash.ToLowerInvariant()
$result = [ordered]@{ path = $OutputPath; version = $AppVersion; bytes = (Get-Item -LiteralPath $OutputPath).Length; sha256 = $hash; payloadFiles = $files.Count; payloadBytes = $totalBytes; testScope = [bool]$TestScope; compilerVersion = $nsisVersion; compilerSha256 = $nsisSha256.ToLowerInvariant() }
[IO.File]::WriteAllText($OutputPath + '.sha256', "$hash  $([IO.Path]::GetFileName($OutputPath))`n", [Text.UTF8Encoding]::new($false))
$result | ConvertTo-Json -Depth 3
