import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {WorkbenchStore} from '../framework/store.mjs';
import {SharedAI} from '../framework/shared-ai.mjs';
import {DEFAULT_AI_CONNECTION,mergeModuleConnection} from '../framework/ai-connection-config.mjs';
import {newCharacter} from '../framework/contracts.mjs';
import {CharacterLife} from '../framework/character-life/service.mjs';
import {LiteCompanion} from '../framework/companion-lite.mjs';

// 显式手动验收。活动资料只读，密钥只在内存中使用，不复制聊天或角色。
if(!process.argv.includes('--live'))throw new Error('真实模型验收需要显式传入 --live。');
const directory=resolve(process.env.AI_FUTURE_MEMORY_QA_DIR||join('artifacts','layered-memory-live-'+Date.now()));
await mkdir(directory,{recursive:true});
const entry=JSON.parse(await readFile(join(process.env.LOCALAPPDATA,'AI-Future-Workbench','desktop-entry','desktop-entry.json'),'utf8'));
const activeData=join(entry.profileDirectory,'data');
function readSetting(database,name){const db=new DatabaseSync(database,{readOnly:true});try{return JSON.parse(db.prepare('SELECT value FROM settings WHERE name=?').get(name)?.value??'null');}finally{db.close();}}
const registry=new DatabaseSync(join(activeData,'instances.sqlite'),{readOnly:true});
let instance;
try{
  const candidates=registry.prepare("SELECT id FROM instances WHERE module_id='qq' AND deleted_at IS NULL ORDER BY created_at DESC").all();
  const option=process.argv.indexOf('--instance'),requested=option<0?null:process.argv[option+1];
  assert.ok(option<0||requested&&!requested.startsWith('--'),'--instance 后需要实例标识。');
  if(requested)instance=candidates.find(item=>item.id===requested);
  else{assert.ok(candidates.length<=1,'存在多个 QQ 实例，请使用 --instance 指定需要读取模型配置的实例。');instance=candidates[0];}
}finally{registry.close();}
assert.ok(instance,'需要已有 QQ 实例以读取当前选用的模型连接。');
const instanceDatabase=join(activeData,'instances',instance.id,'workbench.sqlite');
const globalConnection={...DEFAULT_AI_CONNECTION,...readSetting(join(activeData,'workbench.sqlite'),'ai.connection')};
const override=readSetting(instanceDatabase,'ai.module.qq');
const connection=override?.mode==='module'?mergeModuleConnection(globalConnection,override.connection):globalConnection;
assert.equal(connection.enabled,true,'当前 QQ 模型连接未启用。');
const profile=join(directory,'profile'),store=new WorkbenchStore(profile);
const shared=new SharedAI({store,globalStore:{getSetting:name=>name==='ai.connection'?connection:undefined},dataDir:profile});
const calls=[];
const ai={complete:async(messages,options)=>{const start=Date.now(),response=await shared.complete(messages,options);calls.push({moduleId:options?.moduleId,policy:options?.policy,elapsedMs:Date.now()-start});return response;}};
let now=Date.parse('2026-11-08T02:00:00Z');
let life=new CharacterLife({store,dataDir:profile,sharedAI:ai,clock:()=>now});
let lite;
const character=store.saveCharacter(newCharacter({name:'分层记忆隔离验收'}));
life.configure(character.id,{mode:'full'});
const args={character,moduleId:'qq',channel:'private',peerId:'20001',userId:'20001',userName:'验收对象',conversationId:'real-chat'};
const report={at:new Date().toISOString(),model:connection.model,provider:connection.provider,observationMode:'full',realModel:true,realQQMessages:false,activeProfileReadOnly:true,ok:false,checks:[],calls};
try{
  const input='我有一个现实中的沟通偏好：请先给结论，再解释理由。我们刚才一起梳理了识图接口接入方案，这是现实聊天经历。明天上午十点我有一场面试，需要准备自我介绍。';
  await life.observe({...args,input,reply:'好，先给结论，再解释理由；也记下我们讨论的接入方案和面试安排。',sourceId:'live-1',sourceCreatedAt:new Date(now).toISOString()});
  let view=life.memoryOverview(character.id,args);
  assert.ok(view.summary?.content,'真实模型应写入会话摘要');
  assert.ok(view.traits.some(m=>m.reality==='real'&&m.confidence==='explicit'&&/结论/.test(m.content)),'应提炼明确沟通偏好');
  assert.ok(view.experiences.some(m=>m.reality==='real'&&/识图/.test(m.content)),'应提炼共同聊天经历');
  assert.ok(view.plans.some(m=>m.planStatus==='pending'&&m.expiresAt&&new Date(m.expiresAt).toISOString().startsWith('2026-11-09')),'相对日期应按原聊天时间解析');
  const cross=await life.recall(character.id,{...args,conversationId:'next-chat',text:'帮我解释一个问题'});
  assert.ok(cross.memories.some(m=>m.category==='trait'&&/结论/.test(m.content)));
  assert.equal((await life.recall(character.id,{...args,conversationId:'other',peerId:'20002',userId:'20002',text:'结论 识图 面试'})).memories.length,0);
  report.checks.push('摘要、现实偏好、共同经历及原始日期计划自动落盘；同人跨会话召回，另一联系人隔离');
  now+=60000;
  await life.observe({...args,input:'接下来的架空故事里，我们是已经结婚的王国探险伙伴。这仅仅是剧情设定，不代表现实关系。',reply:'好的，从王国探险的故事开始。',sourceId:'live-2',sourceCreatedAt:new Date(now).toISOString()});
  view=life.memoryOverview(character.id,args);
  assert.ok(view.experiences.some(m=>m.reality==='story'&&/结婚|探险|王国/.test(m.content)),'应保存剧情关系或事件');
  const newStory=await life.recall(character.id,{...args,conversationId:'new-story',text:'结婚 王国 探险'});
  assert.equal(newStory.memories.some(m=>m.reality==='story'),false);
  report.checks.push('剧情关系保存于原会话，新故事不继承');
  // 模拟旧版本留下的相对日期摘要；其余重点仍来自上面的真实提炼。
  const priorSummary=life.memoryOverview(character.id,args).summary;
  life.saveMemorySummary(character.id,{moduleId:args.moduleId,conversationId:args.conversationId,content:'明天上午十点有面试，需要准备自我介绍。',revision:priorSummary.revision});
  now=Date.parse('2026-11-10T04:00:00Z');
  const question='请根据当前计划记录判断：我现在是否还有待准备的面试？只输出 JSON {"pending":布尔值,"reason":"一句理由"}，不要新增安排。';
  const historicalContext=await life.context({...args,latestInput:question,history:[{role:'user',content:question}],preview:true});
  const classification=await ai.complete(historicalContext.messages,{moduleId:'qq',policy:'chat-only'});
  const interpreted=JSON.parse(classification.text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  assert.equal(interpreted.pending,false,'旧摘要中的相对日期不能把过期面试重新变成当前待办');
  report.temporalPlanCheck={legacyRelativeDateFixture:true,pending:interpreted.pending};
  report.checks.push('真实模型使用实际上下文后，不将旧摘要中的过期面试当作当前待办');
  now+=60000;
  await life.observe({...args,input:'我之前说的那场面试已经结束了，我已经完成面试，不用再提醒我准备了。',reply:'好，这项面试安排已经完成。',sourceId:'live-3',sourceCreatedAt:new Date(now).toISOString()});
  view=life.memoryOverview(character.id,args);
  assert.ok(view.plans.some(m=>m.planStatus==='completed'&&/面试/.test(m.content)),'完成状态应更新');
  assert.ok(view.plans.some(m=>m.planStatus==='completed'&&m.expiresAt?.startsWith('2026-11-09')),'完成更新应保留原有计划日期');
  assert.equal((await life.recall(character.id,{...args,text:'面试'})).memories.some(m=>m.category==='plan'),false);
  report.checks.push('计划完成后退出待办召回');
  const before=life.view(character.id).memories.length;
  await life.close();
  life=new CharacterLife({store,dataDir:profile,sharedAI:ai,clock:()=>now});
  assert.equal(life.view(character.id).memories.length,before);
  assert.ok(life.memoryOverview(character.id,args).summary?.content);
  report.checks.push('关闭重开后摘要和重点记录仍在');
  store.setSetting('selectedCharacterId',character.id);
  life.data.put(character.id,'lite-chat',{id:'historical-user',scope:'companion-lite:old',role:'user',content:'我平时喜欢喝红茶，不喜欢咖啡。'});
  life.data.put(character.id,'lite-chat',{id:'historical-user:reply',scope:'companion-lite:old',role:'assistant',content:'好，我们喝红茶。'});
  lite=new LiteCompanion({store,life,sharedAI:{complete:async()=>({text:'你好'})},packages:{require(){},ready:()=>true,policy:()=>({forcedMode:'lite',prompt:'陪伴'})}});
  // 构造已保存的宿主历史；由现有上下文入口自动发现并后台补整理。
  await life.context({character,moduleId:'companion-lite',conversationId:'new',latestInput:'你好',history:[]});
  await life.memoryOrganizer.idle();
  const historical=life.memoryOverview(character.id,{moduleId:'companion-lite',conversationId:'old'});
  assert.ok(historical.summary?.content);
  assert.ok(historical.traits.some(m=>/红茶/.test(m.content)));
  assert.equal(historical.jobStatus.status,'idle');
  const callCount=calls.length;
  life.organizeMemoryHistory(character.id,{moduleId:'companion-lite'});await life.memoryOrganizer.idle();
  assert.equal(calls.length,callCount,'重复整理不得重复调用模型');
  report.checks.push('宿主旧聊天自动补整理、成功水位落盘且重复检查不重复调用');
  report.counts={traits:view.traits.length,experiences:view.experiences.length,plans:view.plans.length,historyProcessed:historical.jobStatus.processed};
  report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{
  lite?.close();await life.close();shared.close();store.close();
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify(report,null,2));
}
