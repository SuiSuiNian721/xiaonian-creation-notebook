param(
    [string]$ProfileDirectory,
    [string]$EntryDirectory = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AI-Future-Workbench\desktop-entry'),
    [string]$DesktopDirectory = ([Environment]::GetFolderPath('Desktop')),
    [string]$IconPath
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$entryRoot = [IO.Path]::GetFullPath($EntryDirectory)
$configPath = Join-Path $entryRoot 'desktop-entry.json'
$previous = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json } else { $null }
if (-not $ProfileDirectory) {
    $ProfileDirectory = if ($previous.profileDirectory) { $previous.profileDirectory } else { Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'AI-Future-Workbench' }
}
$profileRoot = [IO.Path]::GetFullPath($ProfileDirectory)
$electronCandidates = @($env:AI_FUTURE_ELECTRON, (Join-Path $sourceRoot 'node_modules\electron\dist\electron.exe'), 'F:\小汐的研究日志\node_modules\electron\dist\electron.exe')
$electronPath = $electronCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $electronPath) { throw '未找到 Electron 运行时，桌面入口未更新。' }
$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path -LiteralPath $pwshPath)) { throw '请使用 PowerShell 7 安装桌面入口。' }
foreach ($required in @('desktop\workbench.cjs','tools\open-workbench-desktop.mjs','tools\Open-WorkbenchDesktop.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf)) { throw "启动文件缺失：$required" }
}
New-Item -ItemType Directory -Path $entryRoot -Force | Out-Null
$shortcutPath = Join-Path ([IO.Path]::GetFullPath($DesktopDirectory)) '小念的创作笔记.lnk'
$legacyShortcutPath = Join-Path ([IO.Path]::GetFullPath($DesktopDirectory)) 'AI-未来工作台.lnk'
$launcherPath = Join-Path $entryRoot 'Open-WorkbenchDesktop.ps1'
$backupFiles = @($configPath, $launcherPath, $shortcutPath, $legacyShortcutPath) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
if ($backupFiles) {
    $backupRoot = Join-Path $entryRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($backupFile in $backupFiles) { Copy-Item -LiteralPath $backupFile -Destination $backupRoot }
}
if (-not $IconPath) { $IconPath = Join-Path $sourceRoot 'public-workbench\app.ico' }
if ($IconPath -and [IO.Path]::GetExtension($IconPath) -eq '.ico') {
    Copy-Item -LiteralPath ([IO.Path]::GetFullPath($IconPath)) -Destination (Join-Path $entryRoot 'workbench.ico') -Force
} elseif ($IconPath) {
    Add-Type -AssemblyName System.Drawing
    $icon = [Drawing.Icon]::ExtractAssociatedIcon([IO.Path]::GetFullPath($IconPath))
    $iconStream = [IO.File]::Create((Join-Path $entryRoot 'workbench.ico'))
    try { $icon.Save($iconStream) } finally { $iconStream.Dispose(); $icon.Dispose() }
}
$config = [ordered]@{ version=1; sourceRoot=$sourceRoot; profileDirectory=$profileRoot; nodeExecutable=$nodePath; electronExecutable=[IO.Path]::GetFullPath($electronPath); installedAt=[DateTime]::UtcNow.ToString('o') }
$iconHash = (Get-FileHash -LiteralPath (Join-Path $entryRoot 'workbench.ico') -Algorithm SHA256).Hash.ToLowerInvariant()
$installedIcon = Join-Path $entryRoot ('workbench-' + $iconHash.Substring(0,16) + '.ico')
Copy-Item -LiteralPath (Join-Path $entryRoot 'workbench.ico') -Destination $installedIcon -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Open-WorkbenchDesktop.ps1') -Destination $launcherPath -Force
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$shellObject = New-Object -ComObject WScript.Shell
$shortcut = $shellObject.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $pwshPath
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $launcherPath + '"'
$shortcut.WorkingDirectory = $entryRoot
$shortcut.Description = '启动当前交付源码，沿用已有角色、聊天与配置。'
$shortcut.IconLocation = $installedIcon + ',0'
$shortcut.Save()
$readback = $shellObject.CreateShortcut($shortcutPath)
if ($readback.TargetPath -ne $pwshPath -or $readback.Arguments -notlike "*$launcherPath*" -or $readback.IconLocation -ne ($installedIcon + ',0')) { throw '桌面入口回读校验失败。' }
if (-not ('WorkbenchDesktopShell' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkbenchDesktopShell {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
}
[WorkbenchDesktopShell]::SHChangeNotify(0x00002000, 0x00002005, $shortcutPath, [IntPtr]::Zero)
if (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf) {
    $legacy = $shellObject.CreateShortcut($legacyShortcutPath)
    if ($legacy.Arguments -eq $shortcut.Arguments -and $legacy.TargetPath -eq $shortcut.TargetPath) {
        Remove-Item -LiteralPath $legacyShortcutPath
    }
}
[pscustomobject]@{shortcut=$shortcutPath;sourceRoot=$sourceRoot;profileDirectory=$profileRoot;config=$configPath;icon=$installedIcon} | ConvertTo-Json -Compress
