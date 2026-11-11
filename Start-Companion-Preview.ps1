#requires -Version 7.0
param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$packageDirectory = Join-Path $projectDirectory 'dist-workbench-companion-immersive\win-unpacked'
$executable = Join-Path $packageDirectory 'AI未来 工作台.exe'
$profileDirectory = [System.IO.Path]::GetFullPath((Join-Path $projectDirectory 'artifacts\companion-preview-profile'))
if (-not $profileDirectory.StartsWith($projectDirectory + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '预览资料位置越出当前项目。' }
if (-not $PrepareOnly -and -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '请先构建 dist-workbench-companion-immersive 候选程序。' }
$runtimeNode = Join-Path $packageDirectory 'resources\airi-minecraft\runtime\node.exe'
if (-not (Test-Path -LiteralPath $runtimeNode -PathType Leaf)) { $runtimeNode = (Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }

# 只读借用已有 AI 连接；预览资料独立保存，后续启动不覆盖预览中的编辑。
$prepareScript = @'
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {WorkbenchStore} from './framework/store.mjs';
const profile=process.argv[2];
const target=new WorkbenchStore(join(profile,'data'));
try {
  if(!target.getSetting('preview.companion.seeded')) {
    const originalPath=join(process.env.APPDATA,'AI-Future-Workbench/data/workbench.sqlite');
    if(existsSync(originalPath)) {
      const original=new DatabaseSync(originalPath,{readOnly:true});
      try {
        for(const name of ['ai.connection','ai.module.companion','ai.sharedConfigured','preferences']) {
          const row=original.prepare('SELECT value FROM settings WHERE name=?').get(name);
          if(row)target.setSetting(name,JSON.parse(row.value));
        }
      } finally {original.close();}
    }
    target.setSetting('preview.companion.seeded',true);
  }
  target.setEnabled('companion',true);
} finally {target.close();}
console.log('虚拟陪伴预览资料已准备。');
'@
Push-Location -LiteralPath $projectDirectory
try {
  $prepareScript | & $runtimeNode --input-type=module - $profileDirectory
  if ($LASTEXITCODE -ne 0) { throw '预览资料准备失败。' }
} finally { Pop-Location }
if ($PrepareOnly) { return }

# 显式传递隔离环境，并把日志直接写入文件；启动终端退出不会切断日志管道。
& $runtimeNode (Join-Path $projectDirectory 'tools\launch-workbench-preview.mjs') $executable $profileDirectory
if ($LASTEXITCODE -ne 0) { throw '虚拟陪伴预览启动失败。' }
