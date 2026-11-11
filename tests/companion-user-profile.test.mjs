import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {completeAiriChat} from '../framework/companion-ai.mjs';
import {Companion} from '../framework/companion.mjs';
import {LiteCompanion} from '../framework/companion-lite.mjs';

const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const profile={displayName:'测试用户',avatar,identity:'独立创作者',preferences:'喜欢自然简短的交流'};
const character={id:'test-character',name:'测试角色',revision:1,raw:{extensions:{workbenchAvatar:avatar}}};
const store={state:()=>({selectedCharacterId:character.id,characters:[character]}),getSetting:()=>null,module:()=>({enabled:true}),event:()=>{}};

function lifeFixture(){
  const saved=[],contexts=[],outputs=[];
  return {contexts,outputs,configRevision:()=>1,data:{list:()=>[...saved].reverse(),transaction:callback=>callback(),put:(_id,_kind,value)=>saved.push(value)},context:async value=>{contexts.push(value);return {messages:[{role:'system',content:'角色资料'},...value.history],runtimeContext:{mode:'lite',configRevision:1}};},processOutput:async value=>{outputs.push(value);return {text:value.text,actions:[]};},observe:async()=>{}};
}

for(const provider of ['openai','codex'])test(`原生 ${provider} 实际请求只包含已填用户文字，不发送头像`,async()=>{
  let sent;
  const life=lifeFixture();
  const sharedAI={config:()=>({enabled:true,provider,baseUrl:'https://fixture.invalid/v1',model:'fixture'}),fetch:async(_url,options)=>{sent=JSON.parse(options.body).messages;return Response.json({choices:[{message:{role:'assistant',content:'你好'},finish_reason:'stop'}]});},complete:async messages=>{sent=messages;return {text:'你好'};}};
  await completeAiriChat({sharedAI,life,character,userProfile:profile,value:{messages:[{role:'user',content:'今天好呀'}]}});
  const prompt=JSON.stringify(sent);
  assert.match(prompt,/测试用户/);assert.match(prompt,/独立创作者/);assert.match(prompt,/喜欢自然简短的交流/);assert.doesNotMatch(prompt,/data:image|base64|workbenchAvatar/);
  assert.equal(life.contexts[0].userName,'测试用户');
  assert.match(JSON.stringify(life.outputs[0].context.messages),/独立创作者/,'角色工具续写上下文保留用户资料');
});

test('原生空白用户资料不增加空白人设段落',async()=>{
  let sent;
  const messages=[{role:'user',content:'你好'}];
  await completeAiriChat({sharedAI:{config:()=>({enabled:true,provider:'codex'}),complete:async value=>{sent=value;return {text:'你好'};}},userProfile:{displayName:'',avatar,identity:'',preferences:''},value:{messages}});
  assert.deepEqual(sent,messages);
});

test('陪伴启动和运行中同步读取当前资料，并为角色派生头像',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'companion-profile-'));
  let current=profile,bootstrap,updated;
  const companion=new Companion({store,dataDir:directory,userProfile:()=>current,inspect:()=>({available:true}),host:{start:async value=>{bootstrap=value.bootstrap;},syncUserProfile:async value=>{updated=value;},close:async()=>{}}});
  t.after(async()=>{await companion.close();await rm(directory,{recursive:true,force:true});});
  await companion.start('http://127.0.0.1:3000');
  assert.deepEqual(bootstrap.userProfile,profile);assert.equal(bootstrap.character.avatar,avatar);
  current={displayName:'新名字',avatar:'',identity:'',preferences:''};
  await companion.syncUserProfile();assert.deepEqual(updated,current);
});

test('启动末尾正在同步旧资料时保存新资料，完成启动前重新校准',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'companion-profile-start-race-'));
  let current=profile,updated,release,entered,calls=0;
  const began=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  const companion=new Companion({store,dataDir:directory,userProfile:()=>current,inspect:()=>({available:true}),host:{start:async()=>{},syncUserProfile:async value=>{if(++calls===1){entered();await resume;}updated=value;},close:async()=>{}}});
  t.after(async()=>{release();await companion.close();await rm(directory,{recursive:true,force:true});});
  const starting=companion.start('http://127.0.0.1:3000');await began;
  current={displayName:'启动时新名字',avatar:'',identity:'最新身份',preferences:''};
  await companion.syncUserProfile();release();await starting;
  assert.equal(companion.status,'running');assert.deepEqual(updated,current);assert.equal(calls,2);
});

test('运行中连续保存按提交顺序同步，较慢旧资料不能覆盖新资料',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'companion-profile-running-race-'));
  let current=profile,updated,release,entered;
  const began=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  const companion=new Companion({store,dataDir:directory,userProfile:()=>current,inspect:()=>({available:true}),host:{start:async()=>{},syncUserProfile:async value=>{if(value.displayName==='较慢旧名字'){entered();await resume;}updated=value;},close:async()=>{}}});
  t.after(async()=>{release();await companion.close();await rm(directory,{recursive:true,force:true});});
  await companion.start('http://127.0.0.1:3000');
  current={...profile,displayName:'较慢旧名字'};const first=companion.syncUserProfile();await began;
  current={...profile,displayName:'最后新名字'};const second=companion.syncUserProfile();release();
  await Promise.all([first,second]);assert.deepEqual(updated,current);
});

test('启动末尾同步用户资料期间切换角色，角色与用户资料一起校准',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'companion-character-profile-race-'));
  let currentCharacter=character,nativeCharacter,release,entered,profileCalls=0;
  const began=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;});
  const localStore={...store,state:()=>({selectedCharacterId:currentCharacter.id,characters:[currentCharacter]})};
  const companion=new Companion({store:localStore,dataDir:directory,userProfile:()=>profile,inspect:()=>({available:true}),host:{start:async()=>{},syncCharacter:async value=>{nativeCharacter=value;},syncUserProfile:async()=>{if(++profileCalls===1){entered();await resume;}},close:async()=>{}}});
  t.after(async()=>{release();await companion.close();await rm(directory,{recursive:true,force:true});});
  const starting=companion.start('http://127.0.0.1:3000');await began;
  currentCharacter={...character,id:'new-character',name:'最后选择的角色'};await companion.syncCharacter();release();await starting;
  assert.equal(companion.status,'running');assert.equal(nativeCharacter.id,currentCharacter.id);assert.equal(profileCalls,2);
});

test('精简陪伴每次读取最新用户资料并返回双方头像，清空后不残留旧资料',async()=>{
  let current=profile;const requests=[],life=lifeFixture();
  const lite=new LiteCompanion({store,life,userProfile:()=>current,packages:{ready:()=>true,require:()=>{},policy:()=>({forcedMode:'lite',prompt:'精简模式'})},sharedAI:{complete:async messages=>{requests.push(messages);return {text:'角色回复'};}}});
  const first=await lite.chat({text:'第一次'});
  assert.equal(first.character.avatar,avatar);assert.deepEqual(first.userProfile,profile);
  assert.match(JSON.stringify(requests[0]),/独立创作者/);assert.doesNotMatch(JSON.stringify(requests[0]),/data:image|base64/);assert.equal(life.contexts[0].userName,'测试用户');
  current={displayName:'',avatar:'',identity:'',preferences:''};
  const second=await lite.chat({text:'第二次'});
  assert.deepEqual(second.userProfile,current);assert.doesNotMatch(JSON.stringify(requests[1]),/测试用户|独立创作者|喜欢自然简短的交流/);
});

test('实际 HTTP 与角色上下文链向完整及精简陪伴传递全局文字资料',async t=>{
  const {createWorkbench}=await import('../framework/server.mjs');
  const {installCharacterPackages}=await import('./helpers/character-packages.mjs');
  const directory=await mkdtemp(join(tmpdir(),'companion-profile-http-')),requests=[];let bootstrap;
  const app=await createWorkbench({dataDir:directory,aiOptions:{fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return Response.json({choices:[{message:{role:'assistant',content:'角色回复'},finish_reason:'stop'}]});}},companionOptions:{inspect:()=>({available:true}),host:{start:async value=>{bootstrap=value.bootstrap;},close:async()=>{}}}});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const api=async(path,value,method='POST',headers={})=>{const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
  const created=await api('/api/characters',{name:'测试角色',description:'陪伴身份',raw:character.raw});
  await api('/api/characters/select',{id:created.character.id});
  await api('/api/user-profile',profile);
  await api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
  await installCharacterPackages(app.url,'companion');await installCharacterPackages(app.url,'companion-lite');
  await api(`/api/characters/${created.character.id}/life/settings`,{mode:'full',memory:{autoExtract:false}});
  await api('/api/modules/companion/start',{});
  await api('/internal/companion/ai/v1/chat/completions',{messages:[{role:'user',content:'你好'}]},'POST',{authorization:'Bearer '+bootstrap.token});
  await api('/api/modules/companion-lite/chat',{text:'你好'});
  const chats=requests.filter(request=>request.messages.at(-1)?.content==='你好');
  assert.equal(chats.length,2);
  for(const request of chats){assert.match(JSON.stringify(request.messages),/独立创作者/);assert.match(JSON.stringify(request.messages),/喜欢自然简短的交流/);assert.doesNotMatch(JSON.stringify(request.messages),/data:image|base64|workbenchAvatar/);}
});
