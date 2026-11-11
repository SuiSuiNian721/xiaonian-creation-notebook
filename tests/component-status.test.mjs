import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moduleDefinition } from '../framework/registry.mjs';
import { MinecraftCompanion } from '../framework/mc-play.mjs';
import { SkinRuntime } from '../framework/mc-skin-runtime.mjs';
import * as installationView from '../public-workbench/installation-view.js';
import { createWorkbench } from '../framework/server.mjs';

test('每个扫描入口声明具体目标，两个 ComfyUI 入口共用本体定义',()=>{
  const expected={qq:/NapCat/,comfyui:/ComfyUI/,drawing:/ComfyUI/,training:/训练环境/,companion:/陪伴运行组件/,'mc-skin':/Python/,'mc-play':/Minecraft.*Java/};
  for(const [id,name] of Object.entries(expected)) assert.match(moduleDefinition(id).discovery?.name || '',name,id+' 必须明确查找的组件');
  assert.deepEqual(moduleDefinition('drawing').discovery,moduleDefinition('comfyui').discovery);
});

test('安装摘要点名待安装与尚未接入的组件，不把空清单当作运行环境已验证',()=>{
  assert.equal(typeof installationView.resourceReadiness,'function');
  const state={resources:[{name:'NapCat QQ 运行端',required:true,status:'available'},{name:'TTS 服务',required:true,status:'pending'},{name:'可选声线',required:false,status:'pending'}]};
  const label=installationView.resourceReadiness(state);assert.match(label,/NapCat QQ 运行端/);assert.match(label,/TTS 服务/);assert.doesNotMatch(label,/可选声线/);
  assert.match(installationView.resourceReadiness({resources:[]}),/无需安装/);
});

test('MC 运行端逐项指出缺少 worker、tsx、isolated-vm 或 Node.js',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mc-components-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const runtime=new MinecraftCompanion({store:{getSetting:()=>undefined},dataDir:directory,sharedAI:{},runtimeRoot:directory,nodePath:join(directory,'node.exe')});
  const missing=runtime.runtime();assert.equal(missing.available,false);
  for(const name of ['worker.mjs','tsx','isolated-vm','Node.js']) assert.match(missing.reason,new RegExp(name.replace('.','\\.')));
  await writeFile(join(directory,'worker.mjs'),'');
  const next=runtime.runtime();assert.doesNotMatch(next.reason,/worker\.mjs/);assert.match(next.reason,/tsx/);
  await mkdir(join(directory,'node_modules/tsx'),{recursive:true});await writeFile(join(directory,'node_modules/tsx/package.json'),'{}');
  await mkdir(join(directory,'node_modules/isolated-vm'),{recursive:true});await writeFile(join(directory,'node_modules/isolated-vm/isolated-vm.js'),'');await writeFile(join(directory,'node.exe'),'');
  assert.equal(runtime.runtime().available,true);assert.deepEqual(runtime.runtime().missingComponents,[]);
});

test('MC 皮肤检查区分 Python 未找到、Pillow 缺失与其他检查失败',async()=>{
  for(const [message,code,expected] of [["ModuleNotFoundError: No module named 'PIL'",undefined,/Pillow/],['spawn missing python','ENOENT',/Python/],['unexpected adapter output',undefined,/MC 皮肤/]]) {
    const runtime=new SkinRuntime({directory:tmpdir()});runtime.candidates=async()=>['test-python'];
    runtime.execute=async()=>{throw Object.assign(new Error(message),{code});};
    const result=await runtime.check();assert.equal(result.available,false);assert.match(result.error,expected);
    if(code==='ENOENT')assert.equal(result.missingComponents[0].id,'python');
    if(message.includes('PIL')){assert.equal(result.missingComponents?.[0]?.id,'pillow');assert.doesNotMatch(result.error,/未找到 Python/);}
    if(message.includes('unexpected'))assert.deepEqual(result.missingComponents,[]);
    runtime.close();
  }
});

test('所有含路径配置的模块，检查失败都带上具体字段名称',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'component-paths-'));
  const app=await createWorkbench({dataDir:directory});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,value,method='POST')=>{const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)});assert.equal(response.status,200);return response.json();};
  for(const id of ['drawing','comfyui','training','voice','companion','mc-skin']) {
    const field=moduleDefinition(id).settings.find(setting=>setting.type==='path');
    await api('/api/modules/'+id+'/enable',{});
    await api('/api/modules/'+id+'/config',{values:{[field.key]:join(directory,'not-installed',id)}},'PUT');
    const {checks}=await api('/api/modules/'+id+'/check-paths',{});
    assert.equal(checks[field.key].status,'missing');assert.ok(checks[field.key].message.includes(field.label),id+' 的失败信息应点名配置对象');
  }
});
