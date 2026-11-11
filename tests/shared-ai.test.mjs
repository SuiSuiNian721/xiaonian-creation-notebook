import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';

async function fixture(t,aiOptions={}){
  const directory=await mkdtemp(join(tmpdir(),'workbench-shared-ai-'));let app=await createWorkbench({dataDir:directory,aiOptions});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {httpStatus:response.status,...await response.json()};};
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {api,directory,url:()=>app.url,async restart(){await app.close();app=await createWorkbench({dataDir:directory,aiOptions});}};
}
test('全局连接只保存一份，密钥不回传且留空保留、显式清除，重启恢复',async t=>{
  const f=await fixture(t);await f.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:1234/v1',model:'test',apiKey:'secret-key'},'PUT');
  const saved=await f.api('/api/ai/config');assert.equal(saved.hasKey,true);assert.equal(JSON.stringify(saved).includes('secret-key'),false);
  await f.api('/api/ai/config',{apiKey:''},'PUT');await f.restart();assert.equal((await f.api('/api/ai/config')).hasKey,true);
  assert.equal((await f.api('/api/ai/config',{baseUrl:'file:///secret'},'PUT')).httpStatus,400);assert.equal((await f.api('/api/ai/config')).baseUrl,'http://127.0.0.1:1234/v1');
  await f.api('/api/ai/config',{clearKey:true},'PUT');assert.equal((await f.api('/api/ai/config')).hasKey,false);
});
test('不同模块共用同一个 Codex 连接和模型设置，未启用时拒绝调用',async t=>{
  const calls=[];const f=await fixture(t,{codexRunner:async options=>{calls.push(options);return {text:'OK',usage:null};}});
  assert.equal((await f.api('/api/ai/test',{})).httpStatus,409);
  await f.api('/api/ai/config',{provider:'codex',enabled:true,model:'test-model',reasoningEffort:'high'},'PUT');
  for(const moduleId of ['drawing','voice']){await f.api(`/api/modules/${moduleId}/enable`,{});const result=await f.api('/api/ai/chat',{moduleId,messages:[{role:'user',content:'测试'}]});assert.equal(result.text,'OK');}
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.model==='test-model'&&call.reasoningEffort==='high'&&call.allowWrite===false));
});
test('兼容 API 接收实际模型、消息和服务端密钥，错误不冒充生成成功',async t=>{
  const calls=[];const f=await fixture(t,{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({choices:[{message:{content:'已生成工作流'}}],usage:{total_tokens:9}}),{status:200});}});
  await f.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:1234/v1',model:'compat-model',apiKey:'secret'},'PUT');
  assert.equal((await f.api('/api/ai/test',{})).ok,true);assert.equal(calls[0].url,'http://127.0.0.1:1234/v1/chat/completions');assert.equal(calls[0].options.headers.authorization,'Bearer secret');assert.equal(JSON.parse(calls[0].options.body).model,'compat-model');
});
test('MCP 默认关闭，要求令牌与同源，支持初始化、工具列表和 stdio 配置',async t=>{
  const f=await fixture(t);const config=await f.api('/api/ai/mcp');
  const rpc=async(message,headers={})=>fetch(f.url()+'/mcp',{method:'POST',headers:{'content-type':'application/json',...config.http.headers,...headers},body:JSON.stringify(message)});
  assert.equal((await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{}})).status,403);
  await f.api('/api/ai/config',{mcpEnabled:true},'PUT');
  const init=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});assert.equal((await init.json()).result.serverInfo.name,'ai-future-workbench');
  const listed=await (await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).json();assert.ok(listed.result.tools.some(tool=>tool.name==='comfy_generate'));
  assert.equal((await rpc({jsonrpc:'2.0',id:3,method:'ping'},{Origin:'https://evil.test'})).status,403);
  assert.equal((await rpc({jsonrpc:'2.0',method:'notifications/initialized'})).status,202);
  assert.ok(config.stdio.args[0].endsWith('workbench-mcp.mjs'));
  await f.api('/api/modules/drawing/enable',{});const result=await(await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'comfy_status',arguments:{}}})).json();assert.equal(result.result.isError,undefined);
});
test('角色卡可切换到全局连接，子模块不能再改写独立密钥',async t=>{
  const f=await fixture(t,{codexRunner:async()=>({text:'OK'})});
  await f.api('/api/ai/config',{provider:'codex',enabled:true},'PUT');await f.api('/api/modules/cards/enable',{});
  assert.equal((await f.api('/api/modules/cards/studio',{})).httpStatus,200);
  const status=await f.api('/card-studio/api/bridge/llm-status');assert.equal(status.backend,'openai');assert.ok(status.baseUrl.endsWith('/internal/ai/v1'));
  assert.equal((await f.api('/card-studio/api/bridge/llm-config',{backend:'openai',apiKey:'other'})).httpStatus,409);
});

test('导出的 stdio 客户端真实转发 MCP，并在工作台重启后读取新端口',async t=>{
  const f=await fixture(t);await f.api('/api/ai/config',{mcpEnabled:true},'PUT');await f.restart();
  const child=spawn(process.execPath,[fileURLToPath(new URL('../tools/workbench-mcp.mjs',import.meta.url)),join(f.directory,'mcp-connection.json')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='',error='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
  const exited=new Promise((resolveExit,reject)=>{child.on('error',reject);child.on('close',resolveExit);});
  child.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'}].map(value=>JSON.stringify(value)).join('\n')+'\n');
  assert.equal(await exited,0,error);const replies=output.trim().split('\n').map(line=>JSON.parse(line));assert.equal(replies.length,2);
  // stdio 转接并发派发，JSON-RPC 使用 id 对应回复，不保证响应顺序。
  assert.equal(replies.find(reply=>reply.id===1).result.serverInfo.name,'ai-future-workbench');assert.ok(replies.find(reply=>reply.id===2).result.tools.length>=9);
});

test('模块默认继承全局，专属模型独立路由，切回全局保留专属配置并在重启后恢复',async t=>{
  const calls=[];const f=await fixture(t,{codexRunner:async value=>{calls.push(value);return{text:value.model};}});
  const path='/api/ai/modules/drawing/config';
  await f.api('/api/ai/config',{provider:'codex',enabled:true,model:'model-A',reasoningEffort:'high',mcpEnabled:true},'PUT');
  const initial=await f.api(path);assert.equal(initial.httpStatus,200);assert.equal(initial.mode,'global');assert.equal(initial.effective.model,'model-A');
  await f.api(path,{mode:'module',connection:{model:'model-B'}},'PUT');
  for(const id of ['drawing','voice']){
    await f.api(`/api/modules/${id}/enable`,{});
    const reply=await f.api('/api/ai/chat',{moduleId:id,messages:[{role:'user',content:'测试'}]});assert.equal(reply.text,id==='drawing'?'model-B':'model-A');
  }
  assert.deepEqual(calls.map(call=>call.reasoningEffort),['high','high']);assert.equal((await f.api('/api/ai/config')).model,'model-A');
  await f.api('/api/ai/config',{model:'model-C',reasoningEffort:'low'},'PUT');assert.equal((await f.api(path)).effective.model,'model-B');assert.equal((await f.api(path)).effective.reasoningEffort,'low');
  await f.api('/api/ai/modules/drawing/config',{mode:'global'},'PUT');assert.equal((await f.api(path)).effective.model,'model-C');assert.equal((await f.api(path)).connection.model,'model-B');
  await f.restart();await f.api(path,{mode:'module'},'PUT');assert.equal((await f.api(path)).effective.model,'model-B');
  assert.equal((await f.api('/api/ai/mcp')).enabled,true);
});

test('全局停用不阻止专属连接，专属停用不回退全局，模块测试使用有效连接',async t=>{
  const calls=[];const f=await fixture(t,{codexRunner:async value=>{calls.push(value);return{text:'OK'};}});
  await f.api('/api/ai/modules/mc-play/config',{mode:'module',connection:{provider:'codex',enabled:true,model:'companion-model'}},'PUT');
  const result=await f.api('/api/ai/modules/mc-play/test',{});assert.equal(result.ok,true);assert.equal(calls[0].model,'companion-model');
  assert.equal((await f.api('/api/ai/test',{})).httpStatus,409);
  await f.api('/api/ai/config',{provider:'codex',enabled:true,model:'global-model'},'PUT');
  await f.api('/api/ai/modules/mc-play/config',{mode:'module',connection:{enabled:false}},'PUT');
  assert.equal((await f.api('/api/ai/modules/mc-play/test',{})).httpStatus,409);assert.equal(calls.length,1);
});

test('模块 API 默认继承全局密钥，也可独立填写或不使用密钥',async t=>{
  const calls=[];const f=await fixture(t,{fetchImpl:async(url,value)=>{calls.push({url,value});return Response.json({choices:[{message:{content:'OK'}}]});}});
  await f.api('/api/ai/config',{provider:'openai',enabled:true,model:'global-model',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'global-secret'},'PUT');
  const path='/api/ai/modules/drawing/config';
  const saved=await f.api(path,{mode:'module',connection:{model:'drawing-model',baseUrl:'http://127.0.0.1:2345/v1'}},'PUT');
  assert.equal(saved.connection.hasKey,false);assert.equal(saved.effective.hasKey,true);
  assert.equal((await f.api('/api/ai/modules/drawing/test',{})).ok,true);assert.equal(calls[0].url,'http://127.0.0.1:2345/v1/chat/completions');assert.equal(calls[0].value.headers.authorization,'Bearer global-secret');
  await f.api(path,{mode:'module',connection:{keyMode:'none'}},'PUT');await f.api('/api/ai/modules/drawing/test',{});assert.equal(calls[1].value.headers.authorization,undefined);
  await f.api(path,{mode:'module',connection:{keyMode:'custom',apiKey:'module-secret'}},'PUT');
  await f.api(path,{mode:'module',connection:{apiKey:''}},'PUT');
  assert.equal((await f.api(path)).connection.hasKey,true);assert.equal(JSON.stringify(await f.api(path)).includes('module-secret'),false);
  await f.api('/api/ai/modules/drawing/test',{});assert.equal(calls[2].value.headers.authorization,'Bearer module-secret');
  await f.api(path,{mode:'module',connection:{clearKey:true}},'PUT');assert.equal((await f.api(path)).connection.hasKey,false);assert.equal((await f.api(path)).effective.hasKey,true);
  assert.equal((await f.api('/api/ai/config')).hasKey,true);await f.api('/api/ai/test',{});assert.equal(calls[3].value.headers.authorization,'Bearer global-secret');
});

test('专属连接错误不改走全局；无效配置与模块身份被拒绝',async t=>{
  let attempts=0;const f=await fixture(t,{codexRunner:async()=>{attempts++;throw new Error('fixture connection failed');}});
  const path='/api/ai/modules/drawing/config';
  assert.equal((await f.api(path,{mode:'other'},'PUT')).httpStatus,400);
  assert.equal((await f.api(path,{mode:'module',connection:null},'PUT')).httpStatus,400);
  assert.equal((await f.api(path,{mode:'module',connection:{provider:'openai',enabled:true}},'PUT')).httpStatus,400);
  assert.equal((await f.api(path)).mode,'global');
  assert.equal((await f.api(path,{mode:'module',connection:{mcpEnabled:true}},'PUT')).httpStatus,400);
  assert.equal((await f.api('/api/ai/modules/unknown/config')).httpStatus,404);
  await f.api('/api/ai/config',{provider:'codex',enabled:true},'PUT');
  await f.api(path,{mode:'module',connection:{provider:'codex',enabled:true,model:'broken-model'}},'PUT');
  assert.equal((await f.api('/api/ai/modules/drawing/test',{})).httpStatus,502);assert.equal(attempts,1);
});

test('角色卡专属连接在未保存全局时也接入内部路由，其他模块不受影响',async t=>{
  const f=await fixture(t,{codexRunner:async()=>({text:'OK'})});
  await f.api('/api/ai/modules/cards/config',{mode:'module',connection:{provider:'codex',enabled:true,model:'card-model'}},'PUT');
  await f.api('/api/modules/cards/enable',{});assert.equal((await f.api('/api/modules/cards/studio',{})).httpStatus,200);
  const status=await f.api('/card-studio/api/bridge/llm-status');assert.equal(status.backend,'openai');assert.equal(status.enabled,true);
  assert.equal((await f.api('/card-studio/api/bridge/llm-config',{backend:'codex'})).httpStatus,409);
  assert.equal((await f.api('/api/ai/config')).enabled,false);
});

test('全局后改使模块继承参数不完整时，在请求前明确报错而不调用其他连接',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async()=>{calls++;return Response.json({choices:[{message:{content:'OK'}}]});},codexRunner:async()=>{calls++;return{text:'OK'};}});
  await f.api('/api/ai/config',{provider:'openai',enabled:true,model:'api-model',baseUrl:'http://127.0.0.1:1234/v1'},'PUT');
  await f.api('/api/ai/modules/drawing/config',{mode:'module',connection:{provider:'openai',model:'drawing-model'}},'PUT');
  await f.api('/api/ai/config',{provider:'codex',baseUrl:''},'PUT');
  assert.equal((await f.api('/api/ai/modules/drawing/test',{})).httpStatus,400);assert.equal(calls,0);
});
