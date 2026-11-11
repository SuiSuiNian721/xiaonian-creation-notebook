import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkbenchStore } from '../framework/store.mjs';
import { newCharacter } from '../framework/contracts.mjs';
import { CharacterLife } from '../framework/character-life/service.mjs';
import { DEFAULT_SETTINGS, normalizeSettings } from '../framework/character-life/settings.mjs';

async function fixture(t, ai=async()=>({text:'{}'})) {
  const directory=await mkdtemp(join(tmpdir(),'life-modes-')),store=new WorkbenchStore(directory);
  const character=store.saveCharacter(newCharacter({name:'模式角色',raw:{name:'模式角色',personality:'PERSONA_MARK',character_book:{entries:[{constant:true,content:'WORLD_MARK'}]}}}));
  const calls=[],life=new CharacterLife({store,dataDir:directory,sharedAI:{complete:async(...args)=>{calls.push(args);return ai(...args);}},clock:()=>Date.parse('2026-11-07T04:00:00Z')});
  t.after(async()=>{await life.close();store.close();await rm(directory,{recursive:true,force:true});});
  const route={character,moduleId:'qq',conversationId:'one'};
  return {life,store,character,calls,route};
}

test('新角色默认轻量，旧持久化配置缺少 mode 则补全为完整且保留资料',async t=>{
  const {life,character}=await fixture(t);
  assert.equal(life.config(character.id).mode,'lite');
  life.data.put(character.id,'settings',{id:'settings',value:{enabled:true,behavior:{typingDelayMs:3},memory:{embedding:{apiKey:'secret'}}},revision:4});
  assert.equal(life.config(character.id).mode,'full');
  assert.equal(life.config(character.id).memory.embedding.apiKey,'secret');
  assert.equal(life.config(character.id).runtime.templatesEnabled,true);
  assert.equal(life.configure(character.id,{mode:'lite'}).settings.behavior.typingDelayMs,3);
  assert.equal(normalizeSettings(undefined,{}).mode,'lite');
});

for(const mode of ['lite','full'])test(`${mode} 内置表情支持标记和信封动作，目录外标识无媒体，自定义表情保留`,async t=>{
  const {life,character,route}=await fixture(t);
  life.configure(character.id,{mode,media:{publicMemesEnabled:true,memes:[{id:'custom',name:'自定义',url:'https://example.invalid/custom.gif',tags:['开心']}]}});
  const context=await life.context({...route,latestInput:'开心 猫猫 搓手'});
  assert.match(context.prompt,/sticker:/);assert.ok(context.prompt.length<20000);
  const id=life.memes.candidates('开心 猫猫 搓手')[0].id;
  const marked=await life.processOutput({...route,context,text:`好呀[sticker:${id}]`});
  assert.equal(marked.text,'好呀');assert.equal(marked.actions.length,1);assert.equal(marked.actions[0].memeId,id);
  const envelope=await life.processOutput({...route,context,text:JSON.stringify({reply:'好的',actions:[{type:'meme',id:'custom'},{type:'meme',id:'https://evil.example/a.gif'}]})});
  assert.equal(envelope.actions.length,1);assert.equal(envelope.actions[0].url,'https://example.invalid/custom.gif');
  life.confirmMemes(character.id,route,marked.actions);
  const repeated=await life.processOutput({...route,context,text:`好呀[sticker:${id}]`});assert.deepEqual(repeated.actions,[]);
  life.configure(character.id,{media:{publicMemesEnabled:false}});
  const disabled=await life.processOutput({...route,context:await life.context(route),text:`好呀[sticker:${id}]`});assert.deepEqual(disabled.actions,[]);
});

test('直接full QQ context继续调用既有视觉工具，预演和精简不调用',async t=>{
  const {life,character,route}=await fixture(t);const requests=[];
  life.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return Response.json({description:'LEGACY_VISION_DESCRIPTION'});};
  const tool=life.saveTool(character.id,{name:'原视觉工具',kind:'vision',enabled:true,url:'http://localhost:9/vision'});
  life.configure(character.id,{mode:'full',media:{visionTool:tool.id}});
  const args={...route,latestInput:'这是什么',attachments:[{type:'image',url:'https://example.invalid/image.png'}]};
  assert.match((await life.context(args)).prompt,/LEGACY_VISION_DESCRIPTION/);assert.equal(requests.length,1);
  await life.context({...args,preview:true});assert.equal(requests.length,1);
  life.configure(character.id,{mode:'lite'});await life.context(args);assert.equal(requests.length,1);
});

for(const explicit of [false,true])test(`full共享语音${explicit?'显式动作回退':'自动'}只朗读去掉表情标记的正文`,async t=>{
  const {life,character,route}=await fixture(t),voices=[];
  life.sharedVoice=async value=>{voices.push(value.text);return {type:'record',voiceId:'voice',url:'https://audio.example/voice.wav'};};
  life.configure(character.id,{mode:'full',media:{voiceEnabled:true,voiceId:'voice',voiceMode:'always',memes:[{id:'wave',name:'挥手',url:'https://image.example/wave.gif',tags:[]}]}});
  const context=await life.context({...route,latestInput:'你好'});
  const text=explicit?JSON.stringify({reply:'你好[sticker:wave]',actions:[{type:'voice'}]}):'你好[sticker:wave]';
  const result=await life.processOutput({...route,context,text});assert.equal(result.text,'你好');assert.deepEqual(voices,['你好']);
});

for(const target of ['shared','companion','http'])test(`full显式${target}语音文本去掉表情控制标记，普通措辞保留且不新增图片动作`,async t=>{
  const {life,character,route}=await fixture(t),voices=[];
  if(target==='shared')life.sharedVoice=async value=>{voices.push(value.text);return {type:'record',url:'https://audio.example/voice.wav'};};
  const voiceTool=target==='http'?life.saveTool(character.id,{name:'HTTP声音',kind:'voice',enabled:true,url:'http://localhost:9/voice'}).id:'';
  if(target==='http')life.fetch=async(_url,options)=>{voices.push(JSON.parse(options.body).text);return Response.json({url:'https://audio.example/voice.wav'});};
  life.configure(character.id,{mode:'full',media:{voiceEnabled:true,voiceId:target==='shared'?'voice':'',voiceMode:'always',voiceTool,memes:[{id:'wave',name:'挥手',url:'https://image.example/wave.gif',tags:[]}]}});
  const args={...route,moduleId:target==='companion'?'companion':'qq'},context=await life.context({...args,latestInput:'朗读'});
  for(const content of ['晚安[sticker:wave]，明天见 [微笑]','晚安，明天见 [微笑]']){
    const result=await life.processOutput({...args,context,text:JSON.stringify({reply:'晚安',actions:[{type:'voice',text:content}]})});
    assert.equal(result.text,'晚安');assert.equal(result.actions.some(action=>action.type==='image'),false);
    if(target==='companion')voices.push(result.actions[0].text);
  }
  assert.deepEqual(voices,['晚安，明天见 [微笑]','晚安，明天见 [微笑]']);
});

for(const mode of ['lite','full'])test(`${mode}自定义表情按名称标签匹配全目录后限制候选，无匹配时有限回退`,async t=>{
  const {life,character,route}=await fixture(t);
  const memes=Array.from({length:8},(_,index)=>({id:'custom'+index,name:index===4?'准备睡觉':'开心'+index,url:`https://image.example/${index}.gif`,tags:index===4?['晚安','睡觉']:['开心']}));
  life.configure(character.id,{mode,media:{memes}});
  const matched=await life.context({...route,latestInput:'晚安睡觉'});
  assert.match(matched.prompt,/custom4/);assert.doesNotMatch(matched.prompt,/custom0/);
  const fallback=await life.context({...route,latestInput:'unmatched-topic'});
  assert.match(fallback.prompt,/custom0/);assert.equal((fallback.prompt.match(/"id":"custom\d+"/g)??[]).length,4);
});

test('轻量实际提示仅含基础人设和记忆，高级资料休眠且输出不执行工具变量和媒体',async t=>{
  const {life,character,route,calls}=await fixture(t);
  life.saveMemory(character.id,{content:'MEMORY_MARK',pinned:true});
  life.saveState(character.id,{state:{mood:'STATE_MARK',variables:{secret:'VARIABLE_MARK'}}});
  life.saveExpression(character.id,{content:'STYLE_MARK'});
  const tool=life.saveTool(character.id,{name:'TOOL_MARK',url:'http://localhost:9',enabled:true});
  life.configure(character.id,{runtime:{scriptsEnabled:true},media:{voiceEnabled:true},behavior:{proactiveEnabled:true}});
  const context=await life.context({...route,latestInput:'你好'});
  assert.match(context.prompt,/PERSONA_MARK/);assert.match(context.prompt,/MEMORY_MARK/);
  assert.doesNotMatch(JSON.stringify(context.messages),/WORLD_MARK|STATE_MARK|VARIABLE_MARK|STYLE_MARK|TOOL_MARK|连续状态|当前决策/);
  const output=await life.processOutput({...route,context,text:JSON.stringify({reply:'你好',tool_calls:[{id:tool.id,arguments:{}}],actions:[{type:'voice',text:'hi'}]})});
  assert.equal(output.text,'你好');assert.deepEqual(output.actions,[]);assert.equal(calls.length,0);
  assert.equal(life.config(character.id).runtime.scriptsEnabled,true);
  await assert.rejects(life.scriptPreview(character.id,{code:'return 1'}),/完整/);
});

test('轻量只提取有来源记忆，关闭记忆后零观察请求且不改变状态表达日记',async t=>{
  const {life,character,route,calls}=await fixture(t,async()=>({text:JSON.stringify({memories:[{content:'喜欢花',sourceQuote:'喜欢花'}],state:{mood:'BAD',energy:0},expressions:[{content:'BAD',sourceQuote:'喜欢花'}],diary:'BAD'})}));
  await life.observe({...route,input:'喜欢花',reply:'好',sourceId:'1'});
  assert.equal(calls.length,1);assert.doesNotMatch(calls[0][0][0].content,/"state"|"expressions"|"diary"/);
  assert.equal(life.view(character.id).memories.length,1);assert.equal(life.view(character.id).expressions.length,0);assert.equal(life.view(character.id).diary.length,0);assert.equal(life.state(character.id).energy,60);
  life.configure(character.id,{memory:{enabled:false}});
  await life.observe({...route,input:'你好',reply:'好',sourceId:'2'});assert.equal(calls.length,1);
});

test('完整观察单请求更新数值，限制每轮10，心情精力共享关系独立，手动编辑可完整取值',async t=>{
  const {life,character,route,calls}=await fixture(t,async()=>({text:JSON.stringify({state:{moodValue:100,energy:0,relationshipValue:100}})}));
  life.configure(character.id,{mode:'full',memory:{enabled:false,autoExtract:false},behavior:{learnStyle:false}});
  await life.observe({...route,input:'你好',reply:'好',sourceId:'1'});
  assert.equal(calls.length,1);
  const a=life.state(character.id,'qq:one'),b=life.state(character.id,'qq:two');
  assert.equal(a.moodValue,60);assert.equal(b.moodValue,60);assert.equal(a.energy,50);assert.equal(a.relationshipValue,30);assert.equal(b.relationshipValue,20);
  life.saveState(character.id,{scope:'qq:one',state:{moodValue:0,relationshipValue:100,energy:100}});
  assert.equal(life.state(character.id,'qq:two').moodValue,0);assert.equal(life.state(character.id,'qq:one').relationshipValue,100);
  assert.throws(()=>life.saveState(character.id,{state:{moodValue:'20'}}),/0.*100/);
});

test('完整观察丢弃无效数值但有效字段仍更新',async t=>{
  const {life,character,route}=await fixture(t,async()=>({text:JSON.stringify({state:{moodValue:'99',energy:-1,relationshipValue:101,mood:'期待'}})}));
  life.configure(character.id,{mode:'full'});await life.observe({...route,input:'你好',reply:'好',sourceId:'1'});
  assert.equal(life.state(character.id).moodValue,50);assert.equal(life.state(character.id).energy,60);assert.equal(life.state(character.id,'qq:one').relationshipValue,20);assert.equal(life.state(character.id).mood,'期待');
});

test('完整决策是首条匹配的本地规则，策略进入实际提示，群聊从显式channel与已保存范围识别',async t=>{
  const {life,character,route,calls}=await fixture(t);
  life.configure(character.id,{mode:'full'});life.saveState(character.id,{scope:'qq:one',state:{energy:20,relationshipValue:80,moodValue:20}});
  let context=await life.context({...route,channel:'group',latestInput:'你好'});
  assert.equal(context.decision.choice,'brief');assert.equal(context.decision.environment,'group');assert.match(context.prompt,/简短/);assert.ok(context.trace.some(x=>x.kind==='decision'));
  life.saveState(character.id,{state:{energy:80}});
  context=await life.context({...route,channel:'group',latestInput:'你好'});assert.equal(context.decision.choice,'observe');assert.match(context.prompt,/观察/);
  await life.observe({...route,channel:'group',input:'你好',reply:'好',sourceId:'s',synthetic:true});
  assert.equal(life.view(character.id,{moduleId:'qq',conversationId:'one'}).decision.environment,'group');
  assert.equal((await life.preview(character.id,{moduleId:'qq',conversationId:'one',environment:'private'})).decision.environment,'private');
  assert.equal((await life.context({...route,channel:'private',latestInput:'你好'})).decision.choice,'familiar');assert.equal(calls.length,0);
});

test('决策结构验证上限和枚举，禁用时回到平衡策略',async t=>{
  const {life,character}=await fixture(t),rule=DEFAULT_SETTINGS.decision?.rules?.[0]??{id:'a',name:'a',enabled:true,environment:'any',field:'energy',operator:'lte',value:30,choice:'brief',instruction:''};
  for(const patch of [{rules:Array.from({length:33},(_,i)=>({...rule,id:String(i)}))},{rules:[{...rule,instruction:'a'.repeat(501)}]},{rules:[{...rule,field:'variables'}]},{rules:[{...rule,value:NaN}]},{rules:[{...rule,enabled:'true'}]}])assert.throws(()=>life.configure(character.id,{decision:patch}));
  life.configure(character.id,{mode:'full',decision:{enabled:false}});life.saveState(character.id,{state:{energy:0}});assert.equal(life.view(character.id).decision.choice,'balanced');
});

test('轻量拒绝群聊自主参与和所有调度，但直接提问和提及照常回复',async t=>{
  const {life,character,route,calls}=await fixture(t);life.configure(character.id,{behavior:{proactiveEnabled:true,groupEvery:1},automation:{balanceEnabled:true,balanceUrl:'http://localhost:9',qzoneEnabled:true}});
  assert.equal((await life.decide({...route,channel:'group'})).reply,false);assert.equal((await life.decide({...route,channel:'group',mentioned:true})).reply,true);assert.equal((await life.decide({...route,channel:'private'})).reply,true);
  await life.tick({deliver:()=>{throw new Error('不可发送');}});assert.equal(calls.length,0);assert.equal(life.view(character.id).actions.length,0);
});

test('观察策略只抑制未提及群聊和主动消息，不阻止提及或私聊',async t=>{
  const {life,character,route,calls}=await fixture(t);life.configure(character.id,{mode:'full',behavior:{groupEvery:1,proactiveEnabled:true,proactiveIntervalMinutes:1},decision:{rules:[{id:'wait',name:'观察',enabled:true,environment:'any',field:'energy',operator:'gte',value:0,choice:'observe',instruction:'等待对方'}]}});
  assert.equal((await life.decide({...route,channel:'group'})).reply,false);assert.equal((await life.decide({...route,channel:'group',mentioned:true})).reply,true);assert.equal((await life.decide({...route,channel:'private'})).reply,true);
  await life.observe({...route,input:'你好',reply:'好',sourceId:'1',synthetic:true});
  life.data.put(character.id,'scope',{...life.data.get(character.id,'scope','qq:one'),lastActiveAt:'2026-11-07T00:00:00Z'});
  await life.tick({deliver:()=>{throw new Error('不可发送');}});assert.equal(calls.length,0);
});

test('完整到轻量再完整使正在观察的旧结果失效',async t=>{
  let finish;const {life,character,route}=await fixture(t,()=>new Promise(resolve=>{finish=resolve;}));life.configure(character.id,{mode:'full'});
  const pending=life.observe({...route,input:'喜欢花',reply:'好',sourceId:'1'});life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});
  finish({text:JSON.stringify({state:{moodValue:90},memories:[{content:'旧结果',sourceQuote:'喜欢花'}],diary:'旧结果'})});await pending;
  assert.equal(life.state(character.id).moodValue,50);assert.equal(life.view(character.id).memories.length,0);assert.equal(life.view(character.id).diary.length,0);
});

test('完整到轻量再完整不能提交旧上下文变量和HTML',async t=>{
  const {life,character,route}=await fixture(t);life.configure(character.id,{mode:'full'});
  const context=await life.context({...route,latestInput:'你好'});life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});
  const output=await life.processOutput({...route,context,text:'<UpdateVariable>_.set("counter",99);</UpdateVariable>你好'});
  await life.observe({...route,turnId:output.turnId,input:'你好',reply:output.text,sourceId:'1',synthetic:true});
  assert.equal(life.state(character.id,'qq:one').variables.counter,undefined);
});

test('生成完成后切换模式，送达整理不能再学习旧轮次或提交变量HTML',async t=>{
  const {life,character,route,calls}=await fixture(t,async()=>({text:JSON.stringify({state:{moodValue:90},diary:'过期'})}));life.configure(character.id,{mode:'full'});
  const context=await life.context({...route,latestInput:'你好'});
  const output=await life.processOutput({...route,context,text:'<UpdateVariable>_.set("counter",99);</UpdateVariable>你好'});
  life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});
  await life.observe({...route,turnId:output.turnId,input:'你好',reply:output.text,sourceId:'stale-delivery'});
  assert.equal(calls.length,0);assert.equal(life.state(character.id).moodValue,50);assert.equal(life.state(character.id,'qq:one').variables.counter,undefined);
});

test('不同会话并行观察保护共享数值版本且不丢失各自关系数值',async t=>{
  const finish={};const {life,character,route}=await fixture(t,messages=>new Promise(resolve=>{finish[JSON.parse(messages.at(-1).content).input]=resolve;}));life.configure(character.id,{mode:'full'});
  const a=life.observe({...route,input:'A',reply:'好',sourceId:'a'}),b=life.observe({...route,conversationId:'two',input:'B',reply:'好',sourceId:'b'});
  finish.A({text:JSON.stringify({state:{moodValue:100,relationshipValue:90}})});await a;
  finish.B({text:JSON.stringify({state:{moodValue:0,relationshipValue:0}})});await b;
  assert.equal(life.state(character.id).moodValue,60);assert.equal(life.state(character.id,'qq:one').relationshipValue,30);assert.equal(life.state(character.id,'qq:two').relationshipValue,10);
});

test('完整工具等待期间切为轻量再完整后，不继续调用或生成新高级结果',async t=>{
  let finish;const {life,character,route,calls}=await fixture(t);life.configure(character.id,{mode:'full'});
  life.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const tool=life.saveTool(character.id,{name:'检索',enabled:true,url:'http://localhost:9'});
  const output=life.processOutput({...route,text:JSON.stringify({reply:'',tool_calls:[{id:tool.id,arguments:{}}]})});
  life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});finish(new Response('{}'));
  await assert.rejects(output,/已改变/);assert.equal(calls.length,0);
});

test('轻量阻止已有待办发送和直接调用角色工具，但允许忽略待办',async t=>{
  const {life,character}=await fixture(t),action=life.action(character.id,{kind:'proactive',text:'旧消息'});
  await assert.rejects(life.handleAction(character.id,{id:action.id,operation:'deliver'},{deliver:()=>{throw new Error('不可调用');}}),/完整/);
  await assert.rejects(life.invoke({enabled:true,url:'http://localhost:9'},{},{characterId:character.id}),/完整/);
  assert.equal((await life.handleAction(character.id,{id:action.id,operation:'dismiss'})).status,'dismissed');
});

test('轻量输出尚未整理时启用完整模式，不追溯学习为完整状态',async t=>{
  const {life,character,route,calls}=await fixture(t,async()=>({text:JSON.stringify({state:{moodValue:90}})}));
  const context=await life.context({...route,latestInput:'你好'}),output=await life.processOutput({...route,context,text:'好'});
  life.configure(character.id,{mode:'full'});await life.observe({...route,turnId:output.turnId,input:'你好',reply:output.text,sourceId:'late'});
  assert.equal(calls.length,0);assert.equal(life.state(character.id).moodValue,50);
});

test('主动连接检查等待期间切模式，旧调度不能继续请求模型',async t=>{
  let finish,entered;const waiting=new Promise(resolve=>{entered=resolve;});
  const {life,character,route,calls}=await fixture(t);life.configure(character.id,{mode:'full',behavior:{proactiveEnabled:true,proactiveIntervalMinutes:1}});
  await life.observe({...route,input:'你好',reply:'好',sourceId:'1',synthetic:true});
  life.data.put(character.id,'scope',{...life.data.get(character.id,'scope','qq:one'),lastActiveAt:'2026-11-07T00:00:00Z'});
  life.canDeliver=()=>{entered();return new Promise(resolve=>{finish=resolve;});};
  const ticking=life.tick({deliver:()=>{throw new Error('不可发送');}});await waiting;
  life.configure(character.id,{mode:'lite'});life.configure(character.id,{mode:'full'});finish(true);await ticking;
  assert.equal(calls.length,0);
});

test('精简预演与后台记忆整理统一使用文字策略，包括全局完整时的精简轮次',async t=>{
  const {life,character,calls}=await fixture(t,async()=>({text:'{"memories":[]}'}));
  life.configure(character.id,{mode:'full'});
  await life.simulate(character.id,{moduleId:'companion-lite',text:'你好'});
  await life.observe({character,moduleId:'companion-lite',conversationId:'lite',input:'你好',reply:'你好',sourceId:'lite-memory'});
  assert.deepEqual(calls.map(([,options])=>options.policy),['chat-only','chat-only']);
  calls.length=0;
  const turnId=life.rememberOutput({id:character.id,scope:'companion:native',mode:'lite',configRevision:life.configRevision(character.id)});
  await life.observe({character,moduleId:'companion',conversationId:'native',turnId,input:'你好',reply:'你好',sourceId:'pending-lite'});
  assert.equal(calls[0][1].policy,'chat-only');
});

test('完整陪伴的观察整理固定使用文字策略，完整状态与记忆仍在同一次请求提取',async t=>{
  const {life,character,calls}=await fixture(t,async()=>({text:JSON.stringify({memories:[{content:'对方喜欢红茶',kind:'preference',category:'trait',reality:'real',confidence:'explicit',sourceQuote:'我喜欢红茶'}],summary:'聊到饮品',state:{moodValue:55},diary:'聊了红茶'})}));
  life.configure(character.id,{mode:'full'});
  await life.observe({character,moduleId:'companion',conversationId:'native',userId:'owner',input:'我喜欢红茶',reply:'记下了',sourceId:'full-memory'});
  assert.equal(calls.length,1);assert.equal(calls[0][1].policy,'chat-only');assert.equal(calls[0][1].moduleId,'companion');
  assert.equal(life.state(character.id).moodValue,55);assert.equal(life.view(character.id).memories[0].content,'对方喜欢红茶');
  assert.equal(life.memoryOverview(character.id,{moduleId:'companion',conversationId:'native'}).summary.content,'聊到饮品');
});
