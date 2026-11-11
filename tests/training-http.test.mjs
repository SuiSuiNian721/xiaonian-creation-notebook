import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbench} from '../framework/server.mjs';

async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),'workbench-training-http-'));
  const calls=[];
  const service={runtime:{},close:async()=>{},state:async()=>({runtime:{status:'stopped'},tasks:[],engines:{},hardware:null}),catalog:async()=>({training_types:[{train_type:'moss-image-lora',engine:'kohya',bundled:true}]}),
    start:async()=>{calls.push('start');return {runtime:{status:'running'}};},stop:async()=>{calls.push('stop');return {runtime:{status:'stopped'}};},savedConfigs:async()=>({configs:[]}),
    schema:async type=>({train_type:type,schema:'Schema.object({})'}),validate:async config=>({valid:true,normalized_config:config}),preflight:async config=>({ok:true,training_started:false,validation:{normalized_config:config}}),
    submit:async value=>{calls.push(value);return {task_id:'task-1',requestId:value.requestId};},submission:async id=>({requestId:id,state:'submitted'}),tasks:async()=>({tasks:[{id:'task-1',status:'RUNNING'}]}),
    task:async id=>({task:{id,status:'RUNNING'},metrics:{progress:{step:1,total_steps:10}},logs:{lines:[]},previews:[],outputs:[]}),
    stopTask:async id=>{calls.push({stop:id});return {remaining_active_task_ids:[]};},preview:async()=>({bytes:Buffer.from('test-image'),mime:'image/png'}),
    captioners:{state:async()=>({items:[],task:null,training_started:false,tagging_started:false}),prepare:async value=>{calls.push({captioner:value});return {items:[],task:{id:'download-1',captionerId:value.captionerId,status:'queued'},training_started:false,tagging_started:false};},cancel:async value=>{calls.push({cancelCaptioner:value});return {items:[],task:{id:value.taskId,captionerId:'cl_tagger_1_01',status:'cancelled'}};}},
    pipeline:{list:()=>({jobs:[]}),get:id=>({job:{id,state:'paused'}}),create:async value=>{calls.push({workflow:value});return {job:{id:value.requestId,state:'running'}};},pause:async id=>({job:{id,state:'paused'}}),resume:async id=>({job:{id,state:'running'}}),cancel:async id=>({job:{id,state:'cancelled'}})}};
  const app=await createWorkbench({dataDir:directory,trainingOptions:{service},instances:false,...options});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const request=async(path,value,method=value===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
    return {status:response.status,...await response.json()};
  };
  return {...app,request,calls,directory};
}

test('训练模块启用和状态读取不启动内核；原生路由要求已启用',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/training/state')).status,409);
  assert.equal((await f.request('/api/modules/training/enable',{})).status,200);
  assert.equal((await f.request('/api/modules/training/resources')).status,200);
  assert.equal((await f.request('/api/modules/cards/resources')).status,200);
  assert.equal((await f.request('/api/training/state')).runtime.status,'stopped');
  assert.deepEqual(f.calls,[]);
  assert.equal((await f.request('/api/training/catalog')).training_types[0].engine,'kohya');
  assert.equal((await f.request('/api/training/start',{})).runtime.status,'running');
  assert.deepEqual(f.calls,['start']);
});

test('训练路由转交固定提交编号与完整参数，停止只按指定任务调用',async t=>{
  const f=await fixture(t);await f.request('/api/modules/training/enable',{});
  const input={requestId:'request-1',config:{model_train_type:'moss-image-lora',learning_rate:0.0001}};
  assert.equal((await f.request('/api/training/preflight',{config:input.config})).training_started,false);
  assert.deepEqual(f.calls,[]);
  assert.equal((await f.request('/api/training/tasks',input)).task_id,'task-1');
  assert.deepEqual(f.calls,[input]);
  assert.equal((await f.request('/api/training/tasks/task-1')).metrics.progress.step,1);
  await f.request('/api/training/tasks/task-1/stop',{});
  assert.deepEqual(f.calls.at(-1),{stop:'task-1'});
  assert.equal((await f.request('/api/training/submissions/request-1')).state,'submitted');
  assert.equal((await f.request('/api/training/tasks',{...input,command:'whoami'})).status,400);
  assert.equal((await f.request('/api/training/start',{extra:true})).status,400);
  assert.equal((await f.request('/api/training/stop')).status,405);
  assert.equal((await f.request('/api/training/start',{},'POST',{origin:'https://example.test'})).status,403);
});

test('独立打标器准备和取消路由不启动训练内核或创建打标流程',async t=>{
  const f=await fixture(t);await f.request('/api/modules/training/enable',{});
  assert.equal((await f.request('/api/training/captioners')).task,null);
  const value={captionerId:'cl_tagger_1_01',downloadEndpoint:'默认'};
  const prepared=await f.request('/api/training/captioners/prepare',value);
  assert.equal(prepared.task.captionerId,value.captionerId);assert.equal(prepared.training_started,false);assert.equal(prepared.tagging_started,false);
  assert.equal((await f.request('/api/training/captioners/cancel',{taskId:prepared.task.id})).task.status,'cancelled');
  assert.deepEqual(f.calls,[{captioner:value},{cancelCaptioner:{taskId:'download-1'}}]);
  assert.equal((await f.request('/api/training/captioners/prepare')).status,405);
});

test('工作台预设实际 HTTP 保存、导入导出与删除不启动训练内核', async t => {
  const f = await fixture(t, { trainingOptions: {} });
  await f.request('/api/modules/training/enable', {});
  const config = { model_train_type: 'moss-image-lora', network_dim: 32, blocks_to_swap: 20, convrot_int8: true };
  const saved = await f.request('/api/training/presets', { id: 'http-preset', revision: 0, name: '手动完整参数', config });
  assert.equal(saved.status, 200); assert.equal(saved.preset.revision, 1);
  assert.equal((await f.request('/api/training/presets')).presets.length, 1);
  const exported = await f.request('/api/training/presets/export', { format: 'toml', name: '手动完整参数', config });
  assert.match(exported.content, /blocks_to_swap = 20/);
  const imported = await f.request('/api/training/presets/import', { format: 'toml', text: exported.content });
  assert.deepEqual(imported.config, config);
  assert.equal((await f.request('/api/training/state')).runtime.status, 'unconfigured');
  assert.deepEqual((await f.request('/api/training/workflows')).jobs, []);
  assert.equal((await f.request('/api/training/presets/http-preset/delete', { revision: 1 })).deleted, true);
});

test('一键 HTTP 必须连接 AI，MCP 预设支持中文名称并共用实例存储', async t => {
  const f = await fixture(t, { trainingOptions: {} }); await f.request('/api/modules/training/enable', {});
  const request = { requestId: 'quick-http', input: { sourcePath: 'E:\\训练集' }, config: { model_train_type: 'moss-image-lora', pretrained_model_name_or_path: 'E:\\模型\\moss.safetensors' } };
  const denied = await f.request('/api/training/quick-start', request); assert.equal(denied.status, 409); assert.match(denied.error, /AI/);
  assert.deepEqual((await f.request('/api/training/workflows')).jobs, []);
  await f.request('/api/ai/config', { mcpEnabled: true }, 'PUT'); const connection = await f.request('/api/ai/mcp');
  const rpc = async(name,args={}) => (await f.request('/mcp', { jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args} }, 'POST', connection.http.headers)).result;
  const saved = await rpc('training_save_preset', { presetId:'mcp-preset',revision:0,name:'小汐完整参数',config:request.config });
  assert.equal(saved.isError, undefined); assert.equal(saved.structuredContent.preset.name, '小汐完整参数');
  assert.equal((await rpc('training_presets')).structuredContent.presets.length, 1);
  assert.equal((await rpc('training_quick_start', request)).isError, true);
});

test('训练 MCP 与原生界面共用服务，关闭模块后拒绝调用',async t=>{
  const f=await fixture(t);
  const config=await f.request('/api/ai/mcp');
  await f.request('/api/ai/config',{mcpEnabled:true},'PUT');
  const rpc=(method,params)=>f.request('/mcp',{jsonrpc:'2.0',id:1,method,params},'POST',config.http.headers);
  const tools=(await rpc('tools/list')).result.tools;
  assert.ok(tools.some(tool=>tool.name==='training_start'));
  assert.ok(tools.some(tool=>tool.name==='comfy_generate'));
  assert.equal((await rpc('tools/call',{name:'training_status',arguments:{}})).result.isError,true);
  await f.request('/api/modules/training/enable',{});
  const result=await rpc('tools/call',{name:'training_start',arguments:{requestId:'mcp-request',config:{model_train_type:'moss-image-lora'}}});
  assert.equal(result.result.structuredContent.task_id,'task-1');
  assert.equal(f.calls[0].requestId,'mcp-request');
  const notification=await fetch(f.url+'/mcp',{method:'POST',headers:{'content-type':'application/json',...config.http.headers},body:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'training_start',arguments:{requestId:'notification',config:{model_train_type:'moss-image-lora'}}}})});
  assert.equal(notification.status,202);
  assert.equal(f.calls.length,1);
});

test('一键流程 HTTP 与 MCP 共用入口，未知参数和未启用实例拒绝',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/training/workflows')).status,409);
  await f.request('/api/modules/training/enable',{});
  assert.deepEqual((await f.request('/api/training/workflows')).jobs,[]);
  const request={requestId:'flow-http',input:{sourcePath:'E:\\图集',aiEnabled:false,mode:'tag'},config:{}};
  assert.equal((await f.request('/api/training/workflows',request)).job.id,'flow-http');
  assert.equal((await f.request('/api/training/workflows/flow-http/pause',{})).job.state,'paused');
  assert.equal((await f.request('/api/training/workflows/flow-http',{extra:true})).status,405);
  assert.equal((await f.request('/api/training/workflows',{...request,command:'no'})).status,400);
  await f.request('/api/ai/config',{mcpEnabled:true},'PUT');const connection=await f.request('/api/ai/mcp');
  const result=await f.request('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'training_workflow_start',arguments:request}},'POST',connection.http.headers);
  assert.equal(result.result.structuredContent.job.id,'flow-http');
  assert.equal(f.calls.at(-1).workflow.input.aiEnabled,false);
});

test('桌面主入口要求从训练实例操作，不能在迁移前制造旧训练队列',async t=>{
  const f=await fixture(t,{instances:true});
  await f.request('/api/modules/training/enable',{});
  for(const path of ['state','start','preflight','tasks']){
    const response=await f.request('/api/training/'+path,path==='state'?undefined:{});
    assert.equal(response.status,409);assert.match(response.error,/实例/);
  }
  await f.request('/api/ai/config',{mcpEnabled:true},'PUT');const config=await f.request('/api/ai/mcp');
  const result=await f.request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'training_start_kernel',arguments:{}}},'POST',config.http.headers);
  assert.equal(result.result.isError,true);assert.deepEqual(f.calls,[]);
  assert.ok(!(await readdir(f.directory)).includes('training'));
});

test('归档训练实例前保留活动任务的控制入口，停止实例也须核对所有权',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'training-removal-'));let tasks=[];
  const runtime={state:async()=>({status:'running'}),request:async(_method,path)=>{if(path==='/api/tasks')return {tasks};if(path.includes('/status'))return {state:'ready'};throw new Error('Unexpected mock request: '+path);},close:async()=>{}};
  const app=await createWorkbench({dataDir:directory,trainingOptions:{runtime}});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)})});return {status:response.status,...await response.json()};};
  const first=(await api('/api/instances',{moduleId:'training',name:'有任务'})).instance;
  const second=(await api('/api/instances',{moduleId:'training',name:'空闲实例'})).instance;
  const service=await app.context.instanceManager.context(first.id).ensureTraining();
  tasks=[{id:'active-1',status:'RUNNING',metadata:{workbench_owner:service.owner}}];
  assert.equal((await api('/api/instances/'+first.id,undefined,'DELETE')).status,409);
  assert.equal((await api('/instances/'+first.id+'/api/training/tasks')).tasks[0].id,'active-1');
  assert.equal((await api('/api/instances/'+second.id,undefined,'DELETE')).status,200,'其他实例的任务不应阻止归档空闲实例');
  await api('/api/instances/'+first.id+'/stop',{});
  assert.equal((await api('/api/instances/'+first.id,undefined,'DELETE')).status,409,'停止实例后任务继续，仍不能删除控制入口');
  tasks=[];assert.equal((await api('/api/instances/'+first.id,undefined,'DELETE')).status,200);

  const pending=(await api('/api/instances',{moduleId:'training',name:'正在检查'})).instance;
  const pendingService=await app.context.instanceManager.context(pending.id).ensureTraining();
  let rejectCheck,checking;
  const entered=new Promise(resolve=>{checking=resolve;});
  pendingService.preflight=async()=>{checking();return new Promise((_resolve,reject)=>{rejectCheck=reject;});};
  const submission=api('/instances/'+pending.id+'/api/training/tasks',{requestId:'pending-removal',config:{model_train_type:'moss-image-lora'}});
  await entered;
  assert.equal((await api('/api/instances/'+pending.id,undefined,'DELETE')).status,409);
  rejectCheck(new Error('mock preflight ended'));await submission;
  assert.equal((await api('/api/instances/'+pending.id,undefined,'DELETE')).status,200);
});
