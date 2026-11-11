$ErrorActionPreference = 'Stop'
$demoRoot = $PSScriptRoot
$packaged = Join-Path $demoRoot 'dist-aurora\win-unpacked\AI未来 Aurora.exe'
# GUI 必须正常显示；不继承只用于测试或 Electron 子进程的运行模式。
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'AI_FUTURE_QA', 'AI_FUTURE_QA_DIR', 'AI_FUTURE_VARIANT', 'AI_FUTURE_PROFILE_DIR')) {
    Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $packaged) {
    Start-Process -FilePath $packaged -WorkingDirectory (Split-Path -Parent $packaged) -WindowStyle Normal
} else {
    & node (Join-Path $demoRoot 'tools\desktop.mjs') --aurora
    if ($LASTEXITCODE -ne 0) { throw 'Aurora 启动失败，请查看终端错误。' }
}
