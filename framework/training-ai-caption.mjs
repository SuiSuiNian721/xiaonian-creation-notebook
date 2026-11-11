import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {WorkbenchError} from './contracts.mjs';
import {compatibleCaption,readProcessedDataset,regularLocal} from './training-dataset.mjs';
import {trainingProcessExists} from './training-runtime.mjs';
import {styleTags} from './training-strategies.mjs';
import {buildCaptionPrompt} from '../public-workbench/training-caption-prompts.js';

const imageLimit=8*1024*1024,captionLimit=128*1024;
const digest=value=>createHash('sha256').update(value).digest('hex');
const check=signal=>{if(signal?.aborted)throw new WorkbenchError(409,'AI 图集标注已取消。');};
const textPath=(dataset,item)=>join(dataset.imageDir,item.name.slice(0,-extname(item.name).length)+'.txt');

export function buildTrainingCaptionMessages({input={},plan={}}={}){
  return [
    {role:'system',content:buildCaptionPrompt({purpose:plan.purpose||input.purpose||'character',captionFormat:plan.strategy?.captionFormat||'tags',trigger:plan.trigger||'',supplement:input.aiCaptionPrompt||''})},
    {role:'user',content:'请查看所附的当前训练图片，按上述用途和格式返回这一张图片的标注正文。'},
  ];
}

async function existingFile(path,limit){
  try{
    const info=await regularLocal(path);
    if(info.size>limit)throw new WorkbenchError(413,'AI 标注工作文件超过读取限制。');
    const bytes=await readFile(path);
    if(bytes.length>limit)throw new WorkbenchError(413,'AI 标注工作文件超过读取限制。');
    return bytes;
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function replaceFile(path,bytes,previousHash,signal){
  check(signal);await regularLocal(dirname(path),true);
  const existing=await existingFile(path,path.endsWith('.json')?16*1024*1024:captionLimit);
  if((existing?digest(existing):null)!==previousHash)throw new WorkbenchError(409,'标注工作文件已改变，已保留当前文件并停止提交。');
  const temporary=path+'.tmp-'+randomUUID();
  try{
    await writeFile(temporary,bytes,{flag:'wx'});check(signal);
    await regularLocal(dirname(path),true);
    const current=await existingFile(path,path.endsWith('.json')?16*1024*1024:captionLimit);
    if((current?digest(current):null)!==previousHash)throw new WorkbenchError(409,'标注工作文件已改变，已停止提交。');
    check(signal);await rename(temporary,path);
  }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return digest(bytes);
}

async function acquireLock(workspace,owner){
  const path=join(workspace,'.ai-caption.lock'),token=randomUUID();
  for(let attempt=0;attempt<2;attempt++){
    try{
      await writeFile(path,JSON.stringify({owner,pid:process.pid,token}),{encoding:'utf8',flag:'wx'});
      return async()=>{const value=await existingFile(path,4096);if(value&&JSON.parse(value).token===token)await unlink(path);};
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const bytes=await existingFile(path,4096);let holder;
      try{holder=JSON.parse(bytes);}catch{throw new WorkbenchError(409,'图集标注锁尚未就绪，请稍后重试。');}
      if(holder?.owner!==owner||!Number.isSafeInteger(holder.pid)||holder.pid<=0||trainingProcessExists(holder.pid))throw new WorkbenchError(409,'当前图集正在标注，请等待当前请求结束后继续。');
      await unlink(path);
    }
  }
  throw new WorkbenchError(409,'未能取得图集标注锁，请稍后重试。');
}

async function imageBytes(dataset,item){
  const path=join(dataset.imageDir,item.name),info=await regularLocal(path);
  if(info.size>imageLimit)throw new WorkbenchError(413,`AI 标注图片超过 8 MiB：${item.name}。请缩小副本后重新建立流程，或选择本地标注。`);
  const bytes=await readFile(path);
  if(bytes.length>imageLimit)throw new WorkbenchError(413,`AI 标注图片超过 8 MiB：${item.name}`);
  if(digest(bytes)!==item.sha256)throw new WorkbenchError(409,`工作副本的图片已改变：${item.name}`);
  const suffix=extname(item.name).toLowerCase();
  const valid=suffix==='.png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
    :['.jpg','.jpeg'].includes(suffix)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg'
    :suffix==='.webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!valid)throw new WorkbenchError(422,`AI 标注只支持有效的 PNG、JPEG、WebP：${item.name}。其他格式请使用本地标注。`);
  return {bytes,mime:valid,suffix};
}

async function verifyImage(dataset,item,signal){
  const path=join(dataset.imageDir,item.name);await regularLocal(path);
  const hash=createHash('sha256');
  for await(const bytes of createReadStream(path)){check(signal);hash.update(bytes);}
  if(hash.digest('hex')!==item.sha256)throw new WorkbenchError(409,`工作副本的图片已改变：${item.name}`);
}

async function verifyCaptions(dataset,format,signal){
  for(const item of dataset.items){
    check(signal);await verifyImage(dataset,item,signal);
    const bytes=await existingFile(textPath(dataset,item),captionLimit);
    if(!bytes||item.requiresCaption||item.captionImageSha256!==item.sha256||item.captionFormat!==format||digest(bytes)!==item.captionSha256)throw new WorkbenchError(409,`标注文件已改变或未通过当前图片校验：${item.name}`);
  }
}

async function ask(sharedAI,messages,images,{signal,timeoutMs}){
  check(signal);const controller=new AbortController();let timer,cancel;
  const stopped=new Promise((_,reject)=>{
    cancel=()=>{controller.abort();reject(new WorkbenchError(409,'AI 图集标注已取消。'));};
    signal?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>{controller.abort();reject(new WorkbenchError(504,'AI 图集标注请求超时，可继续流程重试当前图片。'));},timeoutMs);
    if(signal?.aborted)cancel();
  });
  try{return await Promise.race([Promise.resolve().then(()=>{check(signal);return sharedAI.complete(messages,{moduleId:'training',policy:'chat-only-vision',images,signal:controller.signal,timeoutMs});}),stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
}

function captionText(value,{format,purpose,trigger,suppressTags=[]}){
  if(typeof value!=='string'||Buffer.byteLength(value)>captionLimit||!value.trim())throw new WorkbenchError(422,'AI 没有返回有效的非空标注正文。');
  let text=value.trim();
  if(text.startsWith('```')||/^[\[{]/.test(text)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new WorkbenchError(422,'AI 标注格式无效，请只返回标注正文。');
  text=text.replace(/\s+/g,' ');
  if(!compatibleCaption(text,format))throw new WorkbenchError(422,`AI 标注不符合当前${format==='natural'?'自然语言':'标签'}格式，请重试当前图片。`);
  if(format==='tags'){
    const excluded=new Set(purpose==='style'?[...styleTags,...suppressTags].map(value=>value.replaceAll('_',' ').toLowerCase()):[]);
    const values=[...new Set(text.split(',').map(value=>value.trim()).filter(value=>value&&value!==trigger&&!excluded.has(value.replaceAll('_',' ').toLowerCase())))];
    if(!values.length)throw new WorkbenchError(422,'用途规则处理后没有有效标注，请重试当前图片。');
    if(trigger)values.unshift(trigger);text=values.join(', ');
  }else{
    if(purpose==='style')text=text.replace(/^(?:a|an|the)\s+(?:(?:watercolor|oil|digital|traditional|black and white)\s+)*(?:painting|illustration|drawing|sketch|photograph)\s+of\s+/i,'The image shows ');
    if(trigger&&!text.startsWith(trigger+'.'))text=trigger+'. '+text;
  }
  return text+'\n';
}

/** Only the prepared workflow copy is writable; no source path is opened for writing. */
export async function captionTrainingDataset({dataset,owner,requestId,input={},plan={},sharedAI,signal,onProgress,timeoutMs=90000}){
  check(signal);
  if(!dataset||dataset.format!==2||typeof owner!=='string'||dataset.owner!==owner||typeof dataset.workspace!=='string'||typeof dataset.imageDir!=='string'||resolve(dataset.imageDir)!==join(resolve(dataset.workspace),'images'))throw new WorkbenchError(409,'AI 标注图集不属于当前受管流程。');
  if(typeof requestId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(requestId))throw new WorkbenchError(400,'AI 标注请求编号无效。');
  const format=plan.strategy?.captionFormat||'tags',purpose=plan.purpose||input.purpose||'character',trigger=plan.trigger||'',policy=input.captionPolicy||'fill-missing';
  if(!['tags','natural'].includes(format)||!['character','style','pose'].includes(purpose)||!['existing','fill-missing','regenerate'].includes(policy)||typeof trigger!=='string'||trigger.length>120||/[\r\n\u0000-\u001f]/.test(trigger))throw new WorkbenchError(400,'AI 标注用途、格式或触发词无效。');
  if(input.aiCaptionPrompt!==undefined&&(typeof input.aiCaptionPrompt!=='string'||input.aiCaptionPrompt.length>12000))throw new WorkbenchError(400,'AI 标注补充要求须为不超过 12000 字符的文字。');
  if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw new WorkbenchError(400,'AI 标注超时配置无效。');
  await regularLocal(dataset.workspace,true);await regularLocal(dataset.imageDir,true);
  const release=await acquireLock(dataset.workspace,owner);
  try{
    const manifestPath=join(dataset.workspace,'dataset-manifest.json');
    const originalBytes=await existingFile(manifestPath,16*1024*1024);
    if(!originalBytes)throw new WorkbenchError(409,'受管图集清单不存在。');
    const manifest=await readProcessedDataset(dataset,owner,null);
    const identity=items=>JSON.stringify(items.map(({name,source,sha256,kind,originalCaption})=>({name,source,sha256,kind,originalCaption})));
    if(identity(manifest.items)!==identity(dataset.items)||manifest.format!==2||!manifest.items.length)throw new WorkbenchError(409,'受管图集清单已改变，请重新建立流程。');
    const messages=buildTrainingCaptionMessages({input,plan}),recipe=digest(JSON.stringify({messages,policy,format,purpose,trigger,suppressTags:plan.strategy?.suppressTags||[]}));
    if(manifest.captions?.requestId===requestId&&manifest.captions.recipe!==recipe)throw new WorkbenchError(409,'同一标注请求的用途或提示词已经改变，请新建流程。');
    let manifestHash=digest(originalBytes),completed=0,generatedCount=0,reusedCount=0;
    const save=async(complete=false)=>{
      manifest.captions={complete,requestId,format,purpose,recipe,model:'shared-ai',completed,total:manifest.items.length,generatedCount,reusedCount,warnings:[]};
      manifest.captioned=manifest.items.filter(item=>!item.requiresCaption).length;manifest.missing=manifest.items.length-manifest.captioned;
      manifestHash=await replaceFile(manifestPath,Buffer.from(JSON.stringify(manifest,null,2)+'\n'),manifestHash,signal);
    };
    const progress=async current=>{check(signal);await onProgress?.({completed,total:manifest.items.length,current,generatedCount,reusedCount});check(signal);};
    // A failed or cancelled request always leaves an explicit incomplete marker.
    await save();
    for(const item of manifest.items){
      check(signal);
      await verifyImage(manifest,item,signal);
      const path=textPath(manifest,item),previous=await existingFile(path,captionLimit),previousHash=previous?digest(previous):null;
      if(item.captionSha256&&previousHash!==item.captionSha256)throw new WorkbenchError(409,`工作标注已改变或校验失败：${item.name}`);
      const existing=previous?new TextDecoder('utf-8',{fatal:true}).decode(previous).trim():'';
      const bound=!item.requiresCaption&&item.captionImageSha256===item.sha256&&item.captionFormat===format&&item.captionSha256===previousHash&&compatibleCaption(existing,format);
      if(bound&&item.captionRequestId===requestId&&item.captionRecipe===recipe){
        completed++;if(item.captionAction==='generated')generatedCount++;else reusedCount++;
        await save();await progress(item.name);continue;
      }
      const reuse=policy!=='regenerate'&&bound;let caption,action;
      if(reuse){caption=captionText(existing,{format,purpose,trigger,suppressTags:plan.strategy?.suppressTags});action='reused';}
      else{
        if(policy==='existing')throw new WorkbenchError(422,`${item.name} 需要重新标注，但当前仅允许已有标注。`);
        if(typeof sharedAI?.complete!=='function')throw new WorkbenchError(409,'请启用训练模块或全局 AI 接入后继续图集标注。');
        const image=await imageBytes(manifest,item);
        const temporary=join(manifest.workspace,'.ai-caption-input-'+randomUUID()+image.suffix);
        try{
          await writeFile(temporary,image.bytes,{flag:'wx'});check(signal);
          const answer=await ask(sharedAI,messages,[{path:temporary,mime:image.mime}],{signal,timeoutMs});check(signal);
          caption=captionText(answer?.text,{format,purpose,trigger,suppressTags:plan.strategy?.suppressTags});action='generated';
        }finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      }
      check(signal);await verifyImage(manifest,item,signal);
      const captionSha256=await replaceFile(path,Buffer.from(caption),previousHash,signal);
      Object.assign(item,{requiresCaption:false,captionFormat:format,captionPurpose:purpose,captionImageSha256:item.sha256,captionSha256,captionRequestId:requestId,captionRecipe:recipe,captionAction:action});
      completed++;if(action==='generated')generatedCount++;else reusedCount++;
      await save();await progress(item.name);
    }
    check(signal);await verifyCaptions(manifest,format,signal);await save(true);
    return await readProcessedDataset(dataset,owner,null,{captionRequestId:requestId,captionFormat:format});
  }finally{await release();}
}
