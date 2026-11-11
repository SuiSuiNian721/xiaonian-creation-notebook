import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {LiteCompanion} from '../framework/companion-lite.mjs';
import {createWorkbench} from '../framework/server.mjs';
import {installCharacterPackages} from './helpers/character-packages.mjs';

const audioPath='/internal/voice-audio/'+'a'.repeat(64)+'/'+'b'.repeat(64);
const character={id:'voice-character',name:'小璃',revision:1};
function fixture(baseUrl,actions=[]){
  const saved=[];
  const life={configRevision:()=>1,data:{list:()=>[...saved].reverse(),transaction:callback=>callback(),put:(_id,_kind,value)=>saved.push(value)},
    context:async value=>({messages:value.history}),processOutput:async()=>({text:'你好',actions}),observe:async()=>{}};
  const lite=new LiteCompanion({store:{state:()=>({characters:[character],selectedCharacterId:character.id})},life,baseUrl:()=>baseUrl,
    packages:{ready:()=>true,require:()=>{},policy:()=>({forcedMode:'lite',prompt:'陪伴'})},sharedAI:{complete:async()=>({text:'你好'})}});
  return {lite,saved};
}

for(const prefix of ['','/instances/11111111-1111-4111-8111-111111111111'])test('精简陪伴保存可跨端口回放的签名语音路径'+(prefix?'，包含当前实例前缀':''),async()=>{
  const url='http://127.0.0.1:12345'+prefix;
  const {lite,saved}=fixture(url,[{type:'record',url:url+audioPath,voiceId:'xiaoli-warm-bright'}]);
  const result=await lite.chat({text:'你好'});
  assert.equal(saved.at(-1).actions[0].url,prefix+audioPath);
  assert.equal(result.actions[0].url,prefix+audioPath);
  lite.baseUrl=()=> 'http://127.0.0.1:23456'+prefix;
  assert.equal(lite.state().messages.at(-1).actions[0].url,prefix+audioPath);
});

test('精简陪伴仅在历史回放兼容相同回环宿主的旧端口签名路径',async()=>{
  const prefix='/instances/11111111-1111-4111-8111-111111111111';
  const {lite,saved}=fixture('http://127.0.0.1:23456'+prefix);
  saved.push({scope:'companion-lite:default',role:'assistant',content:'原记录',actions:[{type:'record',url:'http://127.0.0.1:12345'+prefix+audioPath}]});
  assert.equal(lite.state().messages[0].actions[0].url,prefix+audioPath);
  assert.equal(saved[0].actions[0].url,'http://127.0.0.1:12345'+prefix+audioPath,'读取历史不改写原记录');
});

test('新回复和历史均拒绝外部、跨实例及伪造的语音地址',async()=>{
  const prefix='/instances/11111111-1111-4111-8111-111111111111',base='http://127.0.0.1:23456';
  const invalid=['https://example.invalid'+prefix+audioPath,'//example.invalid'+prefix+audioPath,
    base+'/instances/22222222-2222-4222-8222-222222222222'+audioPath,base+audioPath,base+prefix+audioPath+'?download=1',
    base+prefix+'/api/voice/state',base.replace('127.0.0.1','127.0.0.2')+prefix+audioPath,
    'http://user@127.0.0.1:23456'+prefix+audioPath,base+prefix+'/other/..'+audioPath];
  const actions=invalid.map(url=>({type:'record',url}));
  const {lite,saved}=fixture(base+prefix,actions);
  const result=await lite.chat({text:'你好'});
  assert.deepEqual(result.actions,[]);
  assert.deepEqual(saved.at(-1).actions,[]);
  saved.push({scope:'companion-lite:default',role:'assistant',content:'旧记录',actions});
  assert.deepEqual(lite.state().messages.at(-1).actions,[]);
  const oldPort={type:'record',url:'http://127.0.0.1:12345'+prefix+audioPath};
  const fresh=fixture(base+prefix,[oldPort]);
  assert.deepEqual((await fresh.lite.chat({text:'旧端口不能用于新回复'})).actions,[]);
});

for(const instance of [false,true])test('精简陪伴实际 HTTP 重启换端口后回放新旧语音记录'+(instance?'，隔离实例':''),async t=>{
  const directory=await mkdtemp(join(tmpdir(),'lite-voice-http-'));let app;
  const options={dataDir:directory,instances:instance,aiOptions:{fetchImpl:async()=>Response.json({choices:[{message:{role:'assistant',content:'你好'},finish_reason:'stop'}]})},
    lifeOptions:{sharedVoice:async()=>({type:'record',url:app.url+audioPath})},
    instanceOptionsFactory:({instanceId})=>({lifeOptions:{sharedVoice:async()=>({type:'record',url:app.url+'/instances/'+instanceId+audioPath})}})};
  app=await createWorkbench(options);
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});
    const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
  };
  await api('/api/ai/config',{provider:'openai',enabled:true,baseUrl:'http://127.0.0.1:9888/v1',model:'fixture'},'PUT');
  const id=instance?(await api('/api/instances',{moduleId:'companion-lite',name:'语音回放测试'})).instance.id:null;
  const prefix=id?'/instances/'+id:'';
  await installCharacterPackages(app.url+prefix,'companion-lite');
  const {character}=await api(prefix+'/api/characters',{name:'小璃'});
  await api(prefix+'/api/characters/select',{id:character.id});
  await api(prefix+`/api/characters/${character.id}/life/settings`,{mode:'lite',memory:{autoExtract:false},media:{voiceEnabled:true,voiceId:'xiaoli-warm-bright',voiceMode:'always'}});
  const result=await api(prefix+'/api/modules/companion-lite/chat',{text:'你好'});
  assert.equal(result.actions[0].url,prefix+audioPath);
  const context=id?app.context.instanceManager.runtimes.get(id).context:app.context;
  const saved=context.life.data.list(character.id,'lite-chat').find(item=>item.role==='assistant');
  assert.equal(saved.actions[0].url,prefix+audioPath,'资料中不保存临时端口');
  const oldOrigin=app.url;
  context.life.data.put(character.id,'lite-chat',{...saved,id:saved.id+':legacy',actions:[{type:'record',url:oldOrigin+prefix+audioPath}]});
  await app.close();
  const occupied=createServer();await new Promise(resolveListen=>occupied.listen(Number(new URL(oldOrigin).port),'127.0.0.1',resolveListen));
  t.after(()=>new Promise(resolveClose=>occupied.close(resolveClose)));
  app=await createWorkbench(options);assert.notEqual(app.url,oldOrigin);
  if(id)await api('/api/instances/'+id+'/start',{});
  const state=await api(prefix+'/api/modules/companion-lite/state');
  const replies=state.messages.filter(item=>item.role==='assistant');assert.equal(replies.length,2);
  assert.ok(replies.every(item=>item.actions[0].url===prefix+audioPath),'新相对路径和旧端口记录均回放到当前宿主');
});
