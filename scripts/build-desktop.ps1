param(
    [string]$NodePath,
    [string]$CachePath,
    [switch]$Package,
    [string]$ArchivePath,
    [string]$AppVersion,
    [string]$StagePath
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $AppVersion) {
    $packageMetadata = [IO.File]::ReadAllText((Join-Path $projectRoot 'package.json')) | ConvertFrom-Json
    $AppVersion = [string]$packageMetadata.version
}
if (-not $AppVersion -or $AppVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw 'A valid application version is required in package.json or -AppVersion.'
}
if (-not $StagePath) { $StagePath = Join-Path $projectRoot 'artifacts\portable' }
elseif (-not [IO.Path]::IsPathRooted($StagePath)) { $StagePath = Join-Path $projectRoot $StagePath }
$stage = [IO.Path]::GetFullPath($StagePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
$stagePrefix = $stage + [IO.Path]::DirectorySeparatorChar
if (-not $stage -or $stage -eq [IO.Path]::GetPathRoot($stage).TrimEnd([IO.Path]::DirectorySeparatorChar) -or
    $stage.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $projectRoot.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The staging folder must not be a drive root, the project root, or an ancestor of the project.'
}
foreach ($sourceDirectory in @('dist', 'server', 'native', 'scripts', 'docs', '.git')) {
    $sourceRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $sourceDirectory))
    if ($stage.Equals($sourceRoot, [StringComparison]::OrdinalIgnoreCase) -or $stage.StartsWith($sourceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The staging folder must not be inside a source folder.'
    }
}
if ((Test-Path -LiteralPath $stage) -and ((Get-Item -LiteralPath $stage -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'The staging folder must not be a junction or symbolic link.'
}
$sdkVersion = '1.0.4258.31'
$sdkHash = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'

if (-not $NodePath) {
    if ($env:HEXGUIDE_NODE_PATH) { $NodePath = $env:HEXGUIDE_NODE_PATH }
    else {
        $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($nodeCommand) { $NodePath = $nodeCommand.Source }
    }
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js 20+ is required. Pass -NodePath C:\path\to\node.exe.'
}
$nodeVersion = (& $NodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 20) { throw 'Node.js 20+ is required.' }
if (-not $CachePath) {
    if ($env:HEXGUIDE_BUILD_CACHE) { $CachePath = $env:HEXGUIDE_BUILD_CACHE }
    elseif (Test-Path -LiteralPath 'H:\Chatgpt') { $CachePath = Join-Path 'H:\Chatgpt\work' ((Get-Date -Format 'yyyy-MM-dd') + '\hexguide-desktop\build-cache') }
    else { $CachePath = Join-Path $projectRoot '.build-cache' }
}
$CachePath = [IO.Path]::GetFullPath($CachePath)
New-Item -ItemType Directory -Path $CachePath, $stage, (Join-Path $stage 'runtime'), (Join-Path $stage 'licenses') -Force | Out-Null
$sdkArchive = Join-Path $CachePath "microsoft.web.webview2.$sdkVersion.zip"
if (-not (Test-Path -LiteralPath $sdkArchive)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $sdkArchive
}
if ((Get-FileHash -LiteralPath $sdkArchive -Algorithm SHA256).Hash -ne $sdkHash) { throw 'WebView2 package integrity check failed. Remove the cached package and try again.' }
$sdk = Join-Path $CachePath "webview2-$sdkVersion"
if (-not (Test-Path -LiteralPath (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'))) {
    Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdk -Force
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.8 developer tools are required on the build computer.' }
$references = @(
    'System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Web.Extensions.dll',
    (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'),
    (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll')
)
$compilerArguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001',
    ('/out:' + (Join-Path $stage 'HexGuide.exe')), ('/win32manifest:' + (Join-Path $projectRoot 'native\app.manifest')),
    ('/win32icon:' + (Join-Path $projectRoot 'native\assets\hexguide.ico')))
foreach ($reference in $references) { $compilerArguments += '/reference:' + $reference }
$compilerArguments += Join-Path $projectRoot 'native\Program.cs'
$compilerArguments += Join-Path $projectRoot 'native\SidebarShortcut.cs'
$compilerArguments += Join-Path $projectRoot 'native\ScreenSelectionWatcher.cs'
& $compiler @compilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Desktop launcher compilation failed.' }
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\HexGuide.exe.config') -Destination (Join-Path $stage 'HexGuide.exe.config') -Force
Copy-Item -LiteralPath (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'), (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'), (Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $stage -Force
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $stage 'runtime\node.exe') -Force
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $stage 'licenses\WebView2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdk 'NOTICE.txt') -Destination (Join-Path $stage 'licenses\WebView2-NOTICE.txt') -Force
$nodeLicense = Join-Path $CachePath "node-$nodeVersion-LICENSE.txt"
if (-not (Test-Path -LiteralPath $nodeLicense)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile $nodeLicense
}
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $stage 'licenses\Node-LICENSE.txt') -Force

# Only copy app sources. Credentials, local browser data, logs and build caches are never packaged.
foreach ($directory in @('dist', 'server', 'docs')) {
    $source = Join-Path $projectRoot $directory
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Missing source directory: $directory" }
    $destination = Join-Path $stage $directory
    if (Test-Path -LiteralPath $destination) {
        $resolvedDestination = [IO.Path]::GetFullPath($destination)
        $expectedStage = [IO.Path]::GetFullPath($stage) + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedDestination.StartsWith($expectedStage, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to clean outside the staging folder.' }
        if ((Get-Item -LiteralPath $resolvedDestination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a staging junction or symbolic link.' }
        Remove-Item -LiteralPath $resolvedDestination -Recurse -Force
    }
    Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stage 'native') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\scan-augments.ps1') -Destination (Join-Path $stage 'native\scan-augments.ps1') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination (Join-Path $stage 'package.json') -Force
foreach ($document in @('README.md', 'README-data.md', 'README-statistics.md', 'PRIVACY.md', 'THIRD-PARTY-NOTICES.md')) {
    if (Test-Path -LiteralPath (Join-Path $projectRoot $document)) { Copy-Item -LiteralPath (Join-Path $projectRoot $document) -Destination $stage -Force }
}
@"
海克斯指南桌面版 $AppVersion

完整解压到可写文件夹，双击 HexGuide.exe。
需要 Windows 10/11 x64、.NET Framework 4.8 和 Microsoft Edge WebView2 Runtime。
首次打开显示等待游戏是正常状态；进入游戏后才会读取本机游戏接口。
Alt+Shift+H 显示或收起游戏侧栏，支持无边框或窗口模式。
本地配置和浏览器缓存保存在软件旁 appdata 文件夹。
可使用 HexGuide.exe --data-dir ""H:\Chatgpt\hexguide-appdata"" 自定义保存位置。
关闭主窗口默认收进托盘，托盘菜单“完全退出”才停止助手。
屏幕自动确认处于实验测试阶段，未记录时可在侧栏手动确认；软件不会替你点击游戏。

缺少 WebView2 时从微软官网安装 Evergreen Runtime：
https://developer.microsoft.com/microsoft-edge/webview2/
"@ | Set-Content -LiteralPath (Join-Path $stage '开始使用.txt') -Encoding UTF8
$manifest = [ordered]@{ appVersion = $AppVersion; nodeVersion = $nodeVersion; webView2SdkVersion = $sdkVersion; architecture = 'win-x64'; builtAt = (Get-Date).ToUniversalTime().ToString('o') }
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'build-info.json') -Encoding UTF8
Write-Output "Portable app: $stage"
if ($Package) {
    if (-not $ArchivePath) { $ArchivePath = Join-Path (Split-Path -Parent $projectRoot) ('海克斯指南桌面版-' + $AppVersion + '.zip') }
    $ArchivePath = [IO.Path]::GetFullPath($ArchivePath)
    New-Item -ItemType Directory -Path (Split-Path -Parent $ArchivePath) -Force | Out-Null
    $packageEntries = @('package.json', 'HexGuide.exe', 'HexGuide.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'runtime', 'licenses', 'dist', 'server', 'native', 'docs', '开始使用.txt', 'build-info.json', 'README.md', 'README-data.md', 'README-statistics.md', 'PRIVACY.md', 'THIRD-PARTY-NOTICES.md')
    $archiveSources = @($packageEntries | ForEach-Object { $entry = Join-Path $stage $_; if (Test-Path -LiteralPath $entry) { $entry } })
    Compress-Archive -LiteralPath $archiveSources -DestinationPath $ArchivePath -CompressionLevel Optimal -Force
    Write-Output "Archive: $ArchivePath"
    Write-Output ('SHA256: ' + (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash)
}
