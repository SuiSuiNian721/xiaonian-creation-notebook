import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkbench } from '../framework/server.mjs';

const directory=resolve(process.env.AI_FUTURE_COMFY_QA_DIR||'qa/comfy-live');await mkdir(directory,{recursive:true});
const app=await createWorkbench({dataDir:join(directory,'data')});
async function api(path,value,method=value===undefined?'GET':'POST'){
  const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
}
await writeFile(join(directory,'runtime.json'),JSON.stringify({url:app.url,pid:process.pid}),'utf8');
try{
  await api('/api/modules/drawing/enable',{});
  const config=await api('/api/modules/drawing/discover',{});
  await api('/api/modules/drawing/config',{values:config},'PUT');
  await api('/api/modules/drawing/launch',{});
  let connected;
  for(let attempt=0;attempt<90;attempt++){try{connected=await api('/api/modules/drawing/connect',{});break;}catch{}await new Promise(resolveDelay=>setTimeout(resolveDelay,2000));}
  if(!connected)throw new Error('真实 ComfyUI 未在等待时限内就绪。');
  const report={ok:true,connection:connected.connection,config};
  const workflowFile=process.env.AI_FUTURE_COMFY_QA_WORKFLOW||'E:\\ComfyUI工作流\\MOSS-Image_SFT_INT8_8GB_文生图.json';
  const source=JSON.parse(await readFile(workflowFile,'utf8'));
  const workflow=await api('/api/modules/drawing/workflows/import',{name:'真实 ComfyUI 验收工作流',document:source});
  Object.assign(report,{workflowId:workflow.id,nodeCount:workflow.nodeCount,fieldCount:workflow.fields.length});
  if(process.argv.includes('--generate')){
    const values={};for(const field of workflow.fields){if(field.input==='steps')values[field.key]=4;if(field.input==='width'||field.input==='height'||field.input==='custom_width'||field.input==='custom_height')values[field.key]=256;if(field.input==='text')values[field.key]=field.nodeId==='4'?'A blue ceramic cup and white jasmine flowers on a wooden desk by a sunlit window, soft natural light, still life.':'watermark, blur';if(field.input==='filename_prefix')values[field.key]='AI未来工作台/ComfyUI模块验收';}
    const job=await api('/api/modules/drawing/jobs',{requestId:randomUUID(),workflowId:workflow.id,values,characterId:null});report.jobId=job.id;
    for(let attempt=0;attempt<300;attempt++){const result=await api(`/api/modules/drawing/jobs/${job.id}/refresh`,{});if(result.status==='completed'){report.job=result;break;}if(['failed','cancelled'].includes(result.status))throw new Error(result.error||result.status);await new Promise(resolveDelay=>setTimeout(resolveDelay,2000));}
    if(!report.job)throw new Error('真实生成未在等待时限内完成。');
  }
  await writeFile(join(directory,'result.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({error:error.stack},null,2),'utf8');console.error(error.message);process.exitCode=1;}
finally{await app.close();}
