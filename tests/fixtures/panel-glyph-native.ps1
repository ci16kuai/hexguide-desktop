param([string]$Root, [string]$Work)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Path $Work -Force | Out-Null
# Keep the production ModelValue parser in this offline compilation. The only
# replacement is the game metadata entry point, which throws if ever invoked.
$program = [IO.File]::ReadAllText((Join-Path $Root 'native\Program.cs'))
$start = $program.IndexOf('    internal static class ModelValue')
$end = $program.IndexOf('    // Foreground tracking reads window metadata.', $start)
if ($start -lt 0 -or $end -le $start) { throw 'Production model helper boundary changed.' }
$compatibility = @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
namespace HexGuide.Desktop {
'@ + $program.Substring($start, $end - $start) + @'
internal static class GameWindow {
internal static bool IsVerifiedGame(IntPtr value) { throw new InvalidOperationException("Offline fixture forbids game/window access."); }
}
}
'@
$compatibilityPath = Join-Path $Work 'offline-model.cs'
[IO.File]::WriteAllText($compatibilityPath, $compatibility, (New-Object Text.UTF8Encoding($false)))
$output = Join-Path $Work 'panel-glyph-native.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$compilerArguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/utf8output', '/codepage:65001', ('/out:' + $output), '/main:HexGuide.Desktop.PanelGlyphNativeFixture',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    (Join-Path $Root 'native\OwnedPanelWatcher.cs'), (Join-Path $Root 'native\ScreenSelectionWatcher.cs'), (Join-Path $Root 'native\SelectionCaptureRetry.cs'), (Join-Path $Root 'native\EarlySelectionReplay.cs'), (Join-Path $Root 'native\RecognitionTrace.cs'), (Join-Path $Root 'native\CardTitleIdentity.cs'),
    $compatibilityPath, (Join-Path $Root 'tests\fixtures\panel-glyph-native.cs'))
$compilerArguments += @((Join-Path $Root 'native\WindowSelectionCapture.cs'), (Join-Path $Root 'native\SelectionFrameSynchronizer.cs'), (Join-Path $Root 'native\GameWindowCapture.cs'))
foreach ($metadata in @('Windows.Foundation.winmd', 'Windows.Graphics.winmd', 'Windows.Storage.winmd')) {
    $compilerArguments += '/reference:' + (Join-Path $env:WINDIR ('System32\WinMetadata\' + $metadata))
}
$compilerArguments += '/reference:' + (Join-Path ${env:ProgramFiles(x86)} 'Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8\Facades\System.Runtime.dll')
$buildOutput = & $compiler @compilerArguments 2>&1
if ($LASTEXITCODE -ne 0) { throw ($buildOutput -join "`n") }
& $output (Join-Path $Root 'tests\fixtures\panel-glyphs')
if ($LASTEXITCODE -ne 0) { throw 'Offline native glyph regression failed.' }
