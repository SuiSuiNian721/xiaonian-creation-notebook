$ErrorActionPreference = 'Stop'
$workbenchRoot = $PSScriptRoot
$packaged = Join-Path $workbenchRoot 'dist-workbench-release\win-unpacked\小念的创作笔记.exe'
Write-Host '正在打开小念的创作笔记…'
foreach ($name in @('ELECTRON_RUN_AS_NODE', 'AI_FUTURE_WORKBENCH_QA', 'AI_FUTURE_WORKBENCH_QA_SUITE', 'AI_FUTURE_WORKBENCH_QA_DIR', 'AI_FUTURE_WORKBENCH_PROFILE_DIR')) {
    Remove-Item -LiteralPath "Env:\$name" -ErrorAction SilentlyContinue
}
try {
    if (Test-Path -LiteralPath $packaged) {
        Start-Process -FilePath $packaged -WorkingDirectory (Split-Path -Parent $packaged) -WindowStyle Normal
    } else {
        Write-Host '正在使用本机开发运行时启动…'
        & node (Join-Path $workbenchRoot 'tools\workbench.mjs')
        if ($LASTEXITCODE -ne 0) { throw '工作台启动失败，请查看上方错误。' }
    }
} catch {
    Write-Host "无法打开工作台：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
