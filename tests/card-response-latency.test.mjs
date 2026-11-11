import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {requestBridgeCompletion} from '../integrations/xiaoxi/tools/bridge-messages.mjs';
import {SharedAI} from '../framework/shared-ai.mjs';
import {runWorkbenchCodex} from '../framework/codex-bridge.mjs';
import {createWorkbench} from '../framework/server.mjs';
import {readModelResponse} from '../integrations/xiaoxi/tools/model-response.mjs';

const tool={type:'function',function:{name:'read_card',parameters:{type:'object',properties:{}}}};
const call={id:'read',type:'function',function:{name:'read_card',arguments:'{}'}};
async function endpoint(t,handler){
 const requests=[];
 const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const value=JSON.parse(body);requests.push(value);await handler(value,res,requests.length);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
 return {baseUrl:'http://127.0.0.1:'+server.address().port,requests};
}
const event=value=>'data: '+JSON.stringify(value)+'\n\n';

test('内置工具转接逐轮传递安全阶段并解析分块 UTF-8 流，工具只在完整响应后执行',async t=>{
 const phases=[],executed=[];
 const server=await endpoint(t,async(_body,res,index)=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write(event({workbench:{phase:'thinking'}}));
  const output=Buffer.from(event({choices:[{delta:index===1?{tool_calls:[{index:0,...call}]}:{content:'资料已读完。'}}]})+'data: [DONE]\n\n');
  for(let offset=0;offset<output.length;offset+=3)res.write(output.subarray(offset,offset+3));
  res.end();
 });
 const result=await requestBridgeCompletion({baseUrl:server.baseUrl+'/internal/ai/v1',model:'same',messages:[{role:'user',content:'读取'}],tools:[tool]}, {
  onProgress:progress=>phases.push(progress),executeTool:async name=>{executed.push(name);return {name:'中文资料'};},
 });
 assert.equal(result,'资料已读完。');assert.deepEqual(executed,['read_card']);
 assert.ok(server.requests.every(body=>body.stream===true));
 assert.ok(server.requests.every(body=>body.workbenchIdleTimeoutMs===5*60*1000));
 assert.ok(server.requests.every(body=>body.workbenchTimeoutMs===undefined),'持续产生真实活动的内置任务不设总时限');
 assert.ok(phases.some(progress=>progress.phase==='thinking'&&progress.round===1));
 assert.ok(phases.some(progress=>progress.phase==='reading'));
 assert.ok(phases.some(progress=>progress.round===2));
});

test('流在完成标记之前断开或返回错误时不执行已收到的工具',async t=>{
 let executed=0;
 for(const error of [null,{message:'连接失败'}]){
  const server=await endpoint(t,async(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(event({choices:[{delta:{tool_calls:[{index:0,...call}]}}]}));if(error)res.write(event({error}));res.end();});
  await assert.rejects(requestBridgeCompletion({baseUrl:server.baseUrl+'/internal/ai/v1',messages:[],tools:[tool]}, {executeTool:async()=>executed++}),error?/连接失败/:/完整|完成/);
 }
 assert.equal(executed,0);
});

test('已收到工具的流式请求被取消后不执行工具',async t=>{
 let executed=0;
 const server=await endpoint(t,async(_body,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(event({choices:[{delta:{tool_calls:[{index:0,...call}]}}]}));});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),50);
 try{await assert.rejects(requestBridgeCompletion({baseUrl:server.baseUrl+'/internal/ai/v1',messages:[],tools:[tool]}, {signal:controller.signal,executeTool:async()=>executed++}),/停止/);}
 finally{clearTimeout(timer);}
 assert.equal(executed,0);
});

test('宿主完整稿已准备时直接收尾，省去模型复述，失败仍交回模型解释',async t=>{
 const prepare={id:'prepare',type:'function',function:{name:'prepare_card_changes',arguments:'{}'}};
 const definition={type:'function',function:{name:'prepare_card_changes',parameters:{type:'object',properties:{}}}};
 for(const success of [true,false]){
  const server=await endpoint(t,async(_body,res,index)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:index===1?{content:null,tool_calls:[prepare]}:{content:'准备失败，已保留原稿。'}}]}));});
  const result=await requestBridgeCompletion({baseUrl:server.baseUrl,messages:[],tools:[definition]}, {executeTool:async()=>success?{proposalId:'shown-by-host',saved:false,replyReady:'proposal'}:{error:'准备失败'}});
  assert.equal(server.requests.length,success?1:2);
  assert.match(result,success?/完整.*稿|修改稿/:/准备失败/);
 }
});

test('准备稿不是批次最后一项时仍完成后续工具，不提前结束',async t=>{
 const prepare={id:'prepare',type:'function',function:{name:'prepare_card_changes',arguments:'{}'}};
 const definitions=[tool,{type:'function',function:{name:'prepare_card_changes',parameters:{type:'object',properties:{}}}}],executed=[];
 const server=await endpoint(t,async(_body,res,index)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:index===1?{content:null,tool_calls:[prepare,call]}:{content:'两项已处理。'}}]}));});
 const result=await requestBridgeCompletion({baseUrl:server.baseUrl,messages:[],tools:definitions},{executeTool:async name=>{executed.push(name);return name==='prepare_card_changes'?{proposalId:'ready',saved:false,replyReady:'proposal'}:{name:'当前卡'};}});
 assert.equal(result,'两项已处理。');assert.deepEqual(executed,['prepare_card_changes','read_card']);assert.equal(server.requests.length,2);
});

test('共用 Codex 的宿主工具推理保留模型档位并转发阶段，不泄漏结构化 JSON 到进度',async t=>{
 const phases=[],settings=new Map([['ai.connection',{provider:'codex',enabled:true,model:'retained-model',reasoningEffort:'max'}]]);
 let input;
 const ai=new SharedAI({store:{getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value),event(){}},dataDir:tmpdir(),codexRunner:async options=>{input=options;options.onProgress?.({phase:'thinking',partialText:'{"tool_calls":['});return {text:'{"content":"完成","tool_calls":[]}'};}});
 t.after(()=>ai.close());
 const result=await ai.complete([{role:'user',content:'读取'}],{moduleId:'cards',tools:[tool],onProgress:p=>phases.push(p)});
 assert.equal(input.inferenceOnly,true);assert.equal(input.model,'retained-model');assert.equal(input.reasoningEffort,'max');
 assert.equal(result.text,'完成');assert.ok(phases.some(p=>p.phase==='thinking'));
 assert.ok(phases.every(p=>!p.partialText));
});

async function codexFixture(t,mode='normal'){
 const directory=await mkdtemp(join(tmpdir(),'card-latency-cli-')),log=join(directory,'events.jsonl'),calls=[];
 const spawnProcess=(cli,args,options)=>{calls.push(args);return spawn(process.execPath,[fileURLToPath(new URL('./fixtures/codex-config-cli.mjs',import.meta.url)),...args],{...options,env:{...options.env,CODEX_FIXTURE_LOG:log,CODEX_FIXTURE_MODE:mode,CODEX_FIXTURE_SERVERS:'{}'}});};
 t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
 return {directory,calls,spawnProcess,async events(){return (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}};
}

test('宿主推理关闭无关技能和工程上下文，原生制卡路径维持原能力',async t=>{
 const f=await codexFixture(t);
 await runWorkbenchCodex({cli:'fixture',cwd:f.directory,prompt:'仅回复 OK',model:'retained-model',reasoningEffort:'max',allowWrite:false,ephemeral:true,inferenceOnly:true,spawnProcess:f.spawnProcess,timeoutMs:5000});
 const args=f.calls.at(-1),events=await f.events();
 assert.ok(args.includes('project_doc_max_bytes=0'));assert.ok(args.includes('skip_host_skill_discovery'));
 const thread=events.find(e=>e.method==='thread/start').params,turn=events.find(e=>e.method==='turn/start').params;
 assert.match(thread.baseInstructions,/提供|对话/);assert.equal(turn.model,'retained-model');assert.equal(turn.effort,'max');
 assert.equal(thread.sandbox,'read-only');
});

test('未指定模型档位的宿主推理继续继承 CLI，普通路径保留工程上下文',async t=>{
 for(const inferenceOnly of [true,false]){
  const f=await codexFixture(t);
  await runWorkbenchCodex({cli:'fixture',cwd:f.directory,prompt:'OK',model:'',reasoningEffort:'',allowWrite:false,ephemeral:true,inferenceOnly,spawnProcess:f.spawnProcess,timeoutMs:5000});
  const events=await f.events(),thread=events.find(e=>e.method==='thread/start').params,turn=events.find(e=>e.method==='turn/start').params;
  assert.equal(Object.hasOwn(thread,'model'),false);assert.equal(Object.hasOwn(turn,'effort'),false);
  assert.equal(f.calls.at(-1).includes('--ignore-user-config'),false);
  assert.equal(f.calls.at(-1).includes('project_doc_max_bytes=0'),inferenceOnly);
  assert.equal(Object.hasOwn(thread,'baseInstructions'),inferenceOnly);
 }
});

test('超时错误使用当前配置的时限，不再把短请求写成三十分钟',async t=>{
 const f=await codexFixture(t,'turn-stall');
 await assert.rejects(runWorkbenchCodex({cli:'fixture',cwd:f.directory,prompt:'等待',allowWrite:false,ephemeral:true,spawnProcess:f.spawnProcess,timeoutMs:700,closeTimeoutMs:80}),error=>{assert.match(error.message,/1 秒.*总时限/);assert.doesNotMatch(error.message,/30 分钟/);return true;});
});

test('内置路由验证剩余时限并立即传递阶段，最终工具结果保持完整',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'card-latency-http-')),calls=[];
 const app=await createWorkbench({dataDir:directory,instances:false,aiOptions:{codexRunner:async options=>{calls.push(options);options.onProgress({phase:'thinking',partialText:'不得进入界面的原始结构'});return {text:JSON.stringify({content:'',tool_calls:[{name:'read_card',arguments:'{}'}]})};}}});
 t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
 app.context.sharedAI.save({provider:'codex',enabled:true,model:'retained-model',reasoningEffort:'max'});
 const request=value=>fetch(app.url+'/internal/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+app.context.sharedAI.token},body:JSON.stringify(value)});
 const body={messages:[{role:'user',content:'读取'}],tools:[tool],stream:true};
 for(const workbenchTimeoutMs of [0,480001,'30000']){const r=await request({...body,workbenchTimeoutMs});assert.equal(r.status,400);await r.text();}
 assert.equal(calls.length,0);
 const response=await request({...body,workbenchTimeoutMs:25000}),raw=await response.text(),phases=[];
 assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
 assert.doesNotMatch(raw,/不得进入界面/);
 const value=await readModelResponse(new Response(raw,{headers:{'content-type':'text/event-stream'}}),{onProgress:p=>phases.push(p)});
 assert.equal(value.choices[0].message.tool_calls[0].function.name,'read_card');
 assert.ok(phases.some(p=>p.phase==='thinking'));assert.equal(calls[0].timeoutMs,20000);
 assert.equal(calls[0].model,'retained-model');assert.equal(calls[0].reasoningEffort,'max');
});
