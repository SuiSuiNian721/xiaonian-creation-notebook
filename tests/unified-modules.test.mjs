import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {moduleDefinitions,moduleDefinition} from '../framework/registry.mjs';
import {createWorkbench} from '../framework/server.mjs';
import {workspaceModules,moduleVariants} from '../public-workbench/module-families.js';

async function fixture(t){
  const dataDir=await mkdtemp(join(tmpdir(),'workbench-unified-'));
  const app=await createWorkbench({dataDir});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});
    return {status:response.status,...await response.json()};
  };
  return {app,api,dataDir};
}

test('精简与完整标识继续兼容，模块目录各只提供一个统一入口',()=>{
  assert.equal(moduleDefinitions.filter(item=>!item.librarySection&&(!item.familyId||item.familyId===item.id)).length,9);
  assert.deepEqual(workspaceModules(moduleDefinitions).filter(item=>item.icon==='voice').map(item=>item.name),['声音']);
  assert.equal(moduleDefinition('voice-design').familyId,'voice');
  assert.deepEqual(moduleVariants(moduleDefinitions,'voice'),[]);
  assert.equal(moduleDefinition('character-full').name,'角色资料');
  assert.equal(moduleDefinition('companion').name,'虚拟陪伴');
  for(const [id,familyId,variant] of [['character-lite','character-full','lite'],['character-full','character-full','full'],['companion-lite','companion','lite'],['companion','companion','full']]){
    assert.equal(moduleDefinition(id).familyId,familyId);
    assert.equal(moduleDefinition(id).variant,variant);
  }
});

test('旧角色系统实例的人设、记忆和状态幂等收进角色资料，保留原实例',async t=>{
  const {app,api}=await fixture(t);
  const instance=(await api('/api/instances',{moduleId:'character-full',name:'旧角色资料'})).instance;
  await api('/api/instances/'+instance.id+'/persona',{source:'import',bundle:{name:'需要保留的角色'}});
  const context=app.context.instanceManager.context(instance.id),id=context.store.getSetting('selectedCharacterId');
  context.life.data.put(id,'memory',{id:'source-memory',scope:'shared',content:'原模块保存的记忆'});
  context.life.configure(id,{mode:'full',behavior:{replyMaxChars:456}});
  await api('/api/instances/'+instance.id+'/stop',{});
  const first=await api('/api/characters/collect-legacy',{});
  assert.equal(first.status,200);assert.equal(first.imported.length,1);
  const targetId=first.imported[0].characterId;
  assert.equal(app.context.store.character(targetId).name,'需要保留的角色');
  assert.equal(app.context.life.data.get(targetId,'memory','source-memory').content,'原模块保存的记忆');
  assert.equal(app.context.life.config(targetId).behavior.replyMaxChars,456);
  assert.equal((await api('/api/characters/collect-legacy',{})).imported.length,0);
  assert.equal(app.context.instanceManager.record(instance.id).moduleId,'character-full');
  const profile=await api('/api/characters/'+targetId+'/life');
  assert.equal(profile.capabilities.full,true);
});

test('同一陪伴实例切换模式保留角色、历史、记忆与 AI 覆盖，并与其他实例隔离',async t=>{
  const {app,api,dataDir}=await fixture(t);
  const a=(await api('/api/instances',{moduleId:'companion-lite',name:'原来的陪伴'})).instance;
  const b=(await api('/api/instances',{moduleId:'companion-lite',name:'另一位角色'})).instance;
  const imported=await api('/api/instances/'+a.id+'/persona',{source:'import',bundle:{name:'测试角色',description:'保留原有人设'}});
  assert.equal(imported.status,200);
  const old=app.context.instanceManager.context(a.id),character=old.store.character(old.store.getSetting('selectedCharacterId'));
  old.life.data.put(character.id,'lite-chat',{id:'old-chat',scope:'companion-lite:default',role:'assistant',content:'已有聊天'});
  old.life.data.put(character.id,'memory',{id:'old-memory',scope:'companion-lite:default',content:'已有记忆'});
  await api('/instances/'+a.id+'/api/ai/modules/companion-lite/config',{mode:'module',connection:{provider:'openai',baseUrl:'http://127.0.0.1:9999/v1',model:'original-model',keyMode:'custom',apiKey:'test-only-secret'}},'PUT');
  const beforeDirectory=app.context.instanceManager.directory(a.id);
  const switched=await api('/api/instances/'+a.id+'/variant',{variant:'full'});
  assert.equal(switched.status,200);
  assert.equal(switched.instance.id,a.id);
  assert.equal(switched.instance.moduleId,'companion');
  assert.equal(switched.instance.name,'原来的陪伴');
  await api('/api/instances/'+a.id+'/start',{});
  let current=app.context.instanceManager.context(a.id);
  assert.equal(current.store.getSetting('selectedCharacterId'),character.id);
  assert.equal(current.life.data.get(character.id,'lite-chat','old-chat').content,'已有聊天');
  assert.equal(current.life.data.get(character.id,'memory','old-memory').content,'已有记忆');
  assert.equal(current.store.getSetting('ai.module.companion').connection.apiKey,'test-only-secret');
  assert.equal((await api('/instances/'+a.id+'/api/ai/modules/companion/config')).effective.model,'original-model');
  await api('/instances/'+a.id+'/api/ai/modules/companion/config',{mode:'module',connection:{model:'changed-model'}},'PUT');
  const back=await api('/api/instances/'+a.id+'/variant',{variant:'lite'});
  assert.equal(back.status,200);await api('/api/instances/'+a.id+'/start',{});
  current=app.context.instanceManager.context(a.id);
  assert.equal(current.store.getSetting('ai.module.companion-lite').connection.model,'changed-model');
  assert.equal(current.life.data.get(character.id,'lite-chat','old-chat').content,'已有聊天');
  assert.equal(app.context.instanceManager.directory(a.id),beforeDirectory);
  assert.equal(beforeDirectory,join(dataDir,'instances',a.id));
  assert.equal(app.context.instanceManager.record(b.id).moduleId,'companion-lite');
  assert.equal(app.context.instanceManager.context(b.id).store.getSetting('selectedCharacterId'),null);
});

test('角色系统切换只更新当前实例的角色模式，保留高级设置',async t=>{
  const {app,api}=await fixture(t);
  const instance=(await api('/api/instances',{moduleId:'character-lite'})).instance;
  await api('/api/instances/'+instance.id+'/persona',{source:'import',bundle:{name:'模式检查角色'}});
  let context=app.context.instanceManager.context(instance.id),id=context.store.getSetting('selectedCharacterId');
  context.life.configure(id,{behavior:{replyMaxChars:777}});
  assert.equal((await api('/api/instances/'+instance.id+'/variant',{variant:'full'})).status,200);
  await api('/api/instances/'+instance.id+'/start',{});
  context=app.context.instanceManager.context(instance.id);
  assert.equal(context.life.config(id).mode,'full');
  assert.equal(context.life.config(id).behavior.replyMaxChars,777);
  assert.equal((await api('/api/instances/'+instance.id+'/variant',{variant:'lite'})).status,200);
  await api('/api/instances/'+instance.id+'/start',{});
  context=app.context.instanceManager.context(instance.id);
  assert.equal(context.life.config(id).mode,'lite');
  assert.equal(context.life.config(id).behavior.replyMaxChars,777);
});

test('无效模式、其他模块及当前实例未完成的任务不会被切换覆盖',async t=>{
  const {app,api}=await fixture(t);
  const instance=(await api('/api/instances',{moduleId:'companion-lite'})).instance;
  assert.equal((await api('/api/instances/'+instance.id+'/variant',{variant:'invalid'})).status,400);
  const voice=(await api('/api/instances',{moduleId:'voice'})).instance;
  assert.equal((await api('/api/instances/'+voice.id+'/variant',{variant:'full'})).status,400);
  const context=app.context.instanceManager.context(instance.id),pending=Promise.resolve();
  context.life.pending.add(pending);
  try{assert.equal((await api('/api/instances/'+instance.id+'/variant',{variant:'full'})).status,409);}
  finally{context.life.pending.delete(pending);}
  assert.equal(app.context.instanceManager.record(instance.id).moduleId,'companion-lite');
  assert.equal(app.context.instanceManager.record(instance.id).status,'running');
});

test('模块可以把文件存回角色资料，其他实例读取同一份持久素材',async t=>{
  const {app,api}=await fixture(t);
  const {character}=await api('/api/characters',{name:'素材共享角色'});
  const source=(await api('/api/instances',{moduleId:'drawing'})).instance;
  const consumer=(await api('/api/instances',{moduleId:'voice'})).instance;
  const bytes=Buffer.from(JSON.stringify({prompt:'角色工作流'}));
  const saved=await api('/instances/'+source.id+'/api/characters/'+character.id+'/resources',{name:'角色工作流.json',kind:'workflow',mime:'application/json',base64:bytes.toString('base64')});
  assert.equal(saved.status,201);assert.equal(saved.resource.sourceInstanceId,source.id);
  assert.equal(saved.resource.sourceModuleId,'drawing');
  const library=await api('/api/characters/'+character.id+'/resources');
  assert.equal(library.resources.length,1);assert.equal(library.resources[0].id,saved.resource.id);
  const linked=await api('/instances/'+consumer.id+'/api/characters/'+character.id+'/resources');
  const response=await fetch(app.url+linked.resources[0].url);
  assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await api('/api/instances/'+source.id+'/stop',{});
  assert.equal((await fetch(app.url+library.resources[0].url)).status,200);
  assert.equal(app.context.store.character(character.id).assets[0].kind,'workflow');
});

test('完整陪伴生成中的请求会阻止切换，原请求不会因此被取消',async t=>{
  const {app,api}=await fixture(t);
  const instance=(await api('/api/instances',{moduleId:'companion'})).instance,prefix='/instances/'+instance.id+'/api/modules/companion/resources';
  const plan=await api(prefix+'/plan',{optionalIds:[]});await api(prefix+'/install',{planId:plan.planId,optionalIds:[]});
  for(let count=0;count<100&&!(await api(prefix)).prerequisitesReady;count++)await new Promise(resolve=>setTimeout(resolve,10));
  const context=app.context.instanceManager.context(instance.id),companion=context.companion;
  companion.status='running';let release,aborted=false;
  const pending=companion.request(companion.token,signal=>new Promise(resolve=>{release=()=>resolve('completed');signal.addEventListener('abort',()=>{aborted=true;resolve('aborted');},{once:true});}));
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));
  try{
    assert.equal((await api('/api/instances/'+instance.id+'/variant',{variant:'lite'})).status,409);
    assert.equal(aborted,false);assert.equal(app.context.instanceManager.record(instance.id).moduleId,'companion');
  }finally{release();await pending;}
});

test('角色删除后可恢复资料与文件，其他模块的独立副本继续可用',async t=>{
  const {api}=await fixture(t);
  const {character}=await api('/api/characters',{name:'删除与恢复角色'}),instance=(await api('/api/instances',{moduleId:'voice'})).instance;
  const copy=await api('/api/instances/'+instance.id+'/persona',{source:'library',characterId:character.id});
  const resource=await api('/api/characters/'+character.id+'/resources',{name:'配置.json',kind:'workflow',base64:Buffer.from('{}').toString('base64')});
  const removed=await api('/api/characters/'+character.id,undefined,'DELETE');assert.equal(removed.status,200);assert.equal(removed.archived,true);
  assert.equal((await api('/api/state')).characters.some(item=>item.id===character.id),false);
  assert.equal((await api(resource.resource.url)).status,404);
  assert.equal((await api('/api/characters/deleted')).characters[0].id,character.id);
  assert.equal((await api('/instances/'+instance.id+'/api/state')).characters.some(item=>item.id===copy.character.id),true);
  const restored=await api('/api/characters/'+character.id+'/restore',{});assert.equal(restored.status,200);
  assert.equal((await api(resource.resource.url)).status,200);
  assert.equal((await api('/api/characters/deleted')).characters.length,0);
});
