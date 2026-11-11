import {getCodexModels} from '../integrations/xiaoxi/tools/codex-bridge.mjs';
import {findCodexCli} from './codex-cli.mjs';
import {WorkbenchError} from './contracts.mjs';

// This is the local client's model catalog, not an account entitlement check.
export function createCodexModelCatalog({load=()=>getCodexModels(findCodexCli()),now=Date.now,maxAgeMs=300000}={}){
  let cached=null,expires=0,pending=null;
  return async()=>{
    if(cached&&now()<expires)return structuredClone(cached);
    if(!pending)pending=Promise.resolve().then(load).then(result=>{
      const seen=new Set();
      const models=(Array.isArray(result)?result:[]).filter(model=>{
        if(!model||typeof model.id!=='string'||!/^gpt-[a-z0-9._-]{1,180}$/i.test(model.id)||seen.has(model.id))return false;
        seen.add(model.id);return true;
      }).map(model=>({id:model.id,label:typeof model.label==='string'&&model.label.trim()?model.label.trim().slice(0,160):model.id,
        reasoningLevels:Array.isArray(model.reasoningLevels)?model.reasoningLevels.filter(value=>['low','medium','high','xhigh','max','ultra'].includes(value)):[]}));
      if(!models.length)throw new WorkbenchError(503,'暂时无法读取 Codex GPT 模型列表。请展开“本机 Codex 检查”确认 CLI、版本与登录状态，再重新读取。');
      cached=models;expires=now()+maxAgeMs;return models;
    }).catch(error=>{if(error instanceof WorkbenchError)throw error;throw new WorkbenchError(503,'Codex 模型列表读取失败。请展开“本机 Codex 检查”，核对 CLI 是否安装及版本是否兼容。');}).finally(()=>{pending=null;});
    return structuredClone(await pending);
  };
}

export const listCodexModels=createCodexModelCatalog();
