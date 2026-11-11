import {WorkbenchError,fields,text} from '../contracts.mjs';

const builtin=new Set(['moodValue','energy','relationshipValue']);
const blocked=new Set(['__proto__','prototype','constructor']);
const validPath=path=>typeof path==='string'&&path.length<=240&&path.split('.').length<=32&&(builtin.has(path)||path.startsWith('variables.')&&path.split('.').slice(1).every(key=>/^[\p{L}\p{N}_-]{1,64}$/u.test(key)&&!blocked.has(key)));
const fail=message=>{throw new WorkbenchError(400,message);};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const typed=(value,type)=>typeof value===type&&(type!=='number'||finite(value))&&(type!=='string'||value.length<=2000);
export function variableValue(state,path){let value=state;for(const key of path.split('.')){if(!value||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=value[key];}return value;}
function assign(state,path,value){const keys=path.split('.');let owner=state;for(const key of keys.slice(0,-1)){const current=Object.hasOwn(owner,key)?owner[key]:undefined;if(current!==undefined&&(!current||typeof current!=='object'||Array.isArray(current)))return false;if(current===undefined)owner[key]={};owner=owner[key];}owner[keys.at(-1)]=value;return true;}

export function withVariableDefaults(original,rules){
  const state=structuredClone(original);
  for(const rule of rules)if(rule.enabled&&variableValue(state,rule.path)===undefined)assign(state,rule.path,rule.initial);
  return state;
}

// Card scripts and MVU patches may update other fields, but cannot bypass declared rules.
export function protectRuleVariables(candidate,original,rules){
  const state={variables:structuredClone(candidate)};
  for(const rule of rules.filter(rule=>rule.enabled&&rule.path.startsWith('variables.'))){
    const keys=rule.path.split('.');let owner=state,old={variables:original},conflict=false;
    for(const key of keys.slice(0,-1)){
      const prior=old&&Object.hasOwn(old,key)?old[key]:undefined;
      if(prior!==undefined&&(!prior||typeof prior!=='object'||Array.isArray(prior))){owner[key]=structuredClone(prior);conflict=true;break;}
      if(!owner[key]||typeof owner[key]!=='object'||Array.isArray(owner[key]))owner[key]={};owner=owner[key];old=prior;
    }
    if(conflict)continue;
    const value=variableValue({variables:original},rule.path);
    if(value===undefined)delete owner[keys.at(-1)];else owner[keys.at(-1)]=structuredClone(value);
  }
  return state.variables;
}

export function normalizeVariableRules(input){
  if(!Array.isArray(input)||input.length>32)fail('变量更新规则最多 32 条。');
  const ids=new Set(),definitions=new Map();
  const rules=input.map(value=>{
    fields(value,['id','name','enabled','path','type','initial','min','max','maxDelta','trigger','environment','conditionPath','operator','threshold','event','operation','value']);
    const rule={...value,id:text(value.id,'规则标识',100),name:text(value.name,'规则名称',100),enabled:value.enabled!==false,event:text(value.event??'','事件说明',1000,{empty:true})};
    if(ids.has(rule.id))fail('变量规则标识不能重复。');ids.add(rule.id);
    if(value.enabled!==undefined&&typeof value.enabled!=='boolean')fail('规则启用状态必须是开关。');
    if(!validPath(rule.path)||!validPath(rule.conditionPath))fail('变量路径无效；使用内置状态名或 variables.变量名。');
    if(!['number','string','boolean'].includes(rule.type)||!typed(rule.initial,rule.type)||!typed(rule.value,rule.type))fail('变量初值和更新值必须符合声明类型。');
    if(!['semantic','condition'].includes(rule.trigger)||!['any','private','group','proactive'].includes(rule.environment)||!['lte','gte','eq'].includes(rule.operator))fail('变量触发条件无效。');
    if(!['add','set'].includes(rule.operation)||rule.operation==='add'&&rule.type!=='number')fail('只有数值变量可以增减。');
    if(!['number','string','boolean'].includes(typeof rule.threshold)||typeof rule.threshold==='number'&&!finite(rule.threshold)||typeof rule.threshold==='string'&&rule.threshold.length>2000)fail('条件比较值无效。');
    if(rule.operator!=='eq'&&!finite(rule.threshold))fail('大小比较需要数值。');
    if(rule.trigger==='semantic'&&!rule.event.trim())fail('请说明哪些实际事件可以触发更新。');
    if(builtin.has(rule.path)&&rule.type!=='number')fail('心情、精力与关系值必须是数值。');
    if(rule.type==='number'){
      if(![rule.min,rule.max,rule.maxDelta].every(finite)||rule.min>rule.max||rule.maxDelta<=0||rule.maxDelta>1000000||rule.initial<rule.min||rule.initial>rule.max)fail('请填写有效范围、初值和单轮变化上限。');
      if(builtin.has(rule.path)&&(rule.min<0||rule.max>100||rule.maxDelta>10))fail('内置状态范围为 0–100，每轮最多变化 10。');
    }else{delete rule.min;delete rule.max;delete rule.maxDelta;}
    const definition=JSON.stringify([rule.type,rule.initial,rule.min,rule.max,rule.maxDelta]);
    if(definitions.has(rule.path)&&definitions.get(rule.path)!==definition)fail('同一变量的类型、初值、范围和单轮上限必须一致。');definitions.set(rule.path,definition);
    return rule;
  });
  const paths=[...definitions.keys()];if(paths.some(path=>paths.some(other=>other!==path&&other.startsWith(path+'.'))))fail('变量不能同时声明为值和父级对象。');
  return rules;
}

// Only a candidate is produced. The caller owns delivery, revision checks and the transaction.
export function evaluateVariableRules(original,rules,{input='',events=[],environment='private'}={}){
  const state=structuredClone(original),conditionState=withVariableDefaults(original,rules),changes=[],claimed=new Set();
  for(const rule of rules.filter(rule=>rule.enabled)){
    let before=variableValue(state,rule.path);
    if(before===undefined&&assign(state,rule.path,rule.initial)){before=rule.initial;changes.push({ruleId:rule.id,path:rule.path,kind:'initialize',before:null,after:before,reason:'采用声明的初始值',sourceQuote:''});}
    if(claimed.has(rule.path)||!typed(before,rule.type)||rule.environment!=='any'&&rule.environment!==environment)continue;
    let evidence;
    if(rule.trigger==='semantic'){
      evidence=Array.isArray(events)?events.find(event=>event?.ruleId===rule.id&&typeof event.sourceQuote==='string'&&event.sourceQuote.trim()&&input.includes(event.sourceQuote)&&typeof event.reason==='string'&&event.reason.trim()):null;
      if(!evidence)continue;
    }else{
      const value=variableValue(conditionState,rule.conditionPath);
      if(rule.operator==='eq'?value!==rule.threshold:!finite(value)||(rule.operator==='lte'?value>rule.threshold:value<rule.threshold))continue;
    }
    let after=rule.operation==='add'?before+rule.value:rule.value;
    if(rule.type==='number'){if(!finite(after))continue;after=Math.max(rule.min,Math.min(rule.max,Math.max(before-rule.maxDelta,Math.min(before+rule.maxDelta,after))));if(Math.abs(after-before)>rule.maxDelta+Number.EPSILON*Math.max(1,Math.abs(before),Math.abs(after))*4)continue;}
    claimed.add(rule.path);if(Object.is(after,before))continue;
    if(assign(state,rule.path,after))changes.push({ruleId:rule.id,path:rule.path,kind:'update',before,after,reason:evidence?evidence.reason.slice(0,1000):rule.name,sourceQuote:evidence?evidence.sourceQuote.slice(0,12000):''});
  }
  return {state,changes};
}
