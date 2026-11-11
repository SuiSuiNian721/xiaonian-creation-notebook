import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {VisionExtension} from '../framework/vision-extension.mjs';
import {findLocalResourceFiles} from '../framework/local-resource-files.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('视觉组件单独下载，不启动服务且未选组件不下载',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vision-components-')),saved=new Map(),downloaded=[];
  const contents={model:Buffer.from('GGUFmodel'),projector:Buffer.from('GGUFprojector'),runtime:Buffer.from('runtime')};
  const spec={id:'test',alias:'test',files:Object.entries(contents).map(([id,bytes])=>({id,filename:id+(id==='runtime'?'.zip':'.gguf'),bytes:bytes.length,sha256:sha(bytes),url:'https://example.org/'+id})),runtime:{directory:'runtime',executable:'llama-server.exe',requiredFiles:['llama-server.exe'],unpackedBytes:7},downloadBytes:30};
  const extension=new VisionExtension({store:{getSetting:key=>saved.get(key),setSetting:(key,value)=>saved.set(key,structuredClone(value))},dataDir:root,packageSpec:spec,platform:'win32',arch:'x64',
    fetchImpl:async url=>{const id=String(url).split('/').at(-1);downloaded.push(id);return new Response(contents[id],{headers:{'content-length':String(contents[id].length)}});},spawnImpl:()=>{throw new Error('下载不应启动程序');}});
  t.after(async()=>{await extension.close();await rm(root,{recursive:true,force:true});});await extension.ready;
  extension.install({components:['model']});await extension.waitForIdle();
  assert.equal(extension.state().task.status,'completed',extension.state().task.error);assert.deepEqual(downloaded,['model']);assert.equal(extension.state().runtime.status,'stopped');
  assert.deepEqual(await readFile(join(root,'resources','vision','test','model.gguf')),contents.model);
  assert.equal(extension.state().components.find(item=>item.id==='model').installed,true);
  assert.equal(extension.state().installed,false);
});
test('视觉可以关联已有独立组件，读取状态不执行程序和检索',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vision-bindings-')),saved=new Map();
  const extension=new VisionExtension({store:{getSetting:key=>saved.get(key),setSetting:(key,value)=>saved.set(key,structuredClone(value))},dataDir:root,platform:'win32',arch:'x64'});
  t.after(async()=>{await extension.close();await rm(root,{recursive:true,force:true});});await extension.ready;
  assert.equal(typeof extension.configure,'function');
  const modelPath=join(root,'custom.gguf'),projectorPath=join(root,'mmproj.gguf'),runtimePath=join(root,'llama-server.exe');
  await writeFile(modelPath,'GGUF model');await writeFile(projectorPath,'GGUF projector');await writeFile(runtimePath,'fixture');
  await extension.configure({modelPath,projectorPath,runtimePath});
  const state=extension.state();assert.equal(state.installed,true);assert.equal(state.bindings.modelPath,modelPath);assert.equal(state.discovery.attempted,false);assert.equal(state.runtime.status,'stopped');
});
test('视觉发现保留 GGUF 未知用途，缓存跨重启复用且只有手动刷新重扫',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vision-discovery-')),saved=new Map();let scans=0;
  const store={getSetting:key=>structuredClone(saved.get(key)),setSetting:(key,value)=>saved.set(key,structuredClone(value))};
  const options={store,dataDir:root,platform:'win32',arch:'x64',spawnImpl:()=>assert.fail('发现不能执行运行器'),
    discoverImpl:async options=>{scans++;return findLocalResourceFiles({...options,roots:[root]});}};
  const extension=new VisionExtension(options);let reopened;
  t.after(async()=>{await extension.close();await reopened?.close();await rm(root,{recursive:true,force:true});});await extension.ready;
  await writeFile(join(root,'looks-like-mmproj.gguf'),'GGUF fixture');await writeFile(join(root,'vision.gguf'),'GGUF fixture');
  await extension.discover();
  assert.equal(scans,1,'通过受控发现器运行首次扫描');
  assert.deepEqual(extension.state().discovery.result.candidates.map(item=>item.kind),['gguf','gguf'],'文件名不构成模型或视觉投影用途的依据');
  assert.deepEqual(extension.state().bindings,{});await extension.close();
  reopened=new VisionExtension(options);await reopened.ready;await reopened.discover();assert.equal(scans,1);
  await reopened.discover({refresh:true});assert.equal(scans,2);assert.equal(reopened.state().runtime.status,'stopped');
});
