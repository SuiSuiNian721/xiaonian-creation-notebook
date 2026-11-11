import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkbenchStore} from '../framework/store.mjs';
import {DrawingRuntime} from '../framework/drawing-runtime.mjs';
import {DrawingManager} from '../framework/drawing-manager.mjs';

async function fixture(t,moduleId='drawing'){
  const directory=await mkdtemp(join(tmpdir(),'module-mcp-'));
  const comfy=join(directory,'ComfyUI');
  await mkdir(join(comfy,'comfy'),{recursive:true});
  await mkdir(join(comfy,'custom_nodes'));
  await mkdir(join(comfy,'models','loras'),{recursive:true});
  for(const name of ['main.py','nodes.py','server.py'])await writeFile(join(comfy,name),'# test\n');
  const store=new WorkbenchStore(join(directory,'data'));
  const instanceId=randomUUID();store.setSetting('instance.identity',{id:instanceId,moduleId});store.setEnabled(moduleId,true);
  store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const runtime=new DrawingRuntime({store,directory:join(directory,'data','drawing')});
  const drawing={config:()=>store.module('drawing').config,runtime};
  const drawingManager=new DrawingManager({store,drawing,dataDir:join(directory,'data'),fetchImpl:async()=>{throw new Error('不应联网');}});
  t.after(async()=>{await drawingManager.close();await runtime.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:5});});
  return {directory,comfy,instanceId,context:{store,drawing,drawingManager}};
}
const moduleApi=()=>import('../framework/module-mcp.mjs');

test('资源工具读取与扫描使用同一库存，设置保存后现有运行端可读',async t=>{
  const f=await fixture(t);const api=await moduleApi();
  await writeFile(join(f.comfy,'models','loras','测试.safetensors'),'model');
  assert.equal((await api.callModuleTool('comfy_manager_state',{},f.context)).inventory,null);
  const inventory=await api.callModuleTool('comfy_inventory',{},f.context);
  assert.equal(inventory.models[0].name,'测试.safetensors');
  assert.deepEqual((await api.callModuleTool('comfy_manager_state',{},f.context)).inventory,inventory);
  await api.callModuleTool('comfy_runtime_settings',{settings:{previewMethod:'latent2rgb'}},f.context);
  assert.equal(f.context.drawing.runtime.settings().previewMethod,'latent2rgb');
});

test('统一任务记录保留类型、实例与产物，拒绝错模块和无取消能力的任务',async t=>{
  const f=await fixture(t);const api=await moduleApi();
  f.context.drawingManager.tasks.push({id:'managed-one',status:'completed',title:'安装节点',snapshotId:'snapshot-one'});
  const list=await api.callModuleTool('workbench_tasks',{kind:'management'},f.context);
  assert.equal(list.tasks[0].kind,'management');assert.equal(list.tasks[0].instanceId,f.instanceId);
  const result=await api.callModuleTool('workbench_task',{kind:'management',id:'managed-one'},f.context);
  assert.equal(result.task.snapshotId,'snapshot-one');
  await assert.rejects(api.callModuleTool('workbench_task_cancel',{kind:'management',id:'managed-one'},f.context),/取消/);
  await assert.rejects(api.callModuleTool('workbench_tasks',{kind:'skin'},f.context),/当前模块/);
  await assert.rejects(api.callModuleTool('workbench_task',{kind:'management',id:'missing'},f.context),/找不到/);
});

test('不允许未知工具、额外字段、缺失参数或跨模块调用',async t=>{
  const f=await fixture(t,'mc-skin');const api=await moduleApi();
  await assert.rejects(api.callModuleTool('constructor',{},f.context),/工具/);
  await assert.rejects(api.callModuleTool('skin_job',{},f.context),/id/);
  await assert.rejects(api.callModuleTool('skin_job',{id:'one',path:'outside'},f.context),/字段/);
  await assert.rejects(api.callModuleTool('comfy_inventory',{},f.context),/当前模块/);
});

test('任务统一接口保留皮肤版本并只取消指定作品',async t=>{
  const f=await fixture(t,'mc-skin');const api=await moduleApi();
  const {MinecraftSkin}=await import('../framework/mc-skin.mjs');
  const skin=new MinecraftSkin({store:f.context.store,dataDir:join(f.directory,'data'),sharedAI:{complete:async()=>{throw new Error('不应生成');}}});
  f.context.mcSkin=skin;t.after(()=>skin.close());
  const job={id:randomUUID(),requestId:randomUUID(),name:'同一作品',version:2,status:'queued',files:{}};
  skin.db.prepare('INSERT INTO mc_skin_jobs VALUES(?,?,?)').run(job.id,job.requestId,JSON.stringify(job));
  const listed=await api.callModuleTool('workbench_tasks',{},f.context);
  assert.equal(listed.tasks[0].id,job.id);assert.equal(listed.tasks[0].task.version,2);
  await api.callModuleTool('workbench_task_cancel',{kind:'skin',id:job.id},f.context);
  assert.equal(skin.job(job.id).status,'cancelled');
});

test('训练流程读取真实 list 形状，声音状态使用与界面相同的共享服务 owner',async t=>{
  const f=await fixture(t,'training');const api=await moduleApi();
  f.context.ensureTraining=async()=>({pipeline:{list:()=>({jobs:[{id:'workflow-one',status:'paused'}],taggerModels:[]})}});
  const result=await api.callModuleTool('workbench_tasks',{kind:'training-workflow'},f.context);
  assert.deepEqual(result.unavailable,[]);assert.equal(result.tasks[0].id,'workflow-one');
  f.context.store.setSetting('instance.identity',{id:f.instanceId,moduleId:'voice'});
  f.context.voiceOwner='same-owner-as-http';
  f.context.voiceStudio={state:({owner})=>({job:{id:owner==='same-owner-as-http'?'correct-job':'wrong-job'},resources:{apiKey:'never-expose',serviceUrl:'http://user:password@localhost/?token=private'}})};
  const state=await api.callModuleTool('workbench_module_state',{},f.context);
  assert.equal(state.state.job.id,'correct-job');assert.equal(JSON.stringify(state).includes('never-expose'),false);assert.equal(JSON.stringify(state).includes('password'),false);
});
