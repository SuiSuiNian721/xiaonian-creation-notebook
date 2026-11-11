import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,copyFile,writeFile,rm,cp,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {symlink} from 'node:fs/promises';
import {minecraftRuntimeLaunch} from '../framework/mc-runtime-launch.mjs';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),integration=join(project,'integrations/airi-minecraft');
const available=process.platform==='win32'&&existsSync(join(integration,`node_modules/isolated-vm/prebuilds/win32-${process.arch}/isolated-vm.abi${process.versions.modules}.node`));

for(const layout of ['short','deep-cwd','deep-dependencies'])test(`MC 实际隔离执行器在${{short:'短目录','deep-cwd':'272 字符深目录','deep-dependencies':'内置 Node 264 字符、实际依赖目录 260 字符'}[layout]}完成本地自检`,{skip:!available,timeout:30000},async()=>{
  const profile=await mkdtemp(join(tmpdir(),'mc-sandbox-path-'));
  try{
    const length=layout==='deep-dependencies'?247:239;
    const runtimeRoot=layout==='short'?join(profile,'component'):join(profile,'component-'+'x'.repeat(length-profile.length-11));
    const sandbox=join(runtimeRoot,'upstream/src/cognitive/conscious');
    if(layout==='deep-cwd')assert.equal(sandbox.length,272);
    const files=['src/cognitive/conscious/js-planner-sandbox-runner.ts','src/cognitive/conscious/js-planner-worker.ts','src/cognitive/conscious/js-planner-sandbox-protocol.ts','src/utils/error-message.ts'];
    for(const file of files){const target=join(runtimeRoot,'upstream',file);await mkdir(dirname(target),{recursive:true});await copyFile(join(integration,'upstream',file),target);}
    if(layout==='deep-dependencies'){
      const dependencies=join(runtimeRoot,'node_modules');assert.equal(dependencies.length,260);await mkdir(dependencies);
      for(const name of ['isolated-vm','node-gyp-build'])await cp(join(integration,'node_modules',name),join(dependencies,name),{recursive:true});
      for(const name of ['tsx','@esbuild','@moeru'])await symlink(join(integration,'node_modules',name),join(dependencies,name),'junction');
    }else await symlink(join(integration,'node_modules'),join(runtimeRoot,'node_modules'),'junction');
    await writeFile(join(runtimeRoot,'package.json'),'{"type":"module"}\n','utf8');
    const nodePath=join(runtimeRoot,'runtime/node.exe');await mkdir(dirname(nodePath),{recursive:true});await copyFile(process.execPath,nodePath);
    const deniedPaths=[join(runtimeRoot,'private.txt'),join(runtimeRoot,'node_modules-private/private.txt'),join(sandbox+'-private','private.txt')];
    for(const file of deniedPaths){await mkdir(dirname(file),{recursive:true});await writeFile(file,'private sentinel','utf8');}
    const allowedPath=await realpath(join(runtimeRoot,'node_modules/isolated-vm/isolated-vm.js'));
    const permissionProbe=`const fs=require('node:fs');fs.readFileSync(${JSON.stringify(allowedPath)});for(const file of ${JSON.stringify(deniedPaths)}){try{fs.readFileSync(file);throw Error('读范围扩大：'+file);}catch(error){if(error.code!=='ERR_ACCESS_DENIED')throw error;}}try{fs.writeFileSync(${JSON.stringify(join(sandbox,'denied-write.txt'))},'unexpected');throw Error('意外允许写入');}catch(error){if(error.code!=='ERR_ACCESS_DENIED')throw error;}console.log('PERMISSION_BOUNDARIES_OK');`;
    await writeFile(join(runtimeRoot,'worker.mjs'),`import {register} from 'tsx/esm/api';register();
import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url),cp=require('node:child_process'),originalFork=cp.fork;let permissionArgs;
cp.fork=function(module,args,options){permissionArgs=options.execArgv;return originalFork.call(this,module,args,options);};syncBuiltinESMExports();
const {executeSandboxWorker}=await import('./upstream/src/cognitive/conscious/js-planner-sandbox-runner.ts');
const result=await executeSandboxWorker({bootstrapScript:'',bridgeAvailability:{},memoryLimitMb:32,runtime:{snapshot:{},mem:{},event:null},script:'return 6 * 7',timeoutMs:2000,toolNames:[]},{bridgeTimeoutMs:2000,maxBridgeCalls:0,onBridgeRequest:async()=>{throw Error('自检不执行游戏动作');}});
if(result.returnRaw!==42)throw Error('隔离执行器返回错误');
const scope=cp.spawnSync(process.execPath,[...permissionArgs,'-e',${JSON.stringify(permissionProbe)}],{cwd:process.cwd(),env:{},windowsHide:true,encoding:'utf8',timeout:10000});
if(scope.status!==0||!scope.stdout.includes('PERMISSION_BOUNDARIES_OK'))throw Error(scope.stderr||scope.error?.message||'权限边界检查失败');
console.log(JSON.stringify({ok:true,isolatedPlanner:true,value:result.returnRaw,permissionBoundaries:true}));
`,'utf8');
    const launch=minecraftRuntimeLaunch({runtimeRoot,nodePath,args:['--self-test']}),child=spawn(launch.command,launch.args,{...launch.options,stdio:['ignore','pipe','pipe'],timeout:15000});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});
    assert.equal(code,0,stderr);assert.deepEqual(JSON.parse(stdout.trim()),{ok:true,isolatedPlanner:true,value:42,permissionBoundaries:true});
  }finally{
    assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
