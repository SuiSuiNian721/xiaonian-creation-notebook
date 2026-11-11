import { WorkbenchError, fields, object, text } from '../contracts.mjs';
import {normalizeVariableRules} from './variable-rules.mjs';

export const MASK = '••••••';
export const DEFAULT_SETTINGS = {
  enabled:true,
  mode:'lite',
  variableUpdates:{enabled:true,rules:[]},
  memory:{enabled:true,autoExtract:true,continuity:true,sharing:'conversation',halfLifeDays:90,maxRecall:8,embedding:{enabled:false,baseUrl:'',model:'',apiKey:''}},
  behavior:{learnStyle:true,replyMaxChars:600,proactiveEnabled:false,proactiveIntervalMinutes:120,quietStart:'22:00',quietEnd:'08:00',dailyLimit:5,groupEvery:10,typingDelayMs:0},
  automation:{qzoneEnabled:false,qzoneTool:'',helpEnabled:false,ownerId:'',balanceEnabled:false,balanceUrl:'',balanceTool:'',balancePath:'balance',lowBalance:10},
  media:{memes:[],publicMemesEnabled:false,visionNative:'auto',localVisionEnabled:false,localVisionBaseUrl:'',localVisionModel:'',localVisionKey:'',voiceEnabled:false,voiceId:'',voiceMode:'requested',voiceTool:'',imageSearchTool:'',imageGenerationTool:'',visionTool:'',expressionMap:{}},
  runtime:{templatesEnabled:true,scriptsEnabled:false,dialect:'auto',worldbookBudgetChars:6000,worldbooks:[]},
  decision:{enabled:true,rules:[
    {id:'low-energy',name:'低精力简短回复',enabled:true,environment:'any',field:'energy',operator:'lte',value:30,choice:'brief',instruction:''},
    {id:'group-low-mood',name:'群聊低心情先观察',enabled:true,environment:'group',field:'moodValue',operator:'lte',value:35,choice:'observe',instruction:''},
    {id:'close-relationship',name:'熟悉关系自然亲近',enabled:true,environment:'any',field:'relationshipValue',operator:'gte',value:70,choice:'familiar',instruction:''},
  ]},
};

export function cleanJSON(value, label='资料', maxBytes=500000) {
  let count=0;
  const visit=(entry,depth)=>{
    if(++count>30000||depth>40)throw new WorkbenchError(400,`${label}结构过于复杂。`);
    if(entry===null||typeof entry==='boolean')return;
    if(typeof entry==='number'){if(!Number.isFinite(entry))throw new WorkbenchError(400,`${label}数字无效。`);return;}
    if(typeof entry==='string'){if(entry.includes('\0'))throw new WorkbenchError(400,`${label}含无效字符。`);return;}
    if(typeof entry!=='object')throw new WorkbenchError(400,`${label}必须是 JSON 数据。`);
    for(const [key,child] of Object.entries(entry)){
      if(['__proto__','prototype','constructor'].includes(key))throw new WorkbenchError(400,`${label}含不允许的字段。`);
      visit(child,depth+1);
    }
  };
  visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new WorkbenchError(400,`${label}过大。`);
  return structuredClone(value);
}

const number=(value,min,max,label)=>{if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new WorkbenchError(400,`${label}需要在 ${min} 到 ${max} 之间。`);return value;};
export function httpURL(value,{empty=true}={}) {
  const input=text(value,'服务地址',2048,{empty});
  if(!input)return '';
  let url;try{url=new URL(input);}catch{throw new WorkbenchError(400,'服务地址不是有效网址。');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash)throw new WorkbenchError(400,'服务地址需要 HTTP(S)，密钥请单独填写。');
  return input;
}

export function normalizeSettings(previous, patch={}) {
  cleanJSON(patch,'配置');fields(patch,Object.keys(DEFAULT_SETTINGS));
  const result=structuredClone(DEFAULT_SETTINGS);
  if(previous){
    for(const [section,fallback] of Object.entries(DEFAULT_SETTINGS)){
      if(fallback&&typeof fallback==='object')result[section]={...structuredClone(fallback),...structuredClone(previous[section]??{})};
      else if(previous[section]!==undefined)result[section]=previous[section];
    }
    if(previous.mode===undefined)result.mode='full';
  }
  result.memory.embedding={...DEFAULT_SETTINGS.memory.embedding,...result.memory.embedding};
  // Keep existing enabled voices unchanged until their owner chooses a delivery mode.
  if(previous?.media?.voiceEnabled&&previous.media.voiceMode===undefined)result.media.voiceMode='always';
  for(const [section,values] of Object.entries(patch)){
    if(section==='enabled'){if(typeof values!=='boolean')throw new WorkbenchError(400,'启用状态必须是布尔值。');result.enabled=values;continue;}
    if(section==='mode'){result.mode=values;continue;}
    fields(values,[...Object.keys(DEFAULT_SETTINGS[section]),...(section==='media'?['clearLocalVisionKey']:[])],'配置分组');
    for(const [key,value] of Object.entries(values)){
      const fallback=DEFAULT_SETTINGS[section][key];
      if(typeof fallback==='boolean'&&typeof value!=='boolean')throw new WorkbenchError(400,'开关必须是布尔值。');
      result[section][key]=section==='memory'&&key==='embedding'?{...result.memory.embedding,...cleanJSON(object(value,'向量配置'))}:structuredClone(value);
    }
  }
  const m=result.memory,b=result.behavior,a=result.automation,r=result.runtime;
  if(typeof result.variableUpdates.enabled!=='boolean')throw new WorkbenchError(400,'变量更新开关无效。');
  result.variableUpdates.rules=normalizeVariableRules(result.variableUpdates.rules);
  if(!['lite','full'].includes(result.mode))throw new WorkbenchError(400,'角色模式需要选择轻量或完整。');
  const d=result.decision;
  if(typeof d.enabled!=='boolean'||!Array.isArray(d.rules)||d.rules.length>32)throw new WorkbenchError(400,'决策开关无效或规则超过 32 条。');
  const ruleIds=new Set();
  d.rules=d.rules.map(rule=>{
    fields(rule,['id','name','enabled','environment','field','operator','value','choice','instruction'],'决策规则');
    const value={id:text(rule.id,'规则标识',128),name:text(rule.name,'规则名称',100),enabled:rule.enabled,environment:rule.environment,field:rule.field,operator:rule.operator,value:number(rule.value,0,100,'规则阈值'),choice:rule.choice,instruction:text(rule.instruction??'','策略指令',500,{empty:true})};
    if(ruleIds.has(value.id)||typeof value.enabled!=='boolean'||!['any','private','group','proactive'].includes(value.environment)||!['moodValue','energy','relationshipValue'].includes(value.field)||!['lte','gte'].includes(value.operator)||!['brief','gentle','familiar','observe'].includes(value.choice))throw new WorkbenchError(400,'决策规则存在重复标识或无效选项。');
    ruleIds.add(value.id);return value;
  });
  if(!['conversation','character'].includes(m.sharing))throw new WorkbenchError(400,'记忆共享范围无效。');
  number(m.halfLifeDays,1,36500,'记忆半衰期');number(m.maxRecall,1,50,'召回数量');
  fields(m.embedding,['enabled','baseUrl','model','apiKey','clearApiKey']);
  m.embedding={...previous?.memory?.embedding,...m.embedding};
  if(typeof m.embedding.enabled!=='boolean')throw new WorkbenchError(400,'向量服务开关无效。');
  m.embedding.baseUrl=httpURL(m.embedding.baseUrl);
  m.embedding.model=text(m.embedding.model,'向量模型',200,{empty:true});
  m.embedding.apiKey=m.embedding.clearApiKey?'':(!m.embedding.apiKey||m.embedding.apiKey===MASK?previous?.memory?.embedding?.apiKey??'':text(m.embedding.apiKey,'向量密钥',4000,{empty:true}));
  delete m.embedding.clearApiKey;
  number(b.replyMaxChars,20,8000,'回复字数');number(b.proactiveIntervalMinutes,1,10080,'主动间隔');number(b.dailyLimit,0,200,'每日额度');number(b.groupEvery,1,1000,'群聊观察间隔');number(b.typingDelayMs,0,30000,'回复延迟');
  for(const time of [b.quietStart,b.quietEnd])if(typeof time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new WorkbenchError(400,'安静时段需要 HH:mm 格式。');
  for(const key of ['qzoneTool','helpEnabled','ownerId','balanceTool','balancePath'])if(typeof DEFAULT_SETTINGS.automation[key]==='string')a[key]=text(a[key],'自动互动配置',300,{empty:true});
  a.balanceUrl=httpURL(a.balanceUrl);number(a.lowBalance,0,100000000,'余额提醒阈值');
  if(a.ownerId&&!/^\d{5,20}$/.test(a.ownerId))throw new WorkbenchError(400,'求助 QQ 号码无效。');
  if(!['auto','native','mvu','json-patch','rfc6902'].includes(r.dialect))throw new WorkbenchError(400,'变量方言无效。');
  number(r.worldbookBudgetChars,0,60000,'世界书预算');
  if(!Array.isArray(r.worldbooks)||r.worldbooks.length>100)throw new WorkbenchError(400,'外部世界书最多 100 本。');
  cleanJSON(r.worldbooks,'世界书',1500000);
  const media=result.media;
  if(!['auto','supported','unsupported'].includes(media.visionNative))throw new WorkbenchError(400,'原生视觉能力选项无效。');
  media.localVisionBaseUrl=httpURL(media.localVisionBaseUrl);
  media.localVisionModel=text(media.localVisionModel,'本机视觉模型',1000,{empty:true});
  if(media.clearLocalVisionKey!==undefined&&typeof media.clearLocalVisionKey!=='boolean')throw new WorkbenchError(400,'清除视觉密钥开关无效。');
  media.localVisionKey=media.clearLocalVisionKey?'':(!media.localVisionKey||media.localVisionKey===MASK?previous?.media?.localVisionKey??'':text(media.localVisionKey,'本机视觉密钥',4000,{empty:true}));
  delete media.clearLocalVisionKey;
  if(media.localVisionEnabled&&(!media.localVisionBaseUrl||!media.localVisionModel))throw new WorkbenchError(400,'启用本机视觉需要填写服务地址和模型。');
  if(!['requested','always'].includes(media.voiceMode))throw new WorkbenchError(400,'语音发送方式无效。');
  media.voiceId=text(media.voiceId,'共享音色',128,{empty:true});
  if(media.voiceId&&!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(media.voiceId))throw new WorkbenchError(400,'共享音色标识无效。');
  for(const key of ['voiceTool','imageSearchTool','imageGenerationTool','visionTool'])media[key]=text(media[key],'媒体工具',128,{empty:true});
  object(media.expressionMap,'表情映射');cleanJSON(media.expressionMap,'表情映射',50000);
  if(!Array.isArray(media.memes)||media.memes.length>1000)throw new WorkbenchError(400,'表情包最多 1000 张。');
  media.memes=media.memes.map(item=>{fields(item,['id','name','url','tags']);return {id:text(item.id,'表情标识',128),name:text(item.name??'表情','表情名称',100),url:httpURL(item.url,{empty:false}),tags:(Array.isArray(item.tags)?item.tags:[]).slice(0,30).map(tag=>text(tag,'标签',40))};});
  return result;
}

export function publicSettings(settings) {
  const value=structuredClone(settings);
  value.memory.embedding.apiKey=value.memory.embedding.apiKey?MASK:'';
  value.media.localVisionKey=value.media.localVisionKey?MASK:'';
  return value;
}

export function quietTime(settings, at) {
  const date=new Date(at),minutes=date.getHours()*60+date.getMinutes();
  const minute=s=>Number(s.slice(0,2))*60+Number(s.slice(3));
  const start=minute(settings.behavior.quietStart),end=minute(settings.behavior.quietEnd);
  return start!==end&&(start<end?minutes>=start&&minutes<end:minutes>=start||minutes<end);
}
