import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore } from '../framework/store.mjs';
import { newCharacter } from '../framework/contracts.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';

async function fixture(t, options = {}) {
  const path = await mkdtemp(join(tmpdir(), 'character-life-'));
  const store = new WorkbenchStore(path);
  const character = store.saveCharacter(newCharacter({name:'测试角色',raw:{name:'测试角色',personality:'说话简短',character_book:{entries:[{keys:['花园'],content:'花园里有一棵杏树'}]}}}));
  const other = store.saveCharacter(newCharacter({name:'另一个角色'}));
  let now = Date.parse('2026-11-07T04:00:00Z');
  const sharedAI = {complete:async()=>({text:JSON.stringify({memories:[],expressions:[],state:{mood:'轻松'},diary:'今天聊了花园。'})}),config:()=>({enabled:true}),...options.sharedAI};
  const life = new CharacterLife({store,dataDir:path,sharedAI,clock:()=>now,...options});
  life.configure(character.id,{mode:'full'});life.configure(other.id,{mode:'full'});
  t.after(async()=>{await life.close();store.close();await rm(path,{recursive:true,force:true});});
  return {life,store,character,other,path,advance:ms=>{now+=ms;}};
}

const moodRule={id:'comfort',name:'被安慰后心情好一点',enabled:true,path:'moodValue',type:'number',initial:50,min:0,max:100,maxDelta:5,trigger:'semantic',environment:'private',conditionPath:'moodValue',operator:'gte',threshold:0,event:'对方明确安慰角色',operation:'add',value:3};

test('主回复生成期间修改共享或会话状态，迟到轮次不能再更新规则变量',async t=>{
  const {life,character}=await fixture(t);
  life.configure(character.id,{variableUpdates:{rules:[{...moodRule,path:'variables.trust',trigger:'condition',initial:10}]}});
  const args={character,moduleId:'qq',conversationId:'one',input:'你好',reply:'你好'};
  for(const shared of [false,true]){
    life.saveState(character.id,{scope:'qq:one',state:{variables:{trust:10}}});
    const context=await life.context({...args,history:[]}),output=await life.processOutput({...args,context,text:'你好'});
    life.saveState(character.id,{scope:shared?'shared':'qq:one',state:shared?{moodValue:12}:{variables:{trust:80}}});
    await life.observe({...args,turnId:output.turnId,sourceId:String(shared)});
    assert.equal(life.state(character.id,'qq:one').variables.trust,shared?10:80);
  }
  assert.equal(life.view(character.id).variableChanges.length,0);
});

test('变量规则复用整理请求，覆盖泛化心情估计并记录证据；重复和精简模式不执行',async t=>{
  let calls=0;
  const {life,character}=await fixture(t,{sharedAI:{complete:async messages=>{calls++;assert.match(messages[0].content,/variableEvents/);return {text:JSON.stringify({state:{moodValue:90},variableEvents:[{ruleId:'comfort',sourceQuote:'我会陪着你',reason:'对方明确承诺陪伴'}]})};}}});
  life.configure(character.id,{variableUpdates:{rules:[moodRule]}});
  const args={character,moduleId:'qq',conversationId:'one',input:'别难过，我会陪着你',reply:'谢谢你',sourceId:'turn1'};
  await life.observe(args);
  assert.equal(life.state(character.id).moodValue,53);
  assert.equal(life.view(character.id).variableChanges[0].sourceQuote,'我会陪着你');
  assert.equal(calls,1);
  await life.observe(args);assert.equal(calls,1);assert.equal(life.state(character.id).moodValue,53);
  life.configure(character.id,{mode:'lite',memory:{autoExtract:false}});
  await life.observe({...args,sourceId:'turn2'});assert.equal(calls,1);assert.equal(life.state(character.id).moodValue,53);
});

test('变量规则未命中不接受模型直接改值，整理期间的手动修改优先',async t=>{
  let release;
  const {life,character}=await fixture(t,{sharedAI:{complete:async()=>new Promise(resolve=>{release=resolve;})}});
  life.configure(character.id,{variableUpdates:{rules:[moodRule]}});
  const args={character,moduleId:'qq',conversationId:'one',input:'我会陪着你',reply:'嗯'};
  const first=life.observe({...args,sourceId:'first'});
  release({text:'{"state":{"moodValue":60}}'});await first;assert.equal(life.state(character.id).moodValue,50);
  const second=life.observe({...args,sourceId:'second'});
  life.saveState(character.id,{state:{moodValue:12}});
  release({text:JSON.stringify({variableEvents:[{ruleId:'comfort',sourceQuote:'我会陪着你',reason:'陪伴'}]})});await second;
  assert.equal(life.state(character.id).moodValue,12);assert.equal(life.view(character.id).variableChanges.length,0);
});

test('自定义初值进入提示词，变量规则只在确认对话后落库且关闭设置会丢弃旧候选',async t=>{
  let release;
  const {life,character}=await fixture(t,{sharedAI:{complete:async()=>new Promise(resolve=>{release=resolve;})}});
  const rule={...moodRule,id:'trust',path:'variables.trust',initial:10,trigger:'condition',value:2};
  life.configure(character.id,{variableUpdates:{rules:[rule]}});
  const context=await life.preview(character.id,{text:'你好'});
  assert.match(context.prompt,/"trust":10/);assert.equal(life.state(character.id).variables.trust,undefined);
  const args={character,moduleId:'qq',conversationId:'one',input:'你好',reply:'你好',sourceId:'first'};
  const first=life.observe(args);release({text:'{}'});await first;
  assert.equal(life.state(character.id,'qq:one').variables.trust,12);
  const second=life.observe({...args,sourceId:'second'});
  life.configure(character.id,{variableUpdates:{enabled:false}});release({text:'{}'});
  assert.equal((await second).stale,true);assert.equal(life.state(character.id,'qq:one').variables.trust,12);
});

test('记忆按角色和会话隔离；共享是显式配置；归档和删除立即影响召回',async t=>{
  const {life,character,other}=await fixture(t);
  const m=life.saveMemory(character.id,{scope:'qq:private-1',content:'念念喜欢杏花',kind:'preference',sourceQuote:'我喜欢杏花',pinned:true});
  const recall=(id,conversationId)=>life.recall(id,{moduleId:'qq',conversationId,text:'喜欢什么花'});
  assert.equal((await recall(character.id,'private-1')).memories.length,1);
  assert.equal((await recall(character.id,'private-2')).memories.length,0);
  assert.equal((await recall(other.id,'private-1')).memories.length,0);
  life.configure(character.id,{memory:{sharing:'character'}});
  assert.equal((await recall(character.id,'private-2')).memories.length,1);
  life.saveMemory(character.id,{...m,status:'archived'});
  assert.equal((await recall(character.id,'private-2')).memories.length,0);
  life.deleteMemory(character.id,m.id);
  assert.equal(life.view(character.id).memories.length,0);
});

test('情绪与变量持久化，更新校验版本，不接受原型污染',async t=>{
  const {life,character}=await fixture(t);
  const initial=life.view(character.id).state;
  const changed=life.saveState(character.id,{scope:'shared',revision:initial.revision,state:{mood:'期待',variables:{好感:12}}});
  assert.equal(life.view(character.id).state.mood,'期待');
  assert.equal(changed.variables.好感,12);
  assert.throws(()=>life.saveState(character.id,{revision:initial.revision,state:{mood:'错误'}}),/已经改变/);
  assert.throws(()=>life.saveState(character.id,{state:{variables:JSON.parse('{"__proto__":{"x":1}}')}}),/字段/);
  assert.equal({}.x,undefined);
});

test('人设、世界书、记忆与状态进入同一实际提示词；预览不增加记忆访问次数',async t=>{
  const {life,character}=await fixture(t);
  life.saveMemory(character.id,{content:'曾约好一起去花园',kind:'plan',pinned:true});
  life.saveState(character.id,{state:{activity:'修剪杏树'}});
  const context=await life.context({character,moduleId:'companion',conversationId:'one',latestInput:'去花园吧',history:[{role:'user',content:'去花园吧'}]});
  const content=JSON.stringify(context.messages);
  assert.match(content,/说话简短/);assert.match(content,/杏树/);assert.match(content,/曾约好/);assert.match(content,/修剪/);
  const before=life.view(character.id).memories[0].accessCount;
  await life.preview(character.id,{text:'花园',conversationId:'one'});
  assert.equal(life.view(character.id).memories[0].accessCount,before);
});

test('对话后整理可去重；合成唤醒与已取消请求不能制造经历',async t=>{
  const {life,character}=await fixture(t);
  const turn={character,moduleId:'qq',conversationId:'one',input:'花园开花了',reply:'一起去看吧',sourceId:'message-1'};
  await life.observe(turn);await life.observe(turn);
  assert.equal(life.view(character.id).diary.length,1);
  await life.observe({...turn,sourceId:'wake-1',synthetic:true});
  assert.equal(life.view(character.id).diary.length,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(life.observe({...turn,sourceId:'cancel',signal:controller.signal}),/取消/);
  assert.equal(life.view(character.id).diary.length,1);
});

test('学习记忆需要可核对的原话；状态修正保留用户编辑',async t=>{
  const {life,character}=await fixture(t,{sharedAI:{complete:async()=>({text:JSON.stringify({memories:[{content:'喜欢杏花',kind:'preference',sourceQuote:'我喜欢杏花'},{content:'住在北京',kind:'fact',sourceQuote:'我住北京'}],expressions:[{content:'好耶',sourceQuote:'好耶'}],state:{mood:'开心'},diary:'聊到了杏花。'})})}});
  await life.observe({character,moduleId:'qq',conversationId:'one',input:'好耶，我喜欢杏花',reply:'记住啦',sourceId:'1'});
  const view=life.view(character.id);
  assert.equal(view.memories.length,1);assert.equal(view.memories[0].sourceQuote,'我喜欢杏花');
  assert.equal(view.expressions[0].content,'好耶');assert.equal(view.state.mood,'开心');
});

test('主动调度遵守安静时间、配额和结果未知不重发',async t=>{
  const {life,character,advance}=await fixture(t,{sharedAI:{complete:async()=>({text:'花园里的杏花开了，想来看看吗？'})}});
  life.configure(character.id,{behavior:{proactiveEnabled:true,proactiveIntervalMinutes:1,dailyLimit:1,quietStart:'22:00',quietEnd:'08:00'}});
  await life.observe({character,moduleId:'qq',conversationId:'one',userId:'123',input:'晚点再聊',reply:'好',sourceId:'1',synthetic:true});
  let calls=0;
  advance(120000);
  await life.tick({deliver:async()=>{calls++;return {delivered:false,status:'unknown'};}});
  await life.tick({deliver:async()=>{calls++;return {delivered:true,status:'confirmed'};}});
  assert.equal(calls,1);
  assert.equal(life.view(character.id).actions[0].status,'unknown');
});

test('配置校验与密钥展示分离；保存遮蔽密钥不会破坏原配置',async t=>{
  const {life,character}=await fixture(t);
  assert.throws(()=>life.configure(character.id,{behavior:{dailyLimit:-1}}),/额度/);
  assert.throws(()=>life.configure(character.id,{memory:{sharing:'everyone'}}),/共享/);
  life.configure(character.id,{memory:{embedding:{baseUrl:'http://127.0.0.1:9/v1',model:'local',apiKey:'private-key',enabled:true}}});
  assert.doesNotMatch(JSON.stringify(life.view(character.id)),/private-key/);
  const tool=life.saveTool(character.id,{name:'图片搜索',description:'搜索图片',url:'http://127.0.0.1:9/search',method:'GET',headers:{Authorization:'Bearer secret'},inputSchema:{type:'object'},enabled:true});
  assert.doesNotMatch(JSON.stringify(life.view(character.id)),/Bearer secret/);
  life.saveTool(character.id,{...tool,headers:{Authorization:'••••••'}});
  assert.equal(life.tool(character.id,tool.id).headers.Authorization,'Bearer secret');
});

test('关系召回扩展共同实体，但不能跨越私聊范围；记忆纠正阻止旧错误重新学习',async t=>{
  const {life,character}=await fixture(t);
  life.saveMemory(character.id,{scope:'qq:one',content:'念念的朋友是小林',entities:['念念','小林'],relations:[{from:'念念',to:'小林',label:'朋友'}]});
  const cat=life.saveMemory(character.id,{scope:'qq:one',content:'它叫橘子',entities:['小林','橘子'],relations:[{from:'小林',to:'橘子',label:'养猫'}]});
  life.saveMemory(character.id,{scope:'qq:private',content:'秘密内容',entities:['小林']});
  const recalled=(await life.recall(character.id,{moduleId:'qq',conversationId:'one',text:'念念的朋友'})).memories;
  assert.ok(recalled.find(m=>m.id===cat.id)?.retrieval.graph.length);
  assert.equal(recalled.some(m=>m.content==='秘密内容'),false);
  life.saveMemory(character.id,{...cat,content:'猫的名字其实是柚子'});
  assert.ok(life.data.list(character.id,'forgotten').length);
});

test('安静时段不生成主动消息；情绪动态可独立启用且每日最多发布一次',async t=>{
  let publications=0;
  const {life,character,advance}=await fixture(t,{fetchImpl:async()=>{publications++;return new Response('{"ok":true}',{status:200});},sharedAI:{complete:async()=>({text:'今天的杏花很漂亮。'})}});
  life.configure(character.id,{behavior:{proactiveEnabled:true,proactiveIntervalMinutes:1}});
  await life.observe({character,moduleId:'qq',conversationId:'one',input:'之后聊',reply:'好',sourceId:'1',synthetic:true});
  advance(10*3600000);let sends=0;
  await life.tick({deliver:async()=>{sends++;return {status:'confirmed',delivered:true};}});
  assert.equal(sends,0);
  advance(12*3600000);
  const tool=life.saveTool(character.id,{name:'动态发布',kind:'qzone',url:'https://local-test.invalid/post',method:'POST',enabled:true});
  life.configure(character.id,{behavior:{proactiveEnabled:false},automation:{qzoneEnabled:true,qzoneTool:tool.id}});
  life.saveDiary(character.id,{content:'看到了杏花。'});
  await life.tick();await life.tick();assert.equal(publications,1);
  assert.equal(life.view(character.id).actions.filter(a=>a.kind==='qzone'&&a.status==='confirmed').length,1);
});

test('余额失败显示未知，低余额提醒有去重和紧急级别，所有读取是配置端点',async t=>{
  let response={balance:8};
  const {life,character,advance}=await fixture(t,{fetchImpl:async()=>new Response(JSON.stringify(response))});
  life.configure(character.id,{automation:{balanceEnabled:true,balanceUrl:'http://127.0.0.1:9/balance',lowBalance:10}});
  await life.tick();assert.equal(life.view(character.id).actions[0].kind,'balance');
  advance(31*60000);await life.tick();assert.equal(life.view(character.id).actions.length,1);
  response={balance:1};advance(31*60000);await life.tick();assert.equal(life.view(character.id).actions.length,2);
  response={unknown:true};advance(31*60000);await life.tick();
  assert.equal(life.data.get(character.id,'balance','balance').value,null);
  assert.match(life.view(character.id).events[0].message,/未知/);
});

test('工具真实结果回到回答且媒体产生实际附件；原生语音可以复用已配置声音',async t=>{
  const {life,character}=await fixture(t,{fetchImpl:async()=>new Response('{"url":"https://images.example/apricot.png"}'),sharedAI:{complete:async()=>({text:'找到这张杏花。'})}});
  const tool=life.saveTool(character.id,{name:'找图',kind:'image-search',url:'http://127.0.0.1:9/search',method:'POST',enabled:true});
  const output=await life.processOutput({character,moduleId:'qq',conversationId:'one',text:JSON.stringify({reply:'',tool_calls:[{id:tool.id,arguments:{query:'杏花'}}]})});
  assert.equal(output.text,'找到这张杏花。');
  assert.equal(output.actions[0].url,'https://images.example/apricot.png');
  life.configure(character.id,{media:{voiceEnabled:true}});
  const voice=await life.processOutput({character,moduleId:'companion',conversationId:'one',text:JSON.stringify({reply:'早上好',actions:[{type:'voice',text:'早上好'}]})});
  assert.equal(voice.actions[0].type,'voice');
});

test('生成期间的手动变量修改优先；心情在会话编辑时真正共享并检查版本',async t=>{
  const {life,character}=await fixture(t);
  life.saveState(character.id,{scope:'qq:one',state:{variables:{counter:1}}});
  const context=await life.context({character,moduleId:'qq',conversationId:'one',latestInput:'hello',history:[]});
  const before=life.view(character.id,{moduleId:'qq',conversationId:'one'}).state;
  life.saveState(character.id,{scope:'qq:one',revision:before.revision,sharedRevision:before.sharedRevision,state:{variables:{counter:99},mood:'期待',energy:88}});
  const output=await life.processOutput({character,moduleId:'qq',conversationId:'one',text:'好',context});
  await life.observe({character,moduleId:'qq',conversationId:'one',sourceId:'after-edit',input:'hello',reply:output.text,turnId:output.turnId,synthetic:true});
  assert.equal(life.view(character.id,{moduleId:'qq',conversationId:'one'}).state.variables.counter,99);
  assert.equal(life.view(character.id,{moduleId:'qq',conversationId:'two'}).state.mood,'期待');
  assert.equal(life.view(character.id).state.energy,88);
  assert.throws(()=>life.saveState(character.id,{scope:'qq:two',sharedRevision:before.sharedRevision,state:{mood:'旧值'}}),/心情已经改变/);
});

test('人设之前确实排在前面；回复阶段模板有当前用户名与本轮消息',async t=>{
  const {life,store,character}=await fixture(t);
  const next=life.saveProfile(character.id,{revision:character.revision,raw:{name:'测试角色',description:'PROFILE_MARK',character_book:{entries:[{constant:true,position:'before_char',content:'BEFORE_MARK'}]}}}).character;
  const context=await life.context({character:next,moduleId:'companion',conversationId:'one',userName:'念念',latestInput:'hello',history:[{role:'user',content:'hello'}]});
  assert.ok(context.messages.findIndex(m=>m.content.includes('BEFORE_MARK'))<context.messages.findIndex(m=>m.content.includes('PROFILE_MARK')));
  const output=await life.processOutput({character:next,moduleId:'companion',conversationId:'one',text:'<%= getChatMessages().length %> {{user}} <%= lastUserMessage %> {{lastusermessage}}',context});
  assert.equal(output.text,'2 念念 hello hello');
  const history=[{role:'user',content:[{type:'text',text:'图片说明'},{type:'image_url',image_url:{url:'https://images.example/private.png'}}]}];
  const multimodal=await life.context({character:next,moduleId:'companion',conversationId:'one',latestInput:'本轮文字',history});
  const format='<%= lastUserMessage %> | {{lastusermessage}}';
  assert.equal((await life.processOutput({character:next,moduleId:'companion',conversationId:'one',text:format,context:multimodal})).text,'本轮文字 | 本轮文字');
  assert.equal((await life.processOutput({character:next,moduleId:'companion',conversationId:'one',text:format,history})).text,'图片说明 | 图片说明');
});

test('独立会话的整理并行完成，不因共享心情版本改变丢失本地关系',async t=>{
  const resolvers={};
  const {life,character}=await fixture(t,{sharedAI:{complete:messages=>new Promise(resolve=>{resolvers[JSON.parse(messages.at(-1).content).input]=resolve;})}});
  const a=life.observe({character,moduleId:'qq',conversationId:'a',input:'A',reply:'A',sourceId:'a'});
  const b=life.observe({character,moduleId:'qq',conversationId:'b',input:'B',reply:'B',sourceId:'b'});
  resolvers.A({text:JSON.stringify({state:{mood:'开心',relationship:'A熟悉了'}})});await a;
  resolvers.B({text:JSON.stringify({state:{mood:'轻松',relationship:'B熟悉了'}})});await b;
  assert.equal(life.view(character.id,{moduleId:'qq',conversationId:'a'}).state.relationship,'A熟悉了');
  assert.equal(life.view(character.id,{moduleId:'qq',conversationId:'b'}).state.relationship,'B熟悉了');
});

test('正在生成主动消息时关闭开关，完成后也不能发送',async t=>{
  let finish,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const {life,character,advance}=await fixture(t,{sharedAI:{complete:()=>{entered();return new Promise(resolve=>{finish=resolve;});}}});
  life.configure(character.id,{behavior:{proactiveEnabled:true,proactiveIntervalMinutes:1}});
  await life.observe({character,moduleId:'qq',conversationId:'one',input:'晚点',reply:'好',sourceId:'a',synthetic:true});advance(120000);
  let calls=0;const ticking=life.tick({deliver:async()=>{calls++;return {delivered:true,status:'confirmed'};}});
  await waiting;life.configure(character.id,{behavior:{proactiveEnabled:false}});finish({text:'你好'});await ticking;
  assert.equal(calls,0);assert.equal(life.view(character.id).actions.length,0);
});

test('工具续答同样去除思考；停用的外部世界书不运行输出装饰',async t=>{
  const {life,character}=await fixture(t,{fetchImpl:async()=>new Response('{}'),sharedAI:{complete:async()=>({text:'<think>内部推理</think>回复正文'})}});
  const tool=life.saveTool(character.id,{name:'检索',url:'http://127.0.0.1:9/search',enabled:true});
  life.configure(character.id,{runtime:{worldbooks:[{name:'off',enabled:false,entries:[{constant:true,content:'@@render_after\n不该出现'}]}]}});
  const output=await life.processOutput({character,moduleId:'companion',conversationId:'one',text:JSON.stringify({reply:'',tool_calls:[{id:tool.id,arguments:{}}]})});
  assert.equal(output.text,'回复正文');
  const m=life.saveMemory(character.id,{content:'可以清除到期日',expiresAt:'2028-01-01T00:00:00Z'});
  assert.equal(life.saveMemory(character.id,{...m,expiresAt:null}).expiresAt,null);
});
