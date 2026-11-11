import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { WorkbenchStore } from '../framework/store.mjs';
import { createWorkbench } from '../framework/server.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-workspace-'));
  const comfy = join(root,'ComfyUI'); await mkdir(join(comfy,'comfy'),{recursive:true});
  for (const file of ['main.py','nodes.py','server.py']) await writeFile(join(comfy,file),'# isolated fixture\n');
  const dataDir = join(root,'data'); let app;
  t.after(async () => { await app?.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}); });
  app = await createWorkbench({dataDir,...options});
  const api = async (path,body,method=body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(app.url+path,{method,...(body === undefined ? {} : {headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    return {status:response.status,...await response.json()};
  };
  return {root,comfy,dataDir,app,api};
}

test('新增独立启动器；旧绘图升级仅首次启用，配置与用户后续停用保留',async t => {
  const root = await mkdtemp(join(tmpdir(),'launcher-upgrade-')); let store;
  t.after(async () => { store?.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)); await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}); });
  store = new WorkbenchStore(root);
  assert.equal(store.module('comfyui').enabled,false);
  store.saveConfig('drawing',{comfyPath:'E:\\Existing ComfyUI',serviceUrl:'http://127.0.0.1:8188'});
  store.setEnabled('drawing',true);
  store.db.prepare('DELETE FROM modules WHERE id = ?').run('comfyui'); // Reproduce the schema before the new module existed.
  store.close(); store = new WorkbenchStore(root);
  assert.equal(store.module('comfyui').enabled,true);
  assert.deepEqual(store.module('comfyui').config,store.module('drawing').config);
  store.setEnabled('comfyui',false); store.close(); store = new WorkbenchStore(root);
  assert.equal(store.module('comfyui').enabled,false);
  assert.equal(store.module('drawing').enabled,true);
  assert.equal(store.module('drawing').config.comfyPath,'E:\\Existing ComfyUI');
});

test('只启用启动器可保存共享配置与读取运行/维护，不能执行创作或工作流',async t => {
  let network=0;
  const f=await fixture(t,{drawingOptions:{fetchImpl:async()=>{network++;throw new Error('unexpected network');},WebSocketImpl:null}});
  assert.equal((await f.api('/api/modules/comfyui/enable',{})).status,200);
  const saved=await f.api('/api/modules/comfyui/config',{values:{comfyPath:f.comfy,serviceUrl:'http://127.0.0.1:8188'}},'PUT');
  assert.equal(saved.status,200);assert.equal(saved.config.comfyPath,f.comfy);
  const state=await f.api('/api/state');assert.equal(state.modules.length,13);
  assert.deepEqual(state.modules.find(m=>m.id==='drawing').config,state.modules.find(m=>m.id==='comfyui').config);
  assert.equal(state.modules.find(m=>m.id==='drawing').enabled,false);
  assert.equal((await f.api('/api/modules/drawing/runtime')).status,200);
  const management=await f.api('/api/modules/drawing/manager/state');assert.equal(management.status,200);assert.equal(management.inventory,null);
  for(const [path,body] of [['workflows',undefined],['workflows/import',{document:{}}],['jobs',{}],['assistant',{instruction:'should not run'}]])assert.equal((await f.api('/api/modules/drawing/'+path,body)).status,409);
  assert.equal(network,0);
  assert.equal((await f.api('/api/modules/comfyui/config',{values:{unknown:true}},'PUT')).status,400);
});

test('两入口共享配置修订与检查，互相停用不丢数据或错误开放生成权限',async t => {
  const f=await fixture(t);
  await f.api('/api/modules/drawing/enable',{});await f.api('/api/modules/comfyui/enable',{});
  await f.api('/api/modules/drawing/config',{values:{comfyPath:f.comfy,workflowPath:f.root}},'PUT');
  const check=await f.api('/api/modules/comfyui/check-paths',{});assert.equal(check.status,200);assert.equal(check.checks.comfyPath.status,'valid');
  await f.api('/api/modules/comfyui/config',{values:{serviceUrl:'http://127.0.0.1:19091'}},'PUT');
  let state=await f.api('/api/state');const drawing=state.modules.find(m=>m.id==='drawing'),launcher=state.modules.find(m=>m.id==='comfyui');
  assert.deepEqual(launcher.config,drawing.config);assert.deepEqual(launcher.checks,drawing.checks);assert.equal(drawing.config.workflowPath,f.root);
  await f.api('/api/modules/comfyui/disable',{});assert.equal((await f.api('/api/modules/drawing/workflows')).status,200);
  await f.api('/api/modules/comfyui/enable',{});await f.api('/api/modules/drawing/disable',{});
  assert.equal((await f.api('/api/modules/drawing/runtime')).status,200);assert.equal((await f.api('/api/modules/drawing/workflows')).status,409);
  state=await f.api('/api/state');assert.equal(state.modules.find(m=>m.id==='comfyui').config.comfyPath,f.comfy);
});

test('绘图专用MCP开关沿用公共连接，部分保存不清空AI模型和认证配置',async t => {
  const f=await fixture(t);await f.api('/api/modules/drawing/enable',{});
  await f.api('/api/ai/config',{provider:'codex',enabled:false,model:'fixture-model',apiKey:'fixture-secret'},'PUT');
  const result=await f.api('/api/ai/config',{mcpEnabled:true},'PUT');assert.equal(result.status,200);assert.equal(result.mcpEnabled,true);assert.equal(result.model,'fixture-model');assert.equal(result.hasKey,true);
  const tools=await f.api('/api/modules/drawing/mcp/tools');assert.equal(tools.status,200);assert.ok(tools.tools.some(tool=>tool.name==='comfy_generate'));assert.ok(tools.tools.some(tool=>tool.name==='comfy_workflow_import'));
  const mcp=await f.api('/api/ai/mcp');assert.equal(mcp.enabled,true);assert.ok(mcp.stdio);assert.ok(mcp.http);
});
