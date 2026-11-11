import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {request as httpRequest} from 'node:http';
import {createWorkbench} from '../framework/server.mjs';
import {moduleDefinitions} from '../framework/registry.mjs';

const schema={EmptyImage:{input:{required:{width:['INT'],height:['INT']}}},SaveImage:{input:{required:{images:['IMAGE'],filename_prefix:['STRING']}},output_node:true}};
const graph={'1':{class_type:'EmptyImage',inputs:{width:64,height:64}},'2':{class_type:'SaveImage',inputs:{images:['1',0],filename_prefix:'A'}}};
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'workbench-mcp-'));
  const drawingOptions={WebSocketImpl:null,fetchImpl:async url=>new Response(JSON.stringify(String(url).endsWith('/object_info')?schema:{system:{comfyui_version:'test'},devices:[]}))};
  const app=await createWorkbench({dataDir:directory,drawingOptions,instanceOptionsFactory:()=>({drawingOptions})});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});
    return {status:response.status,...await response.json()};
  };
  await api('/api/ai/config',{mcpEnabled:true},'PUT');
  const config=await api('/api/ai/mcp');
  const rpc=async(message,{path='/mcp',headers=config.http.headers}={})=>{
    const response=await fetch(app.url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(message)});
    return {status:response.status,...(response.status===202?{}:await response.json())};
  };
  const call=async(name,args={},options)=>rpc({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},options);
  return {app,api,rpc,call};
}

test('统一 MCP 在旧资料迁移后仍发现全部模块并创建和启动实例',async t=>{
  const f=await fixture(t);
  await f.api('/api/modules/drawing/enable',{});
  const migration=await f.api('/api/instances/migrate-legacy',{});assert.equal(migration.status,200);
  const modules=await f.call('workbench_modules');assert.equal(modules.status,200);
  assert.deepEqual(modules.result.structuredContent.modules.map(item=>item.id),moduleDefinitions.map(item=>item.id));
  assert.ok(modules.result.structuredContent.modules.every(item=>Array.isArray(item.tools)&&!Object.hasOwn(item,'config')));
  const created=await f.call('workbench_instance_create',{moduleId:'drawing',name:'MCP 绘图'});
  assert.equal(created.result.structuredContent.instance.name,'MCP 绘图');
  const id=created.result.structuredContent.instance.id;
  await f.app.context.instanceManager.stop(id);
  const started=await f.call('workbench_instance_start',{instanceId:id});assert.equal(started.result.structuredContent.instance.status,'running');
  const listed=await f.call('workbench_instances');assert.ok(listed.result.structuredContent.instances.some(item=>item.id===id));
});

test('根 MCP 明确选择实例，工作流写入与 UI 共用且两个绘图实例隔离',async t=>{
  const f=await fixture(t);
  const a=(await f.api('/api/instances',{moduleId:'drawing',name:'A'})).instance;
  const b=(await f.api('/api/instances',{moduleId:'drawing',name:'B'})).instance;
  const tools=await f.rpc({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.ok(tools.result.tools.find(tool=>tool.name==='comfy_workflow_import').inputSchema.required.includes('instanceId'));
  await f.api('/instances/'+a.id+'/api/modules/drawing/config',{values:{serviceUrl:'http://127.0.0.1:8188'}},'PUT');
  assert.equal((await f.call('comfy_connect',{instanceId:a.id})).result.isError,undefined);
  const imported=await f.call('comfy_workflow_import',{instanceId:a.id,name:'A 的工作流',document:graph});
  assert.equal(imported.result.isError,undefined,JSON.stringify(imported));
  const workflowId=imported.result.structuredContent.id;
  assert.ok(workflowId);
  assert.equal((await f.api('/instances/'+a.id+'/api/modules/drawing/workflows')).workflows[0].id,workflowId);
  assert.deepEqual((await f.call('comfy_workflows',{instanceId:b.id})).result.structuredContent.workflows,[]);
  assert.equal((await f.call('comfy_workflows')).result.isError,true);
  assert.equal((await f.call('comfy_status',{instanceId:'wrong'})).result.isError,true);
  const other=(await f.api('/api/instances',{moduleId:'voice'})).instance;
  assert.equal((await f.call('comfy_status',{instanceId:other.id})).result.isError,true);
  await f.app.context.instanceManager.stop(a.id);
  assert.equal((await f.call('comfy_status',{instanceId:a.id})).result.isError,true);
  await f.app.context.instanceManager.start(a.id);
  f.app.context.instanceManager.context(a.id).store.setEnabled('drawing',false);
  assert.equal((await f.call('comfy_status',{instanceId:a.id})).result.isError,true);
});

test('子实例 MCP 拒绝其他实例，严格校验嵌套参数且不执行服务',async t=>{
  const f=await fixture(t);
  const a=(await f.api('/api/instances',{moduleId:'drawing'})).instance;
  const b=(await f.api('/api/instances',{moduleId:'drawing'})).instance;
  const context=f.app.context.instanceManager.context(a.id);
  const config=await f.api('/instances/'+a.id+'/api/ai/mcp');
  const options={path:'/instances/'+a.id+'/mcp',headers:config.http.headers};
  assert.equal((await f.call('comfy_status',{},options)).result.isError,undefined);
  assert.equal((await f.call('comfy_status',{instanceId:b.id},options)).result.isError,true);
  let executed=0;context.drawingCompletion.download=()=>{executed++;return {};};
  for(const selections of [[{dependencyId:2,candidateId:'x'}],[{dependencyId:'x',candidateId:'y',extra:true}],'invalid']){
    const result=await f.call('comfy_completion_download',{id:'report',requestId:'request',selections},options);
    assert.equal(result.result.isError,true);
  }
  assert.equal(executed,0);
});

test('MCP 校验 JSON-RPC、版本协商和通知，认证保持有效',async t=>{
  const f=await fixture(t);
  for(const message of [null,[],{jsonrpc:'1.0',id:1,method:'ping'},{jsonrpc:'2.0',id:{},method:'ping'},{jsonrpc:'2.0',id:1,method:9}]){
    const result=await f.rpc(message);assert.equal(result.status,200);assert.equal(result.error.code,-32600);
  }
  for(const protocolVersion of ['2025-03-26','2025-06-18']){
    const result=await f.rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion}});
    assert.equal(result.result.protocolVersion,protocolVersion);assert.equal(result.result.serverInfo.name,'ai-future-workbench');
  }
  assert.equal((await f.rpc({jsonrpc:'2.0',id:1,method:'unknown'})).error.code,-32601);
  assert.equal((await f.rpc({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  assert.equal((await f.call('workbench_modules',{}, {headers:{Authorization:'Bearer wrong'}})).status,403);
});

test('同实例耗时工具执行期间仍可取消，不让实例锁挡住取消请求',async t=>{
  const f=await fixture(t),instance=(await f.api('/api/instances',{moduleId:'drawing'})).instance;
  const context=f.app.context.instanceManager.context(instance.id);
  let release,started;
  const entered=new Promise(resolve=>{started=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  context.drawingCompletion.search=async()=>{started();await pending;return {status:'cancelled'};};
  context.drawingCompletion.cancel=async()=>{release();return {status:'cancelled'};};
  const search=f.call('comfy_completion_search',{instanceId:instance.id,id:'report'});
  await entered;
  let timer;
  try{
    const cancelled=await Promise.race([f.call('comfy_completion_cancel',{instanceId:instance.id,id:'report'}),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),500);})]);
    assert.ok(cancelled,'取消请求应在搜索完成前执行');
    assert.equal(cancelled.result.isError,undefined);
  }finally{clearTimeout(timer);release();await search;}
});

test('实例结果中的本地资源链接同时限定 structuredContent 与 JSON text',async t=>{
  const f=await fixture(t),instance=(await f.api('/api/instances',{moduleId:'drawing'})).instance;
  const result={image:{url:'/api/modules/drawing/images/example'},downloadUrl:'/internal/result/example',prompt:'/api/user-authored-text'};
  f.app.context.instanceManager.context(instance.id).drawingCompletion.get=()=>result;
  const response=await f.call('comfy_completion_report',{instanceId:instance.id,id:'report'});
  assert.equal(response.result.structuredContent.image.url,'/instances/'+instance.id+'/api/modules/drawing/images/example');
  assert.equal(response.result.structuredContent.downloadUrl,'/instances/'+instance.id+'/internal/result/example');
  assert.equal(response.result.structuredContent.prompt,result.prompt);
  assert.deepEqual(JSON.parse(response.result.content[0].text),response.result.structuredContent);
});

test('根与子入口共用全局开关、各自使用独立令牌，根连接直接调度实例业务',async t=>{
  const f=await fixture(t);await f.api('/api/modules/drawing/enable',{});
  const migration=await f.api('/api/instances/migrate-legacy',{}),instance=migration.instances.find(item=>item.moduleId==='drawing');
  await f.app.context.instanceManager.start(instance.id);
  const context=f.app.context.instanceManager.context(instance.id);
  const child=await f.api('/instances/'+instance.id+'/api/ai/mcp'),root=await f.api('/api/ai/mcp');
  assert.equal(child.enabled,true);assert.notEqual(child.http.headers.Authorization,root.http.headers.Authorization);
  const options={path:'/instances/'+instance.id+'/mcp',headers:child.http.headers};
  assert.equal((await f.call('comfy_status',{},options)).result.isError,undefined);
  assert.equal((await f.call('comfy_status',{}, {...options,headers:root.http.headers})).status,403);
  assert.equal((await f.call('workbench_modules',{}, {headers:child.http.headers})).status,403);
  assert.equal((await f.api('/instances/'+instance.id+'/api/ai/config',{mcpEnabled:false},'PUT')).status,409);
  const state=await f.call('workbench_module_state',{instanceId:instance.id});
  assert.equal(state.result.structuredContent.instanceId,instance.id);
  for(const result of [state,await f.call('workbench_modules'),await f.call('workbench_instances'),await f.call('workbench_tools')]){
    assert.equal(JSON.stringify(result).includes(context.sharedAI.mcpToken),false);
    assert.equal(JSON.stringify(result).includes(context.sharedAI.token),false);
  }
  await f.api('/api/ai/config',{mcpEnabled:false},'PUT');
  assert.equal((await f.api('/instances/'+instance.id+'/api/ai/mcp')).enabled,false);
  assert.equal((await f.call('workbench_modules')).status,403);
  assert.equal((await f.call('comfy_status',{},options)).status,403);
  await f.api('/api/ai/config',{mcpEnabled:true},'PUT');
  assert.equal((await f.call('comfy_status',{},options)).result.isError,undefined);
});

test('工具发现区分完整操作和只读状态，子入口不会宣称能操作其他模块',async t=>{
  const f=await fixture(t),instance=(await f.api('/api/instances',{moduleId:'drawing'})).instance;
  const root=(await f.call('workbench_modules')).result.structuredContent.modules;
  assert.equal(root.find(item=>item.id==='drawing').coverage,'operations');
  assert.equal(root.find(item=>item.id==='cards').coverage,'state-only');
  const connection=await f.api('/instances/'+instance.id+'/api/ai/mcp');
  const child=(await f.call('workbench_modules',{}, {path:'/instances/'+instance.id+'/mcp',headers:connection.http.headers})).result.structuredContent.modules;
  assert.equal(child.find(item=>item.id==='drawing').available,true);
  assert.equal(child.find(item=>item.id==='cards').available,false);
  assert.deepEqual(child.find(item=>item.id==='cards').tools,[]);
  const options={path:'/instances/'+instance.id+'/mcp',headers:connection.http.headers};
  assert.deepEqual((await f.call('workbench_tools',{moduleId:'comfyui'},options)).result.structuredContent.tools,[]);
  const tools=(await f.rpc({jsonrpc:'2.0',id:1,method:'tools/list'},options)).result.tools;
  assert.equal(tools.some(tool=>tool.name==='workbench_instance_create'),false);
});

test('训练工具经根连接写入所属实例真实预设，UI 可读且另一实例保持独立',async t=>{
  const f=await fixture(t),a=(await f.api('/api/instances',{moduleId:'training',name:'训练 A'})).instance,b=(await f.api('/api/instances',{moduleId:'training',name:'训练 B'})).instance;
  const saved=await f.call('training_save_preset',{instanceId:a.id,presetId:'test-preset',revision:0,name:'参数 A',config:{model_train_type:'moss-image-lora',learning_rate:0.0001}});
  assert.equal(saved.result.isError,undefined,JSON.stringify(saved));
  assert.equal((await f.api('/instances/'+a.id+'/api/training/presets')).presets[0].name,'参数 A');
  assert.deepEqual((await f.call('training_presets',{instanceId:b.id})).result.structuredContent.presets,[]);
  assert.equal((await f.call('comfy_status',{instanceId:a.id})).result.isError,true);
  const invalid=await f.call('training_import_preset',{instanceId:a.id,format:'yaml',text:'model_train_type: moss-image-lora'});
  assert.equal(invalid.result.isError,true);
});

test('绘图 MCP 面板展示与统一入口相同的资源工具和实例参数',async t=>{
  const f=await fixture(t),drawing=(await f.api('/api/instances',{moduleId:'drawing'})).instance,launcher=(await f.api('/api/instances',{moduleId:'comfyui'})).instance;
  const tools=(await f.api('/instances/'+drawing.id+'/api/modules/drawing/mcp/tools')).tools;
  assert.ok(tools.some(tool=>tool.name==='comfy_manager_plan'));
  assert.ok(tools.some(tool=>tool.name==='comfy_generate'));
  assert.equal(tools.some(tool=>tool.name==='workbench_instance_create'),false);
  assert.equal(tools.find(tool=>tool.name==='comfy_manager_plan').inputSchema.required.includes('instanceId'),false);
  const launcherTools=(await f.api('/instances/'+launcher.id+'/api/modules/drawing/mcp/tools')).tools;
  assert.ok(launcherTools.some(tool=>tool.name==='comfy_manager_plan'));
  assert.equal(launcherTools.some(tool=>tool.name==='comfy_generate'),false);
});

test('MCP 创建与启动实例同时恢复对应主页入口，不改变其他模块',async t=>{
  const f=await fixture(t);
  const before=(await f.api('/api/state')).modules;
  assert.equal(before.find(item=>item.id==='drawing').enabled,false);
  const created=await f.call('workbench_instance_create',{moduleId:'drawing',name:'主页可见'});
  assert.equal(created.result.isError,undefined);
  const after=(await f.api('/api/state')).modules;
  assert.equal(after.find(item=>item.id==='drawing').enabled,true);
  assert.deepEqual(after.filter(item=>item.id!=='drawing').map(item=>[item.id,item.enabled]),before.filter(item=>item.id!=='drawing').map(item=>[item.id,item.enabled]));
  const instanceId=created.result.structuredContent.instance.id;
  await f.app.context.instanceManager.stop(instanceId);
  await f.api('/api/modules/drawing/disable',{});
  assert.equal((await f.api('/api/state')).modules.find(item=>item.id==='drawing').enabled,false);
  assert.equal((await f.call('workbench_instance_start',{instanceId})).result.structuredContent.instance.status,'running');
  assert.equal((await f.api('/api/state')).modules.find(item=>item.id==='drawing').enabled,true);
});

test('首次从 MCP 创建实例后 UI 可安全重复请求迁移，发现请求不会迁移资料',async t=>{
  const f=await fixture(t),manager=f.app.context.instanceManager;
  const migrated=()=>!!manager.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get();
  await f.rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
  await f.rpc({jsonrpc:'2.0',id:2,method:'tools/list'});
  await f.call('workbench_instances');await f.call('workbench_modules');
  assert.equal(migrated(),false);
  const created=await f.call('workbench_instance_create',{moduleId:'drawing'});
  assert.equal(created.result.isError,undefined);
  assert.equal(migrated(),true);
  const migration=await f.api('/api/instances/migrate-legacy',{});
  assert.equal(migration.status,200);
  assert.equal(migration.alreadyMigrated,true);
  assert.equal(migration.instances.length,1);
  assert.equal(migration.instances[0].id,created.result.structuredContent.instance.id);
});

test('旧任务仍在运行时 MCP 不迁移、不启用新模块也不创建实例',async t=>{
  const f=await fixture(t),controller=new AbortController();
  f.app.context.sharedAI.pending.add(controller);
  try{
    const result=await f.call('workbench_instance_create',{moduleId:'drawing'});
    assert.equal(result.result.isError,true);
    assert.match(result.result.content[0].text,/旧模块仍在运行/);
    assert.equal(f.app.context.instanceManager.list().length,0);
    assert.equal(f.app.context.store.module('drawing').enabled,false);
    assert.equal(f.app.context.instanceManager.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get(),undefined);
  }finally{f.app.context.sharedAI.pending.delete(controller);}
});

test('无效实例名称在迁移与启用前拒绝，启动工具公开 UUID 约束',async t=>{
  const f=await fixture(t);
  for(const name of ['', '   ', 'x'.repeat(121)]){
    assert.equal((await f.call('workbench_instance_create',{moduleId:'drawing',name})).result.isError,true);
    assert.equal(f.app.context.store.module('drawing').enabled,false);
    assert.equal(f.app.context.instanceManager.db.prepare("SELECT value FROM metadata WHERE key='legacy-v1'").get(),undefined);
  }
  const tools=(await f.rpc({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools;
  assert.ok(tools.find(tool=>tool.name==='workbench_instance_start').inputSchema.properties.instanceId.pattern);
});

test('MCP 迁移仅豁免自己的请求，仍等待其他旧页面保存完成',async t=>{
  const f=await fixture(t),payload=JSON.stringify({theme:'dark'});
  let finish;
  const pending=new Promise((resolve,reject)=>{
    const request=httpRequest(f.app.url+'/api/preferences',{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(payload)}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.write(payload.slice(0,5));finish=()=>request.end(payload.slice(5));
  });
  await new Promise(resolve=>setTimeout(resolve,30));
  try{
    const response=await f.call('workbench_instance_create',{moduleId:'drawing'});
    assert.equal(response.result.isError,true);assert.match(response.result.content[0].text,/保存请求/);
    assert.equal(f.app.context.instanceManager.list().length,0);
  }finally{finish();assert.equal(await pending,200);}
  assert.equal((await f.call('workbench_instance_create',{moduleId:'drawing'})).result.isError,undefined);
});
