import {createHash} from 'node:crypto';
import {WorkbenchError, object, text} from '../contracts.mjs';
import {cleanJSON} from './settings.mjs';

function stableRequestId(characterId,requestId){
  const bytes=createHash('sha256').update('character-life:drawing\0'+characterId+'\0'+requestId).digest();
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.subarray(0,16).toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Reuses the drawing module's durable request IDs, queue tracking and archived images. */
export function createDrawingTool({drawing,store,baseUrl,pollIntervalMs=1000,timeoutMs=180000}){
  return async function invoke(args={},context={}){
    const {signal}=context;
    if(signal?.aborted)throw new WorkbenchError(409,'绘图等待已取消。');
    if(!store.module('drawing').enabled)throw new WorkbenchError(409,'请先启用工作台角色绘图模块。');
    const input=cleanJSON(object(args,'绘图参数'),'绘图参数',64000);
    const workflowId=text(input.workflowId||context.workflowId,'绘图工作流',100);
    const characterId=text(context.characterId,'绘图角色',100);
    const requestId=stableRequestId(characterId,text(context.requestId,'绘图调用标识',500));
    const values=object(input.values??{},'工作流参数');
    if(input.prompt!==undefined){
      const prompt=text(input.prompt,'绘图提示词',12000),fields=drawing.workflow(workflowId).fields;
      const candidates=fields.filter(field=>field.type==='text'&&/^(text|prompt|positive_prompt)$/.test(field.input)&&!/(negative|负向|负面)/i.test(field.group||''));
      const field=context.promptField?fields.find(field=>field.key===context.promptField&&field.type==='text'):candidates.length===1?candidates[0]:null;
      if(!field)throw new WorkbenchError(400,'请在工作台绘图工具中选择明确的提示词字段。');
      if(Object.hasOwn(values,field.key)&&values[field.key]!==prompt)throw new WorkbenchError(400,'提示词与工作流参数冲突，请只提供一份内容。');
      values[field.key]=prompt;
    }
    const fingerprint=createHash('sha256').update(JSON.stringify({workflowId,values})).digest('hex');
    const recordKey='characterLife.drawing.'+requestId,prior=store.getSetting(recordKey);
    if(prior&&prior.fingerprint!==fingerprint)throw new WorkbenchError(409,'同一绘图调用的参数已变化，请核实原任务后重新发起。');
    store.setSetting(recordKey,{fingerprint,workflowId,characterId});
    let job=null,timer,listener;
    const failure=(status,message,drawingStatus=job?.status||'unknown')=>{
      const error=new WorkbenchError(status,message);error.jobId=job?.id||null;error.requestId=requestId;error.drawingStatus=drawingStatus;return error;
    };
    const cancelled=new Promise((_,reject)=>{
      listener=()=>reject(failure(409,`绘图等待已取消；任务仍可能继续，请在角色绘图中查看。请求标识：${requestId}`));
      signal?.addEventListener('abort',listener,{once:true});
      timer=setTimeout(()=>reject(failure(504,`绘图等待超时；任务仍可能继续，请在角色绘图中查看，请勿重复提交。请求标识：${requestId}`)),timeoutMs);
    });
    const wait=operation=>Promise.race([operation,cancelled]);
    const owned=next=>{
      if(!next||next.requestId!==requestId||next.characterId!==characterId||next.workflowId!==workflowId||job&&next.id!==job.id)throw failure(409,'绘图任务归属不匹配，已停止等待。');
      job=next;
    };
    try{
      owned(await wait(drawing.submit({requestId,workflowId,values,characterId})));
      while(true){
        if(job.status==='completed'){
          if(!Array.isArray(job.images)||!job.images.length)throw failure(502,'绘图任务没有可用图片，请在角色绘图中核实。');
          const images=job.images.map(item=>{
            const path=`/api/modules/drawing/images/${item.id}`;
            if(!/^[A-Za-z0-9-]+$/.test(item.id)||item.jobId!==job.id||item.url!==path)throw failure(502,'绘图图片归属或归档地址无效。');
            return {id:item.id,url:new URL(path,baseUrl()).href,mime:item.mime};
          });
          return {status:'completed',jobId:job.id,requestId,workflowId,url:images[0].url,images,...(job.warning?{warning:job.warning}:{})};
        }
        if(['failed','cancelled'].includes(job.status))throw failure(502,job.error||`绘图任务${job.status==='cancelled'?'已取消':'失败'}，未返回图片。`);
        if(job.status==='unknown')throw failure(409,`绘图任务状态尚未确认，请在角色绘图中核实，请勿重复提交。任务：${job.id}`);
        if(!['submitting','queued','running'].includes(job.status))throw failure(502,'绘图任务状态无效，请在角色绘图中核实。');
        owned(await wait(drawing.syncJob(job.id)));
        if(['submitting','queued','running'].includes(job.status)){
          let pause;
          try{await wait(new Promise(resolve=>{pause=setTimeout(resolve,pollIntervalMs);}));}finally{clearTimeout(pause);}
        }
      }
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',listener);}
  };
}
