import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';
import { characterPackageAdapter } from '../framework/character-packages.mjs';

async function fixture(t, options={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'workbench-character-packages-'));
  const app=await createWorkbench({dataDir,...options});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const res=await fetch(app.url+path,{method,headers:value===undefined?{}:{'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
    return {httpStatus:res.status,status:res.status,...await res.json()};
  };
  return {...app,dataDir,api};
}
async function install(app,id) {
  assert.equal((await app.api(`/api/modules/${id}/enable`,{})).status,200);
  const base=`/api/modules/${id}/resources`,plan=await app.api(base+'/plan',{optionalIds:[]});
  if(!plan.canInstall){const state=await app.api(base);assert.equal(state.prerequisitesReady,true);return state;}
  assert.equal(plan.canInstall,true,JSON.stringify(plan));
  assert.equal((await app.api(base+'/install',{optionalIds:[],planId:plan.planId})).status,200);
  for(let i=0;i<100;i++){
    const state=await app.api(base);
    if(state.task?.status==='completed'){assert.equal(state.prerequisitesReady,true);return state;}
    assert.notEqual(state.task?.status,'failed',JSON.stringify(state));
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('安装未结束');
}

test('可选角色包默认未安装，实际写入校验并共享复用；损坏后撤销能力且允许修复',async t=>{
  const app=await fixture(t),state=await app.api('/api/state');
  assert.equal(state.modules.length,13);
  for(const id of ['character-lite','character-full','companion-lite','companion']){
    assert.equal(state.modules.find(m=>m.id===id).enabled,false);
    assert.equal((await app.api(`/api/modules/${id}/resources`)).prerequisitesReady,false);
  }
  const {character}=await app.api('/api/characters',{name:'测试杏',description:'喜欢杏花'}),base=`/api/characters/${character.id}/life`;
  assert.equal((await app.api(base+'/preview',{text:'你好'})).status,409);
  await install(app,'character-full');
  await app.api(base+'/settings',{mode:'full'});
  assert.equal((await app.api(base)).effectiveMode,'full');
  await app.api(base+'/memories',{content:'SHARED_MEMORY_MARK',pinned:true});
  const qq=await app.api(base+'/preview',{moduleId:'qq',text:'杏花'});
  assert.match(qq.prompt,/SHARED_MEMORY_MARK/);assert.match(qq.prompt,/遵循本机按顺序匹配/);
  await app.api('/api/modules/companion-lite/enable',{});
  const plan=await app.api('/api/modules/companion-lite/resources/plan',{optionalIds:[]});
  const shared=plan.resources.find(r=>r.id==='role-base');
  assert.equal(shared.status,'installed');assert.equal(shared.shared,true);
  const file=join(shared.installationDirectory,'role-base','1.0.0','policy.json');
  const original=await readFile(file,'utf8');assert.match(original,/人设/);
  await writeFile(file,'{}','utf8');
  assert.equal((await app.api(base)).capabilities.lite,false);
  assert.equal((await app.api(base+'/preview',{text:'你好'})).status,409);
  assert.equal((await app.api('/api/modules/character-full/resources')).prerequisitesReady,false);
  await install(app,'character-full');
  assert.equal(await readFile(file,'utf8'),original);
  const advanced=(await app.api('/api/modules/character-full/resources')).resources.find(r=>r.id==='role-full');
  const advancedFile=join(advanced.installationDirectory,'role-full','1.0.0','policy.json');
  const advancedOriginal=await readFile(advancedFile,'utf8');await writeFile(advancedFile,'{}','utf8');
  const reduced=await app.api(base);assert.equal(reduced.effectiveMode,'lite');assert.equal(reduced.settings.mode,'full');assert.equal(reduced.capabilities.full,false);
  const basic=await app.api(base+'/preview',{moduleId:'qq',text:'杏花'});assert.equal(basic.runtimeContext.mode,'lite');assert.doesNotMatch(basic.prompt,/连续状态|当前决策/);
  await install(app,'character-full');assert.equal(await readFile(advancedFile,'utf8'),advancedOriginal);
  const exported=await app.api('/api/modules/character-full/package');
  assert.equal(exported.format,'ai-future-local-module-package');assert.equal(exported.version,'1.0.0');
  assert.ok(exported.resources.every(r=>/^[a-f0-9]{64}$/.test(r.sha256)));
  assert.equal((await app.api('/api/modules/character-lite/package',{package:exported,planId:'unused'})).status,400);
  await app.api('/api/modules/character-full/disable',{});
  assert.equal((await app.api(base)).settings.mode,'full');
  assert.equal((await app.api(base)).capabilities.full,false);
});

test('导出的本机安装包可校验后走同一安装任务，篡改内容不生成任务',async t=>{
  const app=await fixture(t),id='character-lite';
  await app.api(`/api/modules/${id}/enable`,{});
  const exported=await app.api(`/api/modules/${id}/package`);delete exported.status;delete exported.httpStatus;
  const prepared=await app.api(`/api/modules/${id}/resources`),resource=prepared.resources[0];
  await writeFile(join(resource.installationDirectory,resource.id,resource.version,'policy.json'),'{}','utf8');
  const plan=await app.api(`/api/modules/${id}/resources/plan`,{optionalIds:[]});
  const changed=structuredClone(exported);changed.resources[0].payload+='改动';
  assert.equal((await app.api(`/api/modules/${id}/package`,{package:changed,planId:plan.planId})).status,400);
  assert.deepEqual((await app.api(`/api/modules/${id}/resources`)).task,prepared.task);
  const imported=await app.api(`/api/modules/${id}/package`,{package:exported,planId:plan.planId});assert.equal(imported.status,200);
  for(let i=0;i<100;i++){
    const state=await app.api(`/api/modules/${id}/resources`);
    if(state.task?.status==='completed'){assert.equal(state.prerequisitesReady,true);return;}
    await new Promise(r=>setTimeout(r,10));
  }
  assert.fail('导入安装任务未结束');
});

test('精简陪伴 HTTP 强制基本人设和记忆，隔离高级能力且保留历史',async t=>{
  const requests=[];
  const app=await fixture(t,{aiOptions:{fetchImpl:async(_url,options)=>{
    requests.push(JSON.parse(options.body));
    return Response.json({choices:[{message:{content:requests.length===1?'你好，杏花开了。':'{"memories":[],"state":{"energy":0},"diary":"不得写入"}'}}]});
  }}});
  const {character}=await app.api('/api/characters',{name:'测试杏',description:'陪你看花',raw:{data:{name:'测试杏',description:'陪你看花 <% throw new Error("不应执行") %>',character_book:{entries:[{keys:['杏花'],content:'不得进入精简人设的世界书',enabled:true}]}}}});
  const base=`/api/characters/${character.id}/life`;
  await app.api('/api/characters/select',{id:character.id});
  await app.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
  assert.equal((await app.api('/api/modules/companion-lite/chat',{text:'杏花'})).status,409);
  await install(app,'character-full');await install(app,'companion-lite');
  await app.api(base+'/settings',{mode:'full',memory:{autoExtract:true},runtime:{templatesEnabled:true,scriptsEnabled:true}});
  assert.equal((await app.api(base+'/scripts/preview?moduleId=companion-lite',{code:'return 1'})).status,409);
  assert.equal((await app.api(base+'/frame?moduleId=companion-lite',{html:'<p>高级界面</p>'})).status,409);
  const scoped=await app.api(base+'/preview?moduleId=companion-lite',{text:'杏花'});
  assert.equal(scoped.runtimeContext.mode,'lite');
  const result=await app.api('/api/modules/companion-lite/chat',{text:'杏花',conversationId:'garden'});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.reply,'你好，杏花开了。');assert.equal(result.effectiveMode,'lite');
  assert.equal(result.messages.length,2);
  assert.doesNotMatch(JSON.stringify(requests[0].messages),/连续状态|当前决策|不得进入精简人设的世界书|throw new Error/);
  assert.equal((await app.api(base)).settings.mode,'full');assert.equal((await app.api(base)).state.energy,60);assert.equal((await app.api(base)).diary.length,0);
  assert.equal((await app.api('/api/modules/companion-lite/state?conversationId=garden')).messages.length,2);
  assert.equal((await app.api(base+'?moduleId=companion-lite')).effectiveMode,'lite');
  await app.api('/api/modules/companion-lite/disable',{});
  assert.equal((await app.api('/api/modules/companion-lite/chat',{text:'旧接口'})).status,409);
  await app.api('/api/modules/companion-lite/enable',{});
  assert.equal((await app.api('/api/modules/companion-lite/state?conversationId=garden')).messages.length,2);
});

test('取消本机包安装不留下已验证能力，重试安装正常',async t=>{
  let started,release;
  const began=new Promise(r=>{started=r;}),resume=new Promise(r=>{release=r;});
  let first=true;
  const app=await fixture(t,{installationAdapters:{'local-character-policy':{
    ...characterPackageAdapter,
    async install(context){if(first){first=false;started();await resume;}return characterPackageAdapter.install(context);},
  }}});
  const enabling=app.api('/api/modules/character-full/enable',{});await began;
  const task=await app.api('/api/modules/character-full/resources');
  const canceled=await app.api('/api/modules/character-full/resources/cancel',{taskId:task.task.id});
  assert.equal(canceled.task.status,'cancelled');release();assert.equal((await enabling).status,200);
  await new Promise(r=>setTimeout(r,30));
  const state=await app.api('/api/modules/character-full/resources');assert.equal(state.prerequisitesReady,false);assert.ok(state.resources.every(r=>r.status!=='installed'));
  await install(app,'character-full');
});

test('精简陪伴等待模型期间移除模块会撤销旧回复，后续重装入口保留原设置',async t=>{
  let started,release;const began=new Promise(r=>{started=r;}),resume=new Promise(r=>{release=r;});
  let nativeStarts=0;
  const app=await fixture(t,{aiOptions:{fetchImpl:async()=>{started();await resume;return Response.json({choices:[{message:{content:'不应保存的旧回复'}}]});}},companionOptions:{host:{async start(){nativeStarts++;},async close(){}}}});
  const {character}=await app.api('/api/characters',{name:'撤销杏',description:'花'});await app.api('/api/characters/select',{id:character.id});
  await app.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');await install(app,'companion-lite');
  const pending=app.api('/api/modules/companion-lite/chat',{text:'你好'});await began;
  await app.api('/api/modules/companion-lite/disable',{});release();assert.equal((await pending).status,409);
  await app.api('/api/modules/companion-lite/enable',{});
  const state=await app.api('/api/modules/companion-lite/state');assert.equal(state.messages.length,0);assert.equal(state.ready,true);assert.equal(nativeStarts,0);
});

test('完整陪伴实际模型消息读取已校验的原生策略，删除策略文件阻止旧令牌绕过',async t=>{
  let bootstrap,received;
  const app=await fixture(t,{aiOptions:{fetchImpl:async(_url,options)=>{received=JSON.parse(options.body);return Response.json({choices:[{index:0,message:{role:'assistant',content:'你好'},finish_reason:'stop'}]});}},companionOptions:{inspect:()=>({available:true,version:'fixture',installPath:'fixture'}),host:{async start(value){bootstrap=value.bootstrap;},async close(){},viewport(){}}}});
  await app.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
  const installed=await install(app,'companion');assert.equal((await app.api('/api/modules/companion/start',{})).httpStatus,200);
  const send=()=>fetch(app.url+'/internal/companion/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bootstrap.token},body:JSON.stringify({messages:[{role:'user',content:'你好'}]})});
  assert.equal((await send()).status,200);assert.match(JSON.stringify(received.messages),/这是完整陪伴运行端/);
  const policy=installed.resources.find(r=>r.id==='companion-full');await rm(join(policy.installationDirectory,'companion-full','1.0.0','policy.json'));
  assert.equal((await send()).status,409);
});

test('完整版原生陪伴仍遵守精简角色的无工具契约，切完整后才传递工具协议',async t=>{
  let bootstrap,received,wait=false,started,release;
  const began=new Promise(r=>{started=r;}),resume=new Promise(r=>{release=r;});
  const tools=[{type:'function',function:{name:'look',parameters:{type:'object'}}}],calls=[{id:'test-call',type:'function',function:{name:'look',arguments:'{}'}}];
  const app=await fixture(t,{aiOptions:{fetchImpl:async(_url,options)=>{received=JSON.parse(options.body);if(wait){started();await resume;}return Response.json({choices:[{index:0,message:{role:'assistant',content:'你好',tool_calls:calls},finish_reason:'tool_calls'}]});}},companionOptions:{inspect:()=>({available:true,version:'fixture',installPath:'fixture'}),host:{async start(value){bootstrap=value.bootstrap;},async close(){},viewport(){}}}});
  const {character}=await app.api('/api/characters',{name:'工具隔离杏',description:'花'});await app.api('/api/characters/select',{id:character.id});
  await app.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');await install(app,'companion');
  await app.api('/api/modules/companion/start',{});
  const send=async()=>{
    const result=await fetch(app.url+'/internal/companion/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bootstrap.token},body:JSON.stringify({tools,tool_choice:'auto',messages:[{role:'user',content:'你好'}]})});
    assert.equal(result.status,200);return result.json();
  };
  const lite=await send();assert.equal(received.tools,undefined);assert.equal(received.tool_choice,undefined);assert.equal(lite.choices[0].message.tool_calls,undefined);assert.equal(lite.choices[0].finish_reason,'stop');
  await app.api(`/api/characters/${character.id}/life/settings`,{mode:'full'});
  const full=await send();assert.deepEqual(received.tools,tools);assert.deepEqual(full.choices[0].message.tool_calls,calls);assert.equal(full.choices[0].finish_reason,'tool_calls');
  wait=true;const pending=send();await began;
  await app.api(`/api/characters/${character.id}/life/settings`,{mode:'lite'});release();
  const revoked=await pending;assert.equal(revoked.choices[0].message.tool_calls,undefined);assert.equal(revoked.choices[0].finish_reason,'stop');
});

test('完整版状态栏能力由已验证安装和配置版本共同撤销',async t=>{
  const app=await fixture(t),{character}=await app.api('/api/characters',{name:'测试杏',description:'杏'}),base=`/api/characters/${character.id}/life`;
  await app.api(base+'/settings',{mode:'full',runtime:{scriptsEnabled:true}});
  assert.equal((await app.api(base+'/frame',{html:'<p>杏</p>'})).status,409);
  await install(app,'character-full');
  const frame=await app.api(base+'/frame',{html:'<p>杏</p>'});assert.equal(frame.status,200);
  assert.equal((await fetch(app.url+frame.url)).status,200);
  await app.api(base+'/settings',{mode:'lite'});
  assert.equal((await fetch(app.url+frame.url)).status,409);
  await app.api(base+'/settings',{mode:'full'});
  assert.equal((await fetch(app.url+frame.url)).status,409);
  const next=await app.api(base+'/frame',{html:'<p>新状态</p>'});assert.equal(next.status,200);
  await app.api('/api/modules/character-full/disable',{});
  assert.equal((await fetch(app.url+next.url)).status,409);
  await app.api('/api/modules/character-full/enable',{});
  assert.equal((await fetch(app.url+next.url)).status,409);
  const fresh=await app.api(base+'/frame',{html:'<p>重新授权</p>'});assert.equal(fresh.status,200);
  assert.equal((await fetch(app.url+fresh.url)).status,200);
  await app.api('/api/modules/companion/enable',{});
  assert.equal((await app.api('/api/modules/companion/resources')).prerequisitesReady,true);
  assert.equal((await app.api('/api/modules/companion/start',{})).status,503);
});

test('移除再添加角色模块不改变设置，但旧的完整观察结果永久失效',async t=>{
  let characterId,bootstrap,started,release;
  const began=new Promise(r=>{started=r;}),resume=new Promise(r=>{release=r;});let calls=0;
  const app=await fixture(t,{aiOptions:{fetchImpl:async()=>{
    calls++;
    if(calls===1)return Response.json({choices:[{index:0,message:{role:'assistant',content:'你好'},finish_reason:'stop'}]});
    started();await resume;
    return Response.json({choices:[{message:{content:'{"memories":[],"state":{"energy":0},"diary":"旧观察不得写入"}'}}]});
  }},companionOptions:{inspect:()=>({available:true,version:'fixture',installPath:'fixture'}),host:{async start(value){bootstrap=value.bootstrap;},async characterContext(){return {managed:true,id:characterId,conversationId:'epoch',generation:1,sourceId:'epoch-turn'};},async confirmReply(){return true;},async close(){},viewport(){}}}});
  const {character}=await app.api('/api/characters',{name:'代数杏',description:'花'});characterId=character.id;
  await app.api('/api/characters/select',{id:characterId});await app.api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
  await install(app,'companion');await app.api('/api/modules/character-full/enable',{});
  const base=`/api/characters/${characterId}/life`;await app.api(base+'/settings',{mode:'full'});
  await app.api('/api/modules/companion/start',{});
  const response=await fetch(app.url+'/internal/companion/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bootstrap.token},body:JSON.stringify({messages:[{role:'user',content:'你好'}]})});assert.equal(response.status,200);await response.json();await began;
  const revision=(await app.api(base)).configRevision;
  await app.api('/api/modules/character-full/disable',{});await app.api('/api/modules/character-full/enable',{});
  release();await new Promise(r=>setTimeout(r,40));
  const view=await app.api(base);assert.notEqual(view.configRevision,revision);assert.equal(view.settings.mode,'full');assert.equal(view.effectiveMode,'full');assert.equal(view.state.energy,60);assert.equal(view.diary.length,0);
});
