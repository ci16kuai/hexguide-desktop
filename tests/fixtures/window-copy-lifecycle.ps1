param([string]$Root, [string]$Work)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Work -Force | Out-Null
$output = Join-Path $Work 'window-copy-lifecycle.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
# WinRT is fault-injected in the fixture; no WinMD or user capture is loaded.
$arguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output',
    ('/out:' + $output), '/main:HexGuide.Desktop.WindowCopyLifecycleFixture',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll',
    (Join-Path $Root 'native\GameWindowCapture.cs'), (Join-Path $Root 'tests\fixtures\window-copy-lifecycle.cs'))
$buildOutput = & $compiler @arguments 2>&1
if ($LASTEXITCODE -ne 0) { throw ($buildOutput -join "`n") }
& $output
if ($LASTEXITCODE -ne 0) { throw 'Window copy lifecycle regression failed.' }
