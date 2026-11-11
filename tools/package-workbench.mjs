import { existsSync,mkdirSync,writeFileSync,readdirSync,readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,resolve,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { buildComponentPackages } from './package-components.mjs';
import { WORKBENCH_VERSION,createWorkbenchBuildConfig,assertBasePackage } from './workbench-package-config.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(root,process.env.AI_FUTURE_PACKAGE_OUTPUT || 'dist-workbench-release');
const outputRelative=relative(root,output);
if(!outputRelative || outputRelative==='..' || outputRelative.startsWith('..'+sep) || isAbsolute(outputRelative))throw new Error('构建输出必须位于当前工程的独立子目录内。');
const toolkit=process.env.AI_FUTURE_BUILD_TOOLS || 'F:\\小汐的研究日志';
const requireTools=createRequire(resolve(toolkit,'package.json'));
const {build,Platform,Arch}=requireTools('electron-builder');
const electronDist=resolve(toolkit,'node_modules/electron/dist');
if(!existsSync(resolve(electronDist,'electron.exe'))) throw new Error('Electron 构建运行时不存在。');
const electronVersion=requireTools('electron/package.json').version;
const workbenchVersion=WORKBENCH_VERSION;
for(const dependency of ['quickjs-emscripten','ejs','yaml','json5','smol-toml'])if(!existsSync(resolve(root,'node_modules',dependency,'package.json')))throw new Error('请先在项目根目录执行 npm ci，准备运行端依赖：'+dependency);
const catalogPath=process.env.AI_FUTURE_COMPONENT_CATALOG ? resolve(root,process.env.AI_FUTURE_COMPONENT_CATALOG) : (await buildComponentPackages({root})).catalogPath;
const componentCatalog=JSON.parse(readFileSync(catalogPath,'utf8'));
if(componentCatalog.format!==1 || !componentCatalog.components?.['mc-play'] || !componentCatalog.components?.training)throw new Error('组件发布目录不完整。');
const artifacts=await build({projectDir:root,targets:Platform.WINDOWS.createTarget('dir',Arch.x64),config:createWorkbenchBuildConfig({root,output,electronDist,electronVersion,catalogPath})});
mkdirSync(output,{recursive:true});
const packagedApp=resolve(output,'win-unpacked/resources/app');
const characterRuntimeCheck=spawnSync(process.execPath,['--no-node-snapshot',resolve(packagedApp,'framework/character-runtime/self-test.mjs')],{encoding:'utf8',windowsHide:true,timeout:20000});
if(characterRuntimeCheck.status!==0)throw new Error('打包后的角色运行端自检失败：'+(characterRuntimeCheck.stderr||characterRuntimeCheck.error?.message||characterRuntimeCheck.stdout));
console.log(characterRuntimeCheck.stdout.trim());
const sourceFiles={};
function verifySource(path) {
  const absolute=resolve(root,path);
  for(const entry of readdirSync(absolute,{withFileTypes:true})) {
    if(entry.name==='__pycache__'||entry.name.endsWith('.pyc'))continue;
    const child=path+'/'+entry.name;
    if(entry.isSymbolicLink())throw new Error('源码检查不接受链接：'+child);
    if(entry.isDirectory())verifySource(child);
    else {
      const sourceHash=createHash('sha256').update(readFileSync(resolve(root,child))).digest('hex');
      const packageHash=createHash('sha256').update(readFileSync(resolve(packagedApp,child))).digest('hex');
      if(sourceHash!==packageHash)throw new Error('包内文件与源码不一致：'+child);
      sourceFiles[child]=sourceHash;
    }
  }
}
for(const folder of ['framework','public-workbench','resources/media','resources/voice','resources/companion','integrations/comfy','integrations/moss-voice','integrations/qwen-voice'])verifySource(folder);
for(const path of ['desktop/workbench.cjs','desktop/external-resources.cjs','desktop/path-picker.cjs','desktop/downloads.cjs','desktop/workbench-preload.cjs','desktop/workbench-immersion.cjs','desktop/companion-host.cjs','desktop/companion-life.cjs','desktop/companion-electron.mjs','desktop/companion-preload.cjs','desktop/companion-branding.cjs','desktop/companion-presentation.cjs','desktop/process-stdio.cjs','desktop/process-log-window.cjs','tools/qq-extract.ps1','tools/ComfyUI-ProcessControl.ps1','tools/qa-companion.mjs','tools/qa-drawing-manager.mjs','tools/qa-drawing.mjs','tools/qa-launcher-split.mjs','tools/qa-process-log.mjs','tools/qa-workbench.mjs','tools/qa-card-studio.mjs','tools/workbench-mcp.mjs']) {
  const hash=createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex');
  if(hash!==createHash('sha256').update(readFileSync(resolve(packagedApp,path))).digest('hex'))throw new Error('包内入口与源码不一致：'+path);
  sourceFiles[path]=hash;
}
const gitValue=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error('无法记录源码版本。');return result.stdout.trim();};
const catalogHash=createHash('sha256').update(readFileSync(catalogPath)).digest('hex');
if(catalogHash!==createHash('sha256').update(readFileSync(resolve(output,'win-unpacked/resources/component-catalog.json'))).digest('hex'))throw new Error('包内组件发布目录与构建输入不一致。');
const buildRecord={at:new Date().toISOString(),productName:'小念的创作笔记',workbenchVersion,electronVersion,sourceCommit:gitValue(['rev-parse','HEAD']),sourceBranch:gitValue(['branch','--show-current']),sourceDirty:!!gitValue(['status','--porcelain']),sourceFiles,artifacts,modules:9,bundledIntegrations:[{id:'xiaoxi',version:'0.1.29'},{id:'minecraft-pixel-skin',version:'0.2.1',eyeTemplates:{eye_A:'1.0.0',eye_B:'1.0.0'}}],optionalComponents:componentCatalog.components,componentCatalogSha256:catalogHash,externalModelsBundled:false,bundledCharacterModels:[{id:'ds-whale',license:'CC BY-NC-SA 4.0'}]};
writeFileSync(resolve(output,'build-record.json'),JSON.stringify(buildRecord,null,2),'utf8');
writeFileSync(resolve(packagedApp,'build-record.json'),JSON.stringify(buildRecord,null,2),'utf8');
const packageFiles=await assertBasePackage({directory:resolve(output,'win-unpacked')});
writeFileSync(resolve(output,'package-files.json'),JSON.stringify(packageFiles,null,2),'utf8');
console.log(`已核对 ${Object.keys(sourceFiles).length} 个源码文件的包内 SHA256。`);
console.log(`基础包共 ${packageFiles.files.length} 个文件，${packageFiles.bytes} 字节；可选组件和模型排除门禁通过。`);
console.log('Windows 工作台已构建至 '+resolve(output,'win-unpacked')+'。');
