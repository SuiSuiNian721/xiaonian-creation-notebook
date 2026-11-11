import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createWorkbench} from '../framework/server.mjs';

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'drawing-resource-binding-')),comfyPath=join(directory,'portable','ComfyUI'),pythonPath=join(directory,'portable','python_embeded','python.exe');
  await mkdir(join(comfyPath,'comfy'),{recursive:true});await mkdir(join(directory,'portable','python_embeded'),{recursive:true});
  for(const name of ['main.py','server.py','nodes.py'])await writeFile(join(comfyPath,name),'# fixture only\n','utf8');
  await writeFile(pythonPath,'fixture never executed','utf8');let launched=0,probed=0;
  const app=await createWorkbench({dataDir:join(directory,'profile'),instances:false,environmentOptions:{roots:[join(directory,'portable')]},drawingOptions:{WebSocketImpl:null,runtimeOptions:{spawnImpl:()=>{launched++;throw new Error('不得启动');},probeRunner:()=>{probed++;throw new Error('不得诊断');}}}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const api=async(path,body,method=body===undefined?'GET':'POST',status=200)=>{const response=await fetch(app.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;};
  await api('/api/modules/comfyui/enable',{});
  await api('/api/modules/drawing/runtime/settings',{pythonPath:process.execPath,vramMode:'lowvram'});
  const snapshot=()=>({module:app.context.store.module('drawing'),runtime:app.context.store.getSetting('drawing.runtime'),settingsRevision:app.context.drawing.runtime.settingsRevision,events:app.context.store.events()});
  return {app,api,comfyPath,pythonPath,snapshot,counts:()=>({launched,probed})};
}

test('采用 ComfyUI 配套 Python 原子保存到实际启动命令，兼容旧接口并保留其他参数',async t=>{
  const {api,comfyPath,pythonPath,counts,snapshot}=await fixture(t);
  const found=await api('/api/environment/scan',{moduleId:'comfyui'}),selected=found.candidates.find(item=>item.path===comfyPath);
  assert.ok(selected);assert.equal(selected.values.pythonPath,pythonPath);
  assert.equal((await api('/api/modules/drawing/runtime')).settings.pythonPath,process.execPath,'扫描不改实际配置');
  const {pythonPath:ignored,...values}=selected.values;
  const revision=snapshot().settingsRevision;
  const saved=await api('/api/modules/comfyui/config',{values,runtimeSettings:{pythonPath:selected.values.pythonPath}},'PUT');
  assert.equal(saved.runtimeSettings.pythonPath,pythonPath);assert.equal(saved.runtimeSettings.vramMode,'lowvram');
  assert.equal(snapshot().settingsRevision,revision+1);
  const state=await api('/api/modules/drawing/runtime');
  assert.equal(state.settings.vramMode,'lowvram');assert.equal(state.command.executable,pythonPath);assert.equal(state.command.cwd,comfyPath);
  await api('/api/modules/drawing/runtime/settings',{pythonPath:process.execPath});
  assert.equal((await api('/api/modules/drawing/runtime')).command.executable,process.execPath);
  await api('/api/modules/drawing/config',{values:{outputPath:comfyPath}},'PUT');
  assert.equal((await api('/api/modules/drawing/runtime')).settings.pythonPath,process.execPath);
  assert.deepEqual(counts(),{launched:0,probed:0});
});

test('原子保存先校验两种配置，无效目录配置或 Python 均不改变任一持久字段',async t=>{
  const {api,comfyPath,pythonPath,snapshot}=await fixture(t),before=snapshot();
  for(const body of [
    {values:{comfyPath,serviceUrl:'not-a-url'},runtimeSettings:{pythonPath}},
    {values:{comfyPath},runtimeSettings:{pythonPath:'python --invalid'}},
    {values:{comfyPath},runtimeSettings:{pythonPath,vramMode:'cpu'}},
    {values:{comfyPath},runtimeSettings:null},
  ]){
    await api('/api/modules/drawing/config',body,'PUT',400);
    assert.deepEqual(snapshot(),before);
  }
});

test('原子保存的运行设置 SQL 写入失败时回滚目录、检查记录与事件，修订号不增加',async t=>{
  const {app,api,comfyPath,pythonPath,snapshot}=await fixture(t),store=app.context.store;
  const module=store.module('drawing');store.applyChecks('drawing',module.configRevision,{comfyPath:{status:'ok',message:'旧路径检查'}});
  const before=snapshot();
  store.db.exec("CREATE TEMP TRIGGER reject_drawing_runtime BEFORE INSERT ON settings WHEN NEW.name = 'drawing.runtime' BEGIN SELECT RAISE(ABORT, 'fixture runtime write failed'); END");
  try{
    await api('/api/modules/drawing/config',{values:{comfyPath},runtimeSettings:{pythonPath}},'PUT',500);
    assert.deepEqual(snapshot(),before);
  }finally{store.db.exec('DROP TRIGGER reject_drawing_runtime');}
});
