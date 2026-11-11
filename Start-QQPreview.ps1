$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$previewProfileDir = Join-Path $projectRoot 'artifacts\qq-preview-profile'
$candidates = @(@(
  $env:AI_FUTURE_ELECTRON,
  (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'),
  'F:\小汐的研究日志\node_modules\electron\dist\electron.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
if (-not $candidates) { throw '找不到 Electron 开发运行时，请先设置 AI_FUTURE_ELECTRON。' }
$env:AI_FUTURE_WORKBENCH_PROFILE_DIR = $previewProfileDir
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:AI_FUTURE_WORKBENCH_QA -ErrorAction SilentlyContinue
Remove-Item Env:AI_FUTURE_WORKBENCH_QA_SUITE -ErrorAction SilentlyContinue
Push-Location -LiteralPath $projectRoot
try {
  @'
import { join } from 'node:path';
import { WorkbenchStore } from './framework/store.mjs';
const store = new WorkbenchStore(join(process.env.AI_FUTURE_WORKBENCH_PROFILE_DIR, 'data'));
store.setEnabled('qq', true);
store.close();
'@ | node --input-type=module
  if ($LASTEXITCODE -ne 0) { throw '无法准备独立 QQ 预览资料。' }
  $entry = Join-Path $projectRoot 'tools\qq-preview.cjs'
  $process = Start-Process -FilePath $candidates[0] -ArgumentList @('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru
  Write-Output ('QQ 工作台预览已启动，PID：' + $process.Id)
  Write-Output ('资料目录：' + $previewProfileDir)
} finally {
  Pop-Location
}
