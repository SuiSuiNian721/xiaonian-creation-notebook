import { WorkbenchError, fields, text } from './contracts.mjs';

export const DEFAULT_AI_CONNECTION=Object.freeze({provider:'codex',enabled:false,baseUrl:'',model:'',apiKey:'',reasoningEffort:'',mcpEnabled:false});
export const DEFAULT_MODULE_CONNECTION=Object.freeze({provider:'',enabled:null,baseUrl:'',model:'',apiKey:'',reasoningEffort:'',keyMode:'inherit'});
const EFFORTS=['','low','medium','high','xhigh','max','ultra'];

export function publicConnection(config){const {apiKey,...rest}=config;return {...rest,hasKey:!!apiKey};}

export function mergeModuleConnection(global,override){
  const result={...global};
  for(const field of ['provider','baseUrl','model','reasoningEffort'])if(override[field])result[field]=override[field];
  if(typeof override.enabled==='boolean')result.enabled=override.enabled;
  if(override.keyMode==='none')result.apiKey='';
  if(override.keyMode==='custom')result.apiKey=override.apiKey||'';
  return result;
}

export function validateConnection(config){
  if(config.provider==='openai'&&config.enabled){
    let url;try{url=new URL(config.baseUrl);}catch{throw new WorkbenchError(400,'请填写有效的 API Base URL，或在全局设置中补全继承值。');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw new WorkbenchError(400,'API 地址格式无效。');
    if(!config.model)throw new WorkbenchError(400,'请填写模型名称，或在全局设置中补全继承值。');
  }
  return config;
}

export function normalizeConnection(value,previous,{module=false}={}){
  fields(value,['provider','enabled','baseUrl','model','apiKey','clearKey','reasoningEffort',...(module?['keyMode']:['mcpEnabled'])]);
  const next={...previous};
  if(value.provider!==undefined){
    if(!(module?['','codex','openai']:['codex','openai']).includes(value.provider))throw new WorkbenchError(400,'请选择 Codex 桥接或 OpenAI 兼容 API。');
    next.provider=value.provider;
  }
  if(value.enabled!==undefined){
    if(typeof value.enabled!=='boolean'&&!(module&&value.enabled===null))throw new WorkbenchError(400,'启用状态必须是布尔值，模块可用 null 继承全局。');
    next.enabled=value.enabled;
  }
  if(!module&&value.mcpEnabled!==undefined){if(typeof value.mcpEnabled!=='boolean')throw new WorkbenchError(400,'MCP 启用状态必须是布尔值。');next.mcpEnabled=value.mcpEnabled;}
  for(const field of ['baseUrl','model','reasoningEffort'])if(value[field]!==undefined)next[field]=text(value[field],field,2048,{empty:true});
  if(!EFFORTS.includes(next.reasoningEffort))throw new WorkbenchError(400,'思考档位无效。');
  if(module&&value.keyMode!==undefined){
    if(!['inherit','custom','none'].includes(value.keyMode))throw new WorkbenchError(400,'请选择全局密钥、独立密钥或不使用密钥。');
    next.keyMode=value.keyMode;
  }
  if(value.apiKey!==undefined){
    const key=text(value.apiKey,'API Key',4096,{empty:true});
    if(key){next.apiKey=key;if(module&&value.keyMode===undefined)next.keyMode='custom';}
  }
  if(value.clearKey!==undefined&&typeof value.clearKey!=='boolean')throw new WorkbenchError(400,'清除密钥状态必须是布尔值。');
  if(value.clearKey){next.apiKey='';if(module)next.keyMode='inherit';}
  if(module&&next.keyMode==='custom'&&!next.apiKey)throw new WorkbenchError(400,'请填写本模块 API Key，或选择继承全局／不使用密钥。');
  return module?next:validateConnection(next);
}
