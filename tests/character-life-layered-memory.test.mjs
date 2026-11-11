import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';
import {QQController} from '../framework/qq.mjs';
import {LiteCompanion} from '../framework/companion-lite.mjs';
import {completeAiriChat} from '../framework/companion-ai.mjs';

async function fixture(t){
  const path=await mkdtemp(join(tmpdir(),'layered-memory-')),store=new WorkbenchStore(path);
  const character=store.saveCharacter(newCharacter({name:'记忆角色'})),other=store.saveCharacter(newCharacter({name:'另一实例'}));
  let now=Date.parse('2026-11-08T04:00:00Z'),response={},calls=[];
  const ai={complete:async messages=>{calls.push(messages);return {text:JSON.stringify(typeof response==='function'?await response(messages):response)};}};
  const life=new CharacterLife({store,dataDir:path,sharedAI:ai,clock:()=>now});
  t.after(async()=>{await life.close();store.close();await rm(path,{recursive:true,force:true});});
  const args={character,moduleId:'qq',channel:'private',peerId:'20001',userId:'20001',userName:'念念',conversationId:'one'};
  return {life,store,character,other,path,args,calls,answer:value=>{response=value;},advance:ms=>{now+=ms;}};
}
const trait=(content='对方喜欢红茶',quote='我喜欢红茶')=>({content,kind:'preference',category:'trait',reality:'real',confidence:'explicit',canonicalKey:'drink',sourceQuote:quote});

test('同一对象的现实偏好跨会话，新故事和其他联系人及群聊保持隔离',async t=>{
  const f=await fixture(t);f.answer({memories:[trait(),{content:'我们是王国里的师徒',category:'relationship',kind:'relationship',reality:'story',confidence:'explicit',sourceQuote:'故事里我们是师徒'}],summary:'谈到红茶与新故事。'});
  await f.life.observe({...f.args,input:'我喜欢红茶，故事里我们是师徒',reply:'记下了',sourceId:'s1'});
  const recalled=async more=>(await f.life.recall(f.character.id,{...f.args,...more,text:'红茶 师徒'})).memories;
  assert.deepEqual((await recalled({conversationId:'two'})).map(m=>m.content),['对方喜欢红茶']);
  assert.equal((await recalled({conversationId:'two',userId:'20002',peerId:'20002'})).length,0);
  assert.equal((await recalled({conversationId:'group',channel:'group',peerId:'30001'})).length,0);
  assert.equal((await f.life.recall(f.other.id,{...f.args,text:'红茶'})).memories.length,0);
  assert.equal((await recalled({})).length,2);
  assert.equal(f.life.memoryOverview(f.character.id,{...f.args,conversationId:'two'}).summary,null);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,'谈到红茶与新故事。');
  assert.equal(f.calls.length,1);
  f.life.configure(f.character.id,{memory:{sharing:'character'}});
  assert.equal((await recalled({conversationId:'two',userId:'20002',peerId:'20002'})).length,0);
});

test('没有词汇重合也将有效沟通特质带入新会话的实际提示，其他联系人不继承',async t=>{
  const f=await fixture(t);f.answer({memories:[{...trait('对方喜欢先听结论','请先给结论再展开解释'),canonicalKey:'communication'}]});
  await f.life.observe({...f.args,input:'请先给结论再展开解释',reply:'好',sourceId:'preference'});
  const context=await f.life.context({...f.args,conversationId:'fresh',latestInput:'帮我看看这段代码',history:[]});
  assert.match(context.messages[0].content,/对方喜欢先听结论/);
  const other=await f.life.context({...f.args,conversationId:'other',userId:'20002',peerId:'20002',latestInput:'帮我看看这段代码',history:[]});
  assert.doesNotMatch(other.messages[0].content,/对方喜欢先听结论/);
  for(let index=0;index<8;index++){
    f.answer({memories:[{content:'我们讨论过代码'+index,category:'experience',kind:'fact',reality:'real',confidence:'explicit',sourceQuote:'讨论代码'+index}]});
    await f.life.observe({...f.args,input:'讨论代码'+index,reply:'好',sourceId:'experience-'+index});
  }
  const crowded=await f.life.context({...f.args,conversationId:'newer',latestInput:'代码',history:[]});
  assert.match(crowded.prompt,/对方喜欢先听结论/);assert.ok(crowded.trace[0].ids.length<=8);
});

test('逐字来源与宿主身份优先；推测及缺元数据旧候选只在原会话使用',async t=>{
  const f=await fixture(t);f.answer({memories:[{...trait(),userId:'20002',subjectKey:'qq:private:20002'},trait('伪造来源','不存在的原话'),{content:'可能喜欢安静',kind:'preference',category:'trait',reality:'real',confidence:'inferred',sourceQuote:'今天有点累'},{content:'旧模型事实',kind:'fact',sourceQuote:'今天有点累'}]});
  await f.life.observe({...f.args,input:'我喜欢红茶，今天有点累',reply:'休息一下',sourceId:'s1'});
  const view=f.life.memoryOverview(f.character.id,f.args);
  assert.equal(view.traits.length,2);assert.equal(view.subjects.length,1);assert.equal(view.subjects[0].userId,'20001');
  assert.equal(view.traits.find(m=>m.content==='可能喜欢安静').reality,'uncertain');
  assert.equal((await f.life.recall(f.character.id,{...f.args,conversationId:'two',text:'安静 旧模型 红茶'})).memories.length,1);
});

test('同一事实合并证据，新明确偏好更新旧值；人工纠正归档删除优先',async t=>{
  const f=await fixture(t);f.answer({memories:[trait()]});
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s1'});
  f.advance(1000);await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s2'});
  let memory=f.life.view(f.character.id).memories[0];assert.equal(memory.evidence.length,2);assert.equal(f.life.view(f.character.id).memories.length,1);
  f.advance(1000);f.answer({memories:[trait('对方现在喜欢绿茶','我现在喜欢绿茶')]});
  await f.life.observe({...f.args,input:'我现在喜欢绿茶',reply:'好',sourceId:'s3'});
  memory=f.life.view(f.character.id).memories[0];assert.equal(memory.content,'对方现在喜欢绿茶');
  f.life.saveMemory(f.character.id,{...memory,content:'用户修正：只喝白水',status:'archived'});
  f.advance(1000);await f.life.observe({...f.args,input:'我现在喜欢绿茶',reply:'好',sourceId:'s4'});
  memory=f.life.view(f.character.id).memories[0];assert.equal(memory.content,'用户修正：只喝白水');assert.equal(memory.status,'archived');
  assert.equal(memory.subjectKey,'qq:private:20001');
  f.life.deleteMemory(f.character.id,memory.id);
  await f.life.observe({...f.args,input:'我现在喜欢绿茶',reply:'好',sourceId:'s5'});
  assert.equal(f.life.view(f.character.id).memories.length,0);
});

test('人工纠正错误的现实分类立即收回跨故事召回，旧回填不能再造real副本；身份来源只读',async t=>{
  const f=await fixture(t);f.answer({memories:[trait()]});await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s1'});
  const memory=f.life.view(f.character.id).memories[0];
  const corrected=f.life.saveMemory(f.character.id,{...memory,category:'experience',reality:'story',confidence:'inferred'});
  assert.equal(corrected.category,'experience');assert.equal(corrected.reality,'story');assert.equal(corrected.confidence,'inferred');
  assert.equal((await f.life.recall(f.character.id,{...f.args,conversationId:'new-story',text:'红茶'})).memories.length,0);
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s2'});assert.equal(f.life.view(f.character.id).memories.length,1);
  for(const [key,value] of [['subjectKey','qq:private:20002'],['sourceId','made-up'],['sourceScope','qq:another'],['evidence',[]]])assert.throws(()=>f.life.saveMemory(f.character.id,{...corrected,[key]:value}),/来源|身份|只读/);
  assert.throws(()=>f.life.saveMemory(f.character.id,{...corrected,reality:'invented'}),/分类/);
});

test('自动合并更新事实内容时旧语义向量失效，相同内容仍保留向量',async t=>{
  const f=await fixture(t);f.answer({memories:[trait()]});await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'one'});
  let memory=f.life.view(f.character.id).memories[0];f.life.data.put(f.character.id,'memory',{...memory,embedding:[1,0],embeddingKey:'old-model'});
  f.advance(1000);await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'two'});
  assert.deepEqual(f.life.data.get(f.character.id,'memory',memory.id).embedding,[1,0]);
  f.answer({memories:[trait('现在喜欢绿茶','我现在喜欢绿茶')]});f.advance(1000);
  await f.life.observe({...f.args,input:'我现在喜欢绿茶',reply:'好',sourceId:'three'});
  memory=f.life.data.get(f.character.id,'memory',memory.id);assert.equal(memory.content,'现在喜欢绿茶');assert.equal(memory.embedding,undefined);assert.equal(memory.embeddingKey,undefined);
});

test('带语义符号的不同事实保持独立，删除C++偏好不会阻断C#事实更新',async t=>{
  const f=await fixture(t),cpp={...trait('对方喜欢C++','我喜欢C++'),canonicalKey:'language-cpp'},csharp={...trait('对方喜欢C#','我喜欢C#'),canonicalKey:'language-csharp'};
  f.answer({memories:[cpp,csharp]});await f.life.observe({...f.args,input:'我喜欢C++，我喜欢C#',reply:'好',sourceId:'one'});
  const memories=f.life.view(f.character.id).memories;assert.equal(memories.length,2);
  f.life.deleteMemory(f.character.id,memories.find(m=>m.canonicalKey==='language-cpp').id);
  f.answer({memories:[csharp]});await f.life.observe({...f.args,input:'我喜欢C#',reply:'好',sourceId:'two'});
  const remaining=f.life.view(f.character.id).memories;assert.equal(remaining.length,1);assert.equal(remaining[0].canonicalKey,'language-csharp');assert.equal(remaining[0].evidence.length,2);
});

test('计划完成或过期不再作为待办注入，也不会变成人格特质',async t=>{
  const f=await fixture(t),plan={content:'明天一起复习',kind:'plan',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'study',sourceQuote:'明天一起复习',expiresAt:'2026-11-09T04:00:00Z',planStatus:'pending'};
  f.answer({memories:[plan]});await f.life.observe({...f.args,input:plan.sourceQuote,reply:'好',sourceId:'s1'});
  assert.equal((await f.life.recall(f.character.id,{...f.args,text:'复习'})).memories.length,1);
  f.advance(1000);f.answer({memories:[{...plan,content:'复习已经完成',sourceQuote:'复习已经完成',planStatus:'completed'}]});
  await f.life.observe({...f.args,input:'复习已经完成',reply:'辛苦了',sourceId:'s2'});
  assert.equal((await f.life.recall(f.character.id,{...f.args,text:'复习'})).memories.length,0);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).plans[0].planStatus,'completed');
  f.answer({memories:[{...plan,canonicalKey:'other'}]});await f.life.observe({...f.args,input:plan.sourceQuote,reply:'好',sourceId:'s3'});
  f.advance(172800000);assert.equal(f.life.memoryOverview(f.character.id,f.args).plans.find(p=>p.canonicalKey==='other').planStatus,'expired');
  assert.equal(f.life.memoryOverview(f.character.id,f.args).traits.length,0);
});

test('计划候选dueAt为事件时间，expiresAt为null时仍按带时区日期保存并自动过期',async t=>{
  const f=await fixture(t),plan={content:'明天上午十点面试',kind:'plan',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'interview',sourceQuote:'明天上午十点面试',dueAt:'2026-11-09T10:00:00+08:00',expiresAt:null,planStatus:'pending'};
  f.answer({memories:[plan],summary:'11月9日上午十点面试。'});
  await f.life.observe({...f.args,input:plan.sourceQuote,reply:'好',sourceId:'due',sourceCreatedAt:'2026-11-08T21:01:00+08:00'});
  const payload=JSON.parse(f.calls[0][1].content);assert.equal(payload.sources[0].createdAt,'2026-11-08T13:01:00.000Z');
  const memory=f.life.view(f.character.id).memories[0];assert.equal(memory.expiresAt,'2026-11-09T02:00:00.000Z');assert.equal(memory.dueAt,undefined);
  assert.match(f.calls[0][0].content,/dueAt/);
  f.advance(172800000);assert.equal(f.life.memoryOverview(f.character.id,f.args).plans[0].planStatus,'expired');assert.equal(f.calls.length,1);
});

test('同一计划仅更新完成状态且未重给日期时保留已知到期值，手工仍可明确清空',async t=>{
  const f=await fixture(t),plan={content:'明天一起复习',kind:'plan',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'study',sourceQuote:'明天一起复习',expiresAt:'2026-11-09T04:00:00Z',planStatus:'pending'};
  f.answer({memories:[plan]});await f.life.observe({...f.args,input:plan.sourceQuote,reply:'好',sourceId:'one'});
  f.answer({memories:[{...plan,content:'复习已经完成',sourceQuote:'复习已经完成',planStatus:'completed',dueAt:null,expiresAt:null}]});f.advance(1000);
  await f.life.observe({...f.args,input:'复习已经完成',reply:'好',sourceId:'two'});
  const memory=f.life.view(f.character.id).memories[0];assert.equal(memory.planStatus,'completed');assert.equal(memory.expiresAt,'2026-11-09T04:00:00.000Z');
  const existing=JSON.parse(f.calls[1][1].content).existingMemories.find(m=>m.canonicalKey==='study');assert.equal(existing.dueAt,'2026-11-09T04:00:00.000Z');
  assert.equal(f.life.saveMemory(f.character.id,{...memory,expiresAt:null}).expiresAt,null);assert.equal(f.calls.length,2);
});

test('历史整理同用dueAt契约且保留原始来源日期，无日期计划仍为null',async t=>{
  const f=await fixture(t),sources=[{...historySource(1,'明天上午十点面试'),createdAt:'2026-11-07T13:01:00.000Z'}];registerHistory(f,sources);
  f.answer({memories:[{content:'11月8日上午十点面试',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'interview',sourceId:'history-1',sourceQuote:'明天上午十点面试',dueAt:'2026-11-08T10:00:00+08:00',expiresAt:null}]});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();
  const payload=JSON.parse(f.calls[0][1].content);assert.equal(payload.sources[0].createdAt,'2026-11-07T13:01:00.000Z');
  let memory=f.life.view(f.character.id).memories[0];assert.equal(memory.expiresAt,'2026-11-08T02:00:00.000Z');assert.equal(memory.sourceCreatedAt,'2026-11-07T13:01:00.000Z');assert.equal(f.life.memoryOverview(f.character.id,f.args).plans[0].planStatus,'expired');
  assert.match(f.calls[0][0].content,/dueAt/);
  f.answer({memories:[{content:'有空一起画画',category:'plan',reality:'real',confidence:'explicit',canonicalKey:'undated',sourceQuote:'有空一起画画',dueAt:null,expiresAt:null}]});
  await f.life.observe({...f.args,input:'有空一起画画',reply:'好',sourceId:'undated'});memory=f.life.view(f.character.id).memories.find(m=>m.canonicalKey==='undated');assert.equal(memory.expiresAt,null);
});

test('自动提炼和本会话摘要共用一次观察请求，设置关闭及模拟不会落盘',async t=>{
  const f=await fixture(t);f.answer({memories:[trait()],summary:'新摘要'});
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s1'});
  assert.equal(f.calls.length,1);assert.match(f.calls[0][0].content,/summary/);
  const payload=JSON.parse(f.calls[0][1].content);assert.equal(payload.priorSummary,'');assert.ok(Array.isArray(payload.existingMemories));
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'sandbox',synthetic:true});assert.equal(f.calls.length,1);
  f.life.configure(f.character.id,{memory:{autoExtract:false}});
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'s2'});assert.equal(f.calls.length,1);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,'新摘要');
});

test('角色系统总开关关闭后本会话摘要停止进入实际提示',async t=>{
  const f=await fixture(t);f.answer({memories:[],summary:'用户的本会话摘要内容'});
  await f.life.observe({...f.args,input:'聊一聊',reply:'好',sourceId:'one'});f.life.configure(f.character.id,{enabled:false});
  const context=await f.life.context({...f.args,latestInput:'你好',history:[]});assert.doesNotMatch(context.prompt,/用户的本会话摘要内容/);
});

test('迟到旧摘要不能覆盖较新轮次或手工摘要',async t=>{
  const f=await fixture(t);let release;f.answer(()=>new Promise(resolve=>{release=resolve;}));
  assert.equal(typeof f.life.saveMemorySummary,'function');
  const old=f.life.observe({...f.args,input:'旧消息',reply:'好',sourceId:'old',sourceCreatedAt:'2026-11-08T03:00:00Z'});
  f.life.saveMemorySummary(f.character.id,{moduleId:'qq',conversationId:'one',content:'手工摘要'});
  release({summary:'旧的自动摘要'});await old;
  assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,'手工摘要');
});

function registerHistory(f,sources,{valid=()=>true,moduleId='qq'}={}){
  assert.equal(typeof f.life.registerMemoryHistory,'function');
  f.life.registerMemoryHistory(moduleId,{sessions:(id,route)=>id===f.character.id&&(!route.conversationId||route.conversationId==='one')?[{args:f.args,read:()=>sources,valid}]:[]});
}
const historySource=(sequence,input='我喜欢红茶')=>({sequence,sourceId:'history-'+sequence,input,reply:'好',createdAt:`2026-11-07T04:${String(sequence).padStart(2,'0')}:00Z`,args:{moduleId:'qq',conversationId:'one',channel:'private',peerId:'20001',userId:'20001',userName:'念念'},scope:'qq:one'});

test('正常使用自动分批整理已存历史，旧turn不阻止补整理也不重放full状态',async t=>{
  const f=await fixture(t),sources=Array.from({length:15},(_,i)=>historySource(i+1));registerHistory(f,sources);
  await f.life.observe({...f.args,input:'旧轮次已整理过',reply:'好',sourceId:'history-1'});f.calls.length=0;
  for(const record of f.life.data.list(f.character.id,'memory-covered'))f.life.data.delete(f.character.id,'memory-covered',record.id);
  f.life.configure(f.character.id,{mode:'full'});f.answer(messages=>{const input=JSON.parse(messages[1].content);assert.ok(input.sources.length<=12);return {memories:input.sources.map(s=>({...trait(),sourceId:s.sourceId})),summary:'历史摘要',state:{moodValue:99},diary:'不应重复写日记'};});
  await f.life.context({...f.args,latestInput:'你好',history:[]});await f.life.memoryOrganizer.idle();
  assert.equal(f.calls.length,2);assert.equal(f.life.view(f.character.id).memories[0].evidence.length,15);
  assert.equal(f.life.state(f.character.id).moodValue,50);assert.equal(f.life.view(f.character.id).diary.length,0);
  assert.equal(f.life.memoryOverview(f.character.id,f.args).jobStatus.cursor,15);
  await f.life.context({...f.args,history:[]});await f.life.memoryOrganizer.idle();assert.equal(f.calls.length,2);
});

test('超长用户来源按片段续整理，不静默丢掉尾部且每批保持字符上限',async t=>{
  const f=await fixture(t),source=historySource(1,'旧内容'.repeat(6000)+'我喜欢红茶');registerHistory(f,[source]);
  f.answer(messages=>{const payload=JSON.parse(messages[1].content);assert.ok(payload.sources.reduce((size,s)=>size+s.input.length+s.reply.length,0)<=18000);return {memories:payload.sources[0].input.includes('我喜欢红茶')?[{...trait(),sourceId:'history-1'}]:[],summary:'连续历史'};});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();
  assert.equal(f.calls.length,2);assert.equal(f.life.view(f.character.id).memories.length,1);assert.equal(f.life.memoryOverview(f.character.id,f.args).jobStatus.cursor,1);
});

test('短来源、长来源、后续短来源有限批次完成，长源偏移不作用于前置短源',async t=>{
  const f=await fixture(t),sources=[historySource(1,'短消息'),historySource(2,'长'.repeat(16000)+'我喜欢红茶'),historySource(3,'后续短消息')];registerHistory(f,sources);
  f.answer(messages=>{const payload=JSON.parse(messages[1].content);return {memories:payload.sources.filter(s=>s.input.includes('我喜欢红茶')).map(s=>({...trait(),sourceId:s.sourceId})),summary:'已处理本批'};});
  const deadline=setTimeout(()=>f.life.cancelMemoryHistory({id:f.character.id,moduleId:'qq'}),2000);
  try{f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();}finally{clearTimeout(deadline);}
  const status=f.life.memoryOverview(f.character.id,f.args).jobStatus;
  assert.equal(status.cursor,3);assert.equal(status.processed,3);assert.equal(status.status,'idle');assert.equal(f.calls.length,4);
  assert.equal(f.life.view(f.character.id).memories[0].sourceQuote,'我喜欢红茶');
});

test('错误信封和已知字段错型不会cover或推进历史，合法空提炼可完成且无效单条候选不影响其他条目',async t=>{
  const f=await fixture(t),sources=[historySource(1)];registerHistory(f,sources);
  for(const response of [{error:'unable to process supplied material'},{error:'upstream failed',memories:[]},{state:{moodValue:55}},{memories:{}},{memories:[],summary:[]}]){
    f.answer(response);f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq',retry:true});await f.life.memoryOrganizer.idle();
    const status=f.life.memoryOverview(f.character.id,f.args).jobStatus;assert.equal(status.cursor,0);assert.equal(status.status,'failed');assert.equal(f.life.data.list(f.character.id,'memory-covered').length,0);
  }
  f.answer({memories:[]});f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq',retry:true});await f.life.memoryOrganizer.idle();
  assert.equal(f.life.memoryOverview(f.character.id,f.args).jobStatus.cursor,1);
  sources.push(historySource(2));f.answer({memories:[null,'bad',{...trait(),sourceId:'history-2'}]});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();assert.equal(f.life.view(f.character.id).memories.length,1);
});

test('重新打开自动提炼或角色总开关立即排队活动宿主历史，不等待新聊天或手动重试',async t=>{
  for(const disabled of [{memory:{autoExtract:false}},{memory:{enabled:false}},{enabled:false}]){
    const f=await fixture(t);f.life.configure(f.character.id,disabled);registerHistory(f,[historySource(1)]);
    f.answer({memories:[{...trait(),sourceId:'history-1'}],summary:'补整理完成'});
    f.life.configure(f.character.id,{enabled:true,memory:{enabled:true,autoExtract:true}});await f.life.memoryOrganizer.idle();
    assert.equal(f.calls.length,1);assert.equal(f.life.view(f.character.id).memories.length,1);assert.equal(f.life.memoryOverview(f.character.id,f.args).jobStatus.cursor,1);
  }
});

test('历史AI忽略取消时停用再启用仍会串行续排新配置，旧结果迟到不写入',async t=>{
  const f=await fixture(t);registerHistory(f,[historySource(1)]);let release,attempt=0;
  f.answer(()=>++attempt===1?new Promise(resolve=>{release=resolve;}):{memories:[{...trait(),sourceId:'history-1'}],summary:'新配置整理'});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});
  while(!release)await new Promise(resolve=>setTimeout(resolve,5));
  f.life.configure(f.character.id,{memory:{autoExtract:false}});f.life.configure(f.character.id,{memory:{autoExtract:true}});
  assert.equal(f.calls.length,1);
  release({memories:[{...trait('旧配置的结果'),sourceId:'history-1'}],summary:'旧配置摘要'});await f.life.memoryOrganizer.idle();
  assert.equal(f.calls.length,2);assert.equal(f.life.view(f.character.id).memories[0].content,'对方喜欢红茶');
  const overview=f.life.memoryOverview(f.character.id,f.args);assert.equal(overview.summary.content,'新配置整理');assert.equal(overview.jobStatus.status,'idle');assert.equal(overview.jobStatus.cursor,1);
});

test('增量错误信封不标为已提炼，full仅状态的旧信封仍可工作',async t=>{
  const f=await fixture(t);f.answer({error:'unable to process supplied material'});
  await f.life.observe({...f.args,input:'我喜欢红茶',reply:'好',sourceId:'wrong'});assert.equal(f.life.data.list(f.character.id,'memory-covered').length,0);
  f.life.configure(f.character.id,{mode:'full'});f.answer({state:{moodValue:55}});
  await f.life.observe({...f.args,input:'你好',reply:'好',sourceId:'valid'});assert.equal(f.life.state(f.character.id).moodValue,55);assert.equal(f.life.data.list(f.character.id,'memory-covered').length,1);
});

test('历史失败不推进成功水位或即时重试，重启后从已成功游标续接',async t=>{
  const f=await fixture(t),sources=Array.from({length:15},(_,i)=>historySource(i+1));registerHistory(f,sources);
  f.answer(messages=>{const input=JSON.parse(messages[1].content);if(input.sources[0].sourceId==='history-13')throw new Error('quota');return {summary:'前十二条'};});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();
  let status=f.life.memoryOverview(f.character.id,f.args).jobStatus;assert.equal(status.status,'failed');assert.equal(status.cursor,12);assert.equal(f.calls.length,2);
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();assert.equal(f.calls.length,2);
  await f.life.close();
  const reopened=new CharacterLife({store:f.store,dataDir:f.path,sharedAI:{complete:async messages=>{f.calls.push(messages);assert.equal(JSON.parse(messages[1].content).sources[0].sourceId,'history-13');return {text:'{"summary":"恢复完成"}'};}}});
  try{
    registerHistory({...f,life:reopened},sources);
    reopened.organizeMemoryHistory(f.character.id,{moduleId:'qq',retry:true});await reopened.memoryOrganizer.idle();
    status=reopened.memoryOverview(f.character.id,f.args).jobStatus;assert.equal(status.cursor,15);assert.equal(status.status,'idle');
  }finally{await reopened.close();}
});

test('关闭自动提炼和换绑定会撤销运行中的历史候选并清空pending',async t=>{
  for(const change of ['off','binding']){
    const f=await fixture(t);let release,valid=true;registerHistory(f,[historySource(1)],{valid:()=>valid});
    f.answer(()=>new Promise(resolve=>{release=resolve;}));f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});
    while(!release)await new Promise(resolve=>setTimeout(resolve,5));
    if(change==='off')f.life.configure(f.character.id,{memory:{autoExtract:false}});else valid=false;
    release({memories:[{...trait(),sourceId:'history-1'}],summary:'不应写入'});await f.life.memoryOrganizer.idle();
    assert.equal(f.life.view(f.character.id).memories.length,0);assert.equal(f.life.memoryOverview(f.character.id,f.args).summary,null);assert.equal(f.life.pending.size,0);
    assert.equal(f.life.memoryOverview(f.character.id,f.args).jobStatus.cursor,0);
  }
});

test('较旧历史不覆盖新偏好，批次伪造sourceId或混用发言者不能制造来源',async t=>{
  const f=await fixture(t);f.answer({memories:[trait('对方现在喜欢绿茶','我现在喜欢绿茶')],summary:'最新会话'});
  await f.life.observe({...f.args,input:'我现在喜欢绿茶',reply:'好',sourceId:'new'});
  registerHistory(f,[historySource(1),{...historySource(2,'我喜欢咖啡'),args:{...f.args,userId:'20002',peerId:'20002'}}]);
  f.answer({memories:[{...trait(),sourceId:'history-1'},{...trait('错误源','我喜欢咖啡'),sourceId:'history-1'},{...trait('不存在源'),sourceId:'invented'},{...trait('另一位喜欢咖啡','我喜欢咖啡'),sourceId:'history-2'}],summary:'过期摘要'});
  f.life.organizeMemoryHistory(f.character.id,{moduleId:'qq'});await f.life.memoryOrganizer.idle();
  const entries=f.life.view(f.character.id).memories;assert.equal(entries.length,2);assert.equal(entries.find(m=>m.subjectKey==='qq:private:20001').content,'对方现在喜欢绿茶');
  assert.equal(entries.find(m=>m.subjectKey==='qq:private:20002').content,'另一位喜欢咖啡');assert.equal(f.life.memoryOverview(f.character.id,f.args).summary.content,'最新会话');
});

test('QQ恢复回复自动读取宿主已确认历史，失败未知和沙盒不整理且不发送消息',async t=>{
  const f=await fixture(t),qq=new QQController({store:f.store,dataDir:f.path,sharedAI:{config:()=>({enabled:true})},life:f.life});
  try{
    qq.bind({characterId:f.character.id});qq.transport.state=()=>({status:'verified'});let sends=0;qq.transport.send=()=>{sends++;};
    const normal=qq.data.ensureConversation({selfId:'10001',bindingId:qq.binding.id,channel:'private',peerId:'20001'});
    for(const [index,status] of ['confirmed','failed','unknown'].entries()){
      const turn=qq.data.claimInbound(normal.id,{dedupId:'d'+index,sourceMessageId:String(index),userId:'20001',userName:'念念',text:'我喜欢红茶'});
      qq.data.updateMessage(turn.reply.id,{content:'好',status});
    }
    const sandbox=qq.data.ensureConversation({selfId:'10001',bindingId:qq.binding.id,channel:'private',peerId:'20001',sandbox:true});
    const simulated=qq.data.claimInbound(sandbox.id,{dedupId:'sim',sourceMessageId:'sim',userId:'20001',text:'我喜欢咖啡'});qq.data.updateMessage(simulated.reply.id,{content:'好',status:'simulated'});
    f.answer(messages=>{const payload=JSON.parse(messages[1].content);assert.equal(payload.sources.length,1);return {memories:[{...trait(),sourceId:payload.sources[0].sourceId}],summary:'本机已确认历史'};});
    qq.start();await f.life.memoryOrganizer.idle();
    assert.equal(f.calls.length,1);assert.equal(sends,0);assert.equal(f.life.view(f.character.id).memories.length,1);
    assert.equal(f.life.memoryOverview(f.character.id,{moduleId:'qq',conversationId:normal.id}).summary.content,'本机已确认历史');
    f.answer({memories:[trait('另一联系人喜欢红茶')]});await f.life.observe({...f.args,conversationId:'someone-else',userId:'20002',input:'我喜欢红茶',reply:'好',sourceId:'other'});
    const fresh=qq.newStory(normal.id).conversation,overview=f.life.memoryOverview(f.character.id,{moduleId:'qq',conversationId:fresh.id});
    assert.equal(overview.selectedSubject.userId,'20001');assert.equal(overview.traits.length,1);assert.equal(overview.summary,null);
  }finally{await qq.close();}
});

test('精简陪伴正常聊天自动补整理本机旧聊天，本机owner不随昵称改变',async t=>{
  const f=await fixture(t),scope='companion-lite:old';
  f.store.setSetting('selectedCharacterId',f.character.id);
  f.life.data.put(f.character.id,'lite-chat',{id:'old',scope,role:'user',content:'我喜欢红茶'});
  f.life.data.put(f.character.id,'lite-chat',{id:'old:reply',scope,role:'assistant',content:'好'});
  const lite=new LiteCompanion({store:f.store,life:f.life,sharedAI:{complete:async()=>({text:'你好'})},packages:{require(){},ready:()=>true,policy:()=>({forcedMode:'lite',prompt:'陪伴'})},userProfile:()=>({displayName:'换了昵称'})});
  try{
    f.answer(messages=>{const payload=JSON.parse(messages[1].content),source=payload.sources.find(s=>s.input==='我喜欢红茶');return {memories:source?[{...trait(),sourceId:source.sourceId}]:[],summary:'当前会话'};});
    await lite.chat({text:'你好',conversationId:'new'});await f.life.memoryOrganizer.idle();
    const entries=f.life.view(f.character.id).memories;assert.equal(entries.length,1);assert.equal(entries[0].subjectKey,'local:owner');
    assert.equal((await f.life.recall(f.character.id,{moduleId:'companion-lite',conversationId:'another',userName:'新名字',text:'红茶'})).memories.length,1);
    assert.equal(f.life.memoryOverview(f.character.id,{moduleId:'companion-lite',conversationId:'old'}).jobStatus.status,'idle');
  }finally{lite.close();}
});

test('并行陪伴会话的已保存但观察中来源不会被历史整理重复调用，结算后再推进水位',async t=>{
  const f=await fixture(t);f.store.setSetting('selectedCharacterId',f.character.id);let release;
  const lite=new LiteCompanion({store:f.store,life:f.life,sharedAI:{complete:async()=>({text:'好'})},packages:{require(){},ready:()=>true,policy:()=>({forcedMode:'lite',prompt:'陪伴'})}});
  try{
    f.answer(messages=>{
      const payload=JSON.parse(messages[1].content);
      if(payload.input==='我喜欢红茶')return new Promise(resolve=>{release=resolve;});
      return {memories:[],summary:'第二会话'};
    });
    const first=lite.chat({text:'我喜欢红茶',conversationId:'first'});
    while(!release)await new Promise(resolve=>setTimeout(resolve,5));
    await lite.chat({text:'你好',conversationId:'second'});await new Promise(resolve=>setTimeout(resolve,20));
    const before=f.life.memoryOverview(f.character.id,{moduleId:'companion-lite',conversationId:'first'}).jobStatus;
    assert.equal(f.calls.length,2);assert.equal(before.cursor,0);
    release({memories:[trait()],summary:'第一会话'});await first;await f.life.memoryOrganizer.idle();
    assert.equal(f.calls.length,2);assert.equal(f.life.memoryOverview(f.character.id,{moduleId:'companion-lite',conversationId:'first'}).jobStatus.cursor,1);
  }finally{release?.({memories:[]});lite.close();}
});

test('等待中的增量观察失败后历史队列可以接手，失败前不跳过游标也不无限重试',async t=>{
  const f=await fixture(t);f.store.setSetting('selectedCharacterId',f.character.id);let rejectObservation;
  const lite=new LiteCompanion({store:f.store,life:f.life,sharedAI:{complete:async()=>({text:'好'})},packages:{require(){},ready:()=>true,policy:()=>({forcedMode:'lite',prompt:'陪伴'})}});
  try{
    f.answer(messages=>{
      const payload=JSON.parse(messages[1].content);
      if(payload.input==='我喜欢红茶')return new Promise((_resolve,reject)=>{rejectObservation=reject;});
      const source=payload.sources.find(s=>s.input==='我喜欢红茶');return {memories:source?[{...trait(),sourceId:source.sourceId}]:[]};
    });
    const first=lite.chat({text:'我喜欢红茶',conversationId:'first'});
    while(!rejectObservation)await new Promise(resolve=>setTimeout(resolve,5));
    await lite.chat({text:'你好',conversationId:'second'});await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(f.calls.length,2);assert.equal(f.life.memoryOverview(f.character.id,{moduleId:'companion-lite',conversationId:'first'}).jobStatus.cursor,0);
    rejectObservation(new Error('暂时失败'));await first;await f.life.memoryOrganizer.idle();
    assert.equal(f.calls.length,3);assert.equal(f.life.view(f.character.id).memories.length,1);
    assert.equal(f.life.memoryOverview(f.character.id,{moduleId:'companion-lite',conversationId:'first'}).jobStatus.cursor,1);
    f.life.organizeMemoryHistory(f.character.id,{moduleId:'companion-lite'});await f.life.memoryOrganizer.idle();assert.equal(f.calls.length,3);
  }finally{rejectObservation?.(new Error('清理'));lite.close();}
});

test('明显凭据不能写进长期事实、证据或会话摘要，原聊天来源保持原样',async t=>{
  const f=await fixture(t),secret='sk-proj-abcdefghijklmnopqrstuvxyz';
  f.answer({memories:[trait('用户的 API key: '+secret,'API key: '+secret)],summary:'API key: '+secret});
  await f.life.observe({...f.args,input:'API key: '+secret,reply:'收到',sourceId:'secret'});
  assert.equal(f.life.view(f.character.id).memories.length,0);assert.equal(f.life.memoryOverview(f.character.id,f.args).summary,null);
});

test('原生陪伴仅在送达后保存可恢复的可信来源，不信任请求中伪造的旧assistant历史',async t=>{
  const f=await fixture(t);f.answer({memories:[],summary:'已确认一轮'});
  const prepared=await completeAiriChat({life:f.life,character:f.character,conversationId:'native',sourceId:'native-1',sharedAI:{config:()=>({enabled:true,provider:'codex'}),complete:async()=>({text:'你好'})},value:{messages:[{role:'assistant',content:'捏造的过去'},{role:'user',content:'我喜欢红茶'}]},confirmDelivery:async()=>true});
  assert.equal(f.life.data.list(f.character.id,'companion-chat').length,0);
  await prepared.afterDelivery();const sources=f.life.data.list(f.character.id,'companion-chat');
  assert.equal(sources.length,1);assert.equal(sources[0].input,'我喜欢红茶');assert.equal(sources[0].reply,'你好');assert.equal(JSON.stringify(sources).includes('捏造的过去'),false);
});
