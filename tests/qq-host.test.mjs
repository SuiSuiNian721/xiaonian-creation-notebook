import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbench } from '../framework/server.mjs';

async function fixture(t) {
  const dataDir=await mkdtemp(join(tmpdir(),'qq-host-'));let calls=0,stopped=0;
  const runtime={state:()=>({mode:'external',running:false,installation:{status:'missing'},login:{status:'logged_out'},external:{wsUrl:'',accountId:'',hasToken:false}}),
    connection:()=>{calls++;throw new Error('fixture must not connect');},configure:async()=>runtime.state(),stop:async()=>{stopped++;},close:async()=>{stopped++;}};
  const app=await createWorkbench({dataDir,qqOptions:{runtime},aiOptions:{codexRunner:async()=>{calls++;return{text:'forbidden'};}}});
  const api=async(path,value,method=value===undefined?'GET':'POST')=>{
    const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return{status:response.status,...await response.json()};
  };
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  return {api,app,get calls(){return calls;},get stopped(){return stopped;}};
}
test('工作台 QQ 接口要求模块启用，状态查询不会连接或生成',async t=>{
  const f=await fixture(t);assert.equal((await f.api('/api/modules/qq/state')).status,409);
  await f.api('/api/modules/qq/enable',{});const state=await f.api('/api/modules/qq/state');
  assert.equal(state.status,200);assert.equal(state.paused,true);assert.equal(f.calls,0);
  assert.equal((await f.api('/api/modules/qq/state',{})).status,405);
  assert.equal((await f.api('/api/modules/qq/conversations')).status,200);assert.equal(f.calls,0);
});
test('QQ 绑定固定角色快照，保存名单和顶部换角不连接网关',async t=>{
  const f=await fixture(t);await f.api('/api/modules/qq/enable',{});
  const first=(await f.api('/api/characters',{name:'星灯',description:'守望星灯',raw:{name:'星灯',description:'你是星灯'}})).character;
  const other=(await f.api('/api/characters',{name:'另一位'})).character;
  const bound=await f.api('/api/modules/qq/binding',{characterId:first.id},'PUT');assert.equal(bound.status,200);assert.equal(bound.binding.characterId,first.id);
  await f.api('/api/characters/select',{id:other.id});assert.equal((await f.api('/api/modules/qq/state')).binding.characterId,first.id);
  const rules=await f.api('/api/modules/qq/rules',{privateAllow:['123'],groupAllow:['456'],requireMention:true},'PUT');assert.equal(rules.status,200);
  assert.deepEqual(rules.rules.privateAllow,['123']);assert.equal(f.calls,0);
  await f.api('/api/modules/qq/disable',{});assert.ok(f.stopped>0);assert.equal((await f.api('/api/modules/qq/state')).status,409);
});
test('QQ 提供管理和只读会话接口，没有本机聊天发送入口',async t=>{
  const f=await fixture(t);await f.api('/api/modules/qq/enable',{});
  assert.equal((await f.api('/api/modules/qq/chat',{text:'不能发送'})).status,404);
  assert.equal((await f.api('/api/modules/qq/messages',{text:'不能发送'})).status,404);
  const list=await f.api('/api/modules/qq/conversations');assert.deepEqual(list.conversations,[]);assert.equal(f.calls,0);
});

test('QQ 固定组件通过宿主安装器形成可确认安装计划',async t=>{
  const f=await fixture(t);await f.api('/api/modules/qq/enable',{});
  const state=await f.api('/api/modules/qq/resources');assert.equal(state.resources[0].status,'available');
  const plan=await f.api('/api/modules/qq/resources/plan',{optionalIds:[]});assert.equal(plan.canInstall,true);assert.equal(plan.downloadBytes,124162399);assert.equal(f.calls,0);
});

test('断开连接保留登录端，明确停止接口才停止 QQ',async t=>{
  const f=await fixture(t);await f.api('/api/modules/qq/enable',{});
  assert.equal((await f.api('/api/modules/qq/disconnect',{})).status,200);assert.equal(f.stopped,0);
  assert.equal((await f.api('/api/modules/qq/stop',{})).status,200);assert.equal(f.stopped,1);
});
