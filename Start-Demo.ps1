$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
$packaged = Join-Path $demoRoot 'dist\win-unpacked\AI未来 Demo.exe'
if (Test-Path -LiteralPath $packaged) {
    Start-Process -FilePath $packaged -WorkingDirectory (Split-Path -Parent $packaged) -WindowStyle Normal
} else {
    & node (Join-Path $demoRoot 'tools\desktop.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Demo 启动失败，请查看终端错误。' }
}
