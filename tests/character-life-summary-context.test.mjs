import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';

const originalSummary='明天上午十点有面试，需要准备自我介绍。';
const interview={content:'明天上午十点有面试',kind:'plan',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'interview',sourceQuote:'明天上午十点有面试',planStatus:'pending',expiresAt:'2026-11-09T02:00:00Z'};
async function fixture(t,mode='lite'){
  const path=await mkdtemp(join(tmpdir(),'summary-context-')),store=new WorkbenchStore(path),character=store.saveCharacter(newCharacter({name:'摘要角色'}));
  let now=Date.parse('2026-11-08T04:00:00Z'),calls=0;
  const life=new CharacterLife({store,dataDir:path,clock:()=>now,sharedAI:{complete:async()=>{calls++;return {text:JSON.stringify({memories:[interview],summary:originalSummary})};}}});
  life.configure(character.id,{mode});
  t.after(async()=>{await life.close();store.close();await rm(path,{recursive:true,force:true});});
  const args={character,moduleId:'qq',conversationId:'one',channel:'private',userId:'20001',peerId:'20001',userName:'念念'};
  const context=more=>life.context({...args,latestInput:'我们聊聊吧',history:[],...more});
  return {life,character,args,context,advance:ms=>{now+=ms;},calls:()=>calls};
}

for(const mode of ['lite','full'])test(`${mode}实际上下文为摘要标注原日期和当前时间，过期计划不能借旧摘要恢复为待办`,async t=>{
  const f=await fixture(t,mode);
  await f.life.observe({...f.args,input:'明天上午十点有面试',reply:'好',sourceId:'interview'});
  const future=await f.context();assert.match(future.prompt,/当前计划状态/);assert.match(future.prompt,/"planStatus":"pending"/);assert.match(future.prompt,/2026-11-09T02:00:00/);
  f.advance(172800000);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).plans[0].planStatus,'expired');
  assert.equal((await f.life.recall(f.character.id,{...f.args,text:'面试'})).memories.length,0);
  const past=await f.context(),sent=past.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  assert.match(sent,/2026-11-08T04:00:00.000Z/);assert.match(sent,/2026-11-10T04:00:00.000Z/);
  assert.match(sent,/相对日期.*原始消息日期/);assert.match(sent,/不能.*今天/);assert.match(sent,/"planStatus":"expired"/);assert.match(sent,/expired.*不.*当前待办/);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,originalSummary);assert.equal(f.calls(),1);
});

test('已完成、取消和归档计划有权威状态，摘要原文仍可查看且不追加模型请求',async t=>{
  for(const status of ['completed','cancelled','archived']){
    const f=await fixture(t);await f.life.observe({...f.args,input:interview.sourceQuote,reply:'好',sourceId:'one'});
    const memory=f.life.view(f.character.id).memories[0];
    f.life.saveMemory(f.character.id,{...memory,...(status==='archived'?{status:'archived'}:{planStatus:status})});
    const context=await f.context();assert.match(context.prompt,new RegExp('"planStatus":"'+status+'"'));
    assert.match(context.prompt,/completed.*expired.*cancelled.*archived.*不.*当前待办/);
    assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,originalSummary);assert.equal(f.calls(),1);
  }
});

test('手工摘要没有原消息日期时只标记录修正时间，不把未知的明天重定位成当前待办',async t=>{
  const f=await fixture(t);
  f.life.saveMemorySummary(f.character.id,{moduleId:'qq',conversationId:'one',content:'明天要交稿。'});f.advance(172800000);
  const context=await f.context();assert.match(context.prompt,/记录.*修正时间.*2026-11-08T04:00:00.000Z/);
  assert.match(context.prompt,/原始.*日期.*未知/);assert.match(context.prompt,/不能.*今天/);assert.match(context.prompt,/没有.*当前待办/);
  const summary=f.life.memoryOverview(f.character.id,f.args).summary;assert.equal(summary.content,'明天要交稿。');assert.equal(summary.manual,true);assert.equal(summary.sourceCreatedAt,undefined);assert.equal(f.calls(),0);
});

test('后续摘要沿用更早的明天时，覆盖截至日期不成为旧事件的新日期',async t=>{
  const f=await fixture(t);await f.life.observe({...f.args,input:interview.sourceQuote,reply:'好',sourceId:'one'});
  f.advance(172800000);await f.life.observe({...f.args,input:'接着聊聊',reply:'好',sourceId:'later'});
  const summary=f.life.memoryOverview(f.character.id,f.args).summary;assert.equal(summary.sourceCreatedAt,'2026-11-10T04:00:00.000Z');assert.equal(summary.content,originalSummary);
  const context=await f.context();assert.match(context.prompt,/摘要可能沿用了更早的原话/);assert.match(context.prompt,/不能按今天或摘要覆盖截至时间重新推算/);
  assert.match(context.prompt,/"sourceCreatedAt":"2026-11-08T04:00:00.000Z"/);assert.match(context.prompt,/"planStatus":"expired"/);assert.equal(f.calls(),2);
});

test('摘要计划状态保持对象群聊故事隔离，关闭开关也不注入',async t=>{
  const f=await fixture(t);await f.life.observe({...f.args,input:interview.sourceQuote,reply:'好',sourceId:'one'});
  for(const route of [{conversationId:'other',userId:'20002',peerId:'20002'},{conversationId:'group',channel:'group',peerId:'30001'}]){
    const context=await f.context(route);assert.doesNotMatch(context.prompt,/面试|当前计划状态/);
  }
  f.life.configure(f.character.id,{memory:{continuity:false}});assert.doesNotMatch((await f.context({conversationId:'fresh'})).prompt,/面试|当前计划状态/);
  const memory=f.life.view(f.character.id).memories[0];f.life.saveMemory(f.character.id,{...memory,reality:'story'});
  f.life.configure(f.character.id,{memory:{continuity:true}});assert.doesNotMatch((await f.context({conversationId:'fresh'})).prompt,/面试|当前计划状态/);
  for(const patch of [{enabled:false},{enabled:true,memory:{enabled:false}}]){f.life.configure(f.character.id,patch);assert.doesNotMatch((await f.context()).prompt,/面试|当前计划状态/);}
});

test('摘要计划状态的数量和字符量有界，长期历史不会全量注入',async t=>{
  const f=await fixture(t);f.life.saveMemorySummary(f.character.id,{moduleId:'qq',conversationId:'one',content:'历史摘要'});
  for(let index=0;index<30;index++)f.life.data.put(f.character.id,'memory',{...interview,id:'plan-'+index,scope:'qq:one',sourceScope:'qq:one',subjectKey:'qq:private:20001',layerVersion:1,status:'active',content:'长计划'.repeat(1000)+index,planStatus:'completed'});
  const context=await f.context(),states=context.prompt.split('当前计划状态')[1]??'';
  assert.ok(states.includes('completed'));assert.ok((states.match(/"planStatus":/g)??[]).length<=8);assert.ok(states.length<=4500);
});
