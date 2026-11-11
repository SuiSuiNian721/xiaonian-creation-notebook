import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {link,mkdir,open,readFile,rm,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {WorkbenchError} from './contracts.mjs';
import {checkedLocalPath,insideDirectory} from './drawing-files.mjs';
import {ordinaryFile} from './vision-download.mjs';
import {inspectVoiceModel,voiceModelIdentity} from './voice-providers.mjs';

const OWNER='AI-Future-Workbench/qwen-model';
const MAX_SMALL=8*1024*1024,MAX_SMALL_TOTAL=32*1024*1024,MAX_FILES=128,MAX_TOTAL=64*1024**3;
const digest=(value,algorithm='sha256')=>createHash(algorithm).update(value).digest('hex');
const names={base:'Base','custom-voice':'CustomVoice','voice-design':'VoiceDesign'};
export const QWEN_DOWNLOAD_PRESETS=Object.entries(names).map(([modelKind,name])=>({modelKind,name,sizes:modelKind==='voice-design'?['1.7B']:['0.6B','1.7B']}));
export function qwenModelPreset(modelKind,size){
  const preset=QWEN_DOWNLOAD_PRESETS.find(item=>item.modelKind===modelKind);
  if(!preset||!preset.sizes.includes(size))throw new WorkbenchError(400,'模型规格无效；VoiceDesign 仅支持 1.7B。');
  return {...preset,size,repository:`Qwen/Qwen3-TTS-12Hz-${size}-${preset.name}`,basename:`Qwen3-TTS-12Hz-${size}-${preset.name}`};
}
function abortable(promise,signal){
  signal.throwIfAborted();return new Promise((done,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);done(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
async function boundedFetch(url,{fetchImpl,signal,maxBytes,expectedBytes,budget}){
  if(++budget.requests>MAX_FILES+1)throw new WorkbenchError(502,'模型清单请求超过预算。');
  const combined=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const response=await abortable(fetchImpl(url,{signal:combined,headers:{'accept-encoding':'identity'}}),combined);
  if(!response.ok)throw new WorkbenchError(502,`Hugging Face 清单请求返回 ${response.status}。`);
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBytes))throw new WorkbenchError(502,'模型元数据响应超过读取预算。');
  const parts=[];let bytes=0,reader;
  try{
    if(!response.body)throw new WorkbenchError(502,'模型清单响应没有内容。');reader=response.body.getReader();
    while(true){const item=await abortable(reader.read(),combined);if(item.done)break;bytes+=item.value.byteLength;if(bytes>maxBytes)throw new WorkbenchError(502,'模型元数据响应超过读取预算。');parts.push(Buffer.from(item.value));}
  }finally{await reader?.cancel().catch(()=>{});}
  if(expectedBytes!==undefined&&bytes!==expectedBytes)throw new WorkbenchError(502,'小配置文件长度与固定版本清单不一致。');
  budget.bytes+=bytes;return Buffer.concat(parts);
}
const smallName=/^(?:config|generation_config|preprocessor_config|processor_config|tokenizer_config|tokenizer|special_tokens_map|added_tokens|vocab|chat_template|model\.safetensors\.index)\.json$|^(?:merges\.txt|tokenizer\.model|LICENSE(?:\.txt)?)$/;
const weightName=/^model(?:-\d+-of-\d+)?\.safetensors$/;
function selectedFile(filename){
  if(typeof filename!=='string'||filename.length>512)return false;
  const parts=filename.split('/');if(parts.length>2||parts.length===2&&parts[0]!=='speech_tokenizer')return false;
  return smallName.test(parts.at(-1))||weightName.test(parts.at(-1));
}
function safeName(filename){
  if(filename.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"\\|?*\u0000-\u001f]/.test(part)||/[. ]$/.test(part)))throw new WorkbenchError(502,'模型清单包含无效文件路径。');
  return filename;
}
const fileUrl=(repository,revision,filename)=>`https://huggingface.co/${repository}/resolve/${revision}/${filename.split('/').map(encodeURIComponent).join('/')}`;
const fingerprint=plan=>digest(JSON.stringify([plan.repository,plan.revision,plan.modelKind,plan.size,plan.files.map(({filename,bytes,sha256})=>[filename,bytes,sha256])]));

/** Explicit user action only. No weight bytes are fetched while preparing. */
export async function prepareQwenModelPlan({modelKind,size,directory,fetchImpl=fetch,signal}={}){
  const preset=qwenModelPreset(modelKind,size),rootDirectory=await checkedLocalPath(directory),budget={requests:0,bytes:0};
  const combined=AbortSignal.any([signal,AbortSignal.timeout(120000)]),metadataUrl=`https://huggingface.co/api/models/${preset.repository}/revision/main?blobs=true`;
  const raw=await boundedFetch(metadataUrl,{fetchImpl,signal:combined,maxBytes:2*1024*1024,budget});let metadata;
  try{metadata=JSON.parse(raw.toString('utf8'));}catch{throw new WorkbenchError(502,'Hugging Face 模型清单不是有效 JSON。');}
  if(!/^[a-f0-9]{40}$/.test(metadata.sha)||!Array.isArray(metadata.siblings)||metadata.siblings.length>2000||metadata.private||metadata.gated||metadata.id&&metadata.id!==preset.repository)throw new WorkbenchError(502,'模型清单未提供可用的公开固定 revision 与文件列表。');
  const files=[],seen=new Set();let smallBytes=0,total=0;
  for(const item of metadata.siblings){
    if(!selectedFile(item.rfilename))continue;
    const filename=safeName(item.rfilename),bytes=item.size??item.lfs?.size,isWeight=weightName.test(filename.split('/').at(-1));
    if(seen.has(filename.toLowerCase())||!Number.isSafeInteger(bytes)||bytes<0||item.lfs?.size!==undefined&&item.lfs.size!==bytes)throw new WorkbenchError(502,'模型文件清单大小无效或重复。');seen.add(filename.toLowerCase());
    if(isWeight&&(!/^[a-f0-9]{64}$/.test(item.lfs?.sha256||'')||!bytes))throw new WorkbenchError(502,`${filename} 缺少可信 lfs.sha256，不能把 Git blobId 当作文件 SHA256。`);
    if(!isWeight){smallBytes+=bytes;if(bytes>MAX_SMALL||smallBytes>MAX_SMALL_TOTAL)throw new WorkbenchError(502,'模型小配置文件超过读取预算。');}
    total+=bytes;if(files.length>=MAX_FILES||total>MAX_TOTAL)throw new WorkbenchError(502,'模型清单超过下载预算。');
    files.push({filename,bytes,sha256:/^[a-f0-9]{64}$/.test(item.lfs?.sha256||'')?item.lfs.sha256:null,gitBlobId:item.blobId||null,hashSource:item.lfs?.sha256?'lfs.sha256':'git-blob',isWeight,url:fileUrl(preset.repository,metadata.sha,filename)});
  }
  const required=['config.json','generation_config.json','tokenizer_config.json','speech_tokenizer/config.json'];
  if(required.some(name=>!seen.has(name))||!files.some(file=>file.isWeight&&!file.filename.includes('/'))||!files.some(file=>file.isWeight&&file.filename.startsWith('speech_tokenizer/'))||!seen.has('tokenizer.json')&&!(seen.has('vocab.json')&&seen.has('merges.txt')))throw new WorkbenchError(502,'固定版本缺少模型、文字分词器或 speech_tokenizer 的必要文件。');
  const contents=new Map();
  for(const file of files.filter(file=>!file.isWeight)){
    const content=await boundedFetch(file.url,{fetchImpl,signal:combined,maxBytes:MAX_SMALL,expectedBytes:file.bytes,budget});
    if(file.hashSource==='lfs.sha256'){
      if(digest(content)!==file.sha256)throw new WorkbenchError(502,`${file.filename} 的 SHA256 校验失败。`);
    }else{
      const algorithm=/^[a-f0-9]{40}$/.test(file.gitBlobId||'')?'sha1':/^[a-f0-9]{64}$/.test(file.gitBlobId||'')?'sha256':null;
      if(!algorithm||createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest('hex')!==file.gitBlobId)throw new WorkbenchError(502,`${file.filename} 的 Git blob 身份校验失败。`);
      file.sha256=digest(content);
    }
    contents.set(file.filename,content);
  }
  let config;try{config=JSON.parse(contents.get('config.json').toString('utf8'));}catch{throw new WorkbenchError(502,'远端模型配置无效。');}
  const identity=voiceModelIdentity(config);if(identity.provider!=='qwen3-tts'||identity.kind!==modelKind||identity.status)throw new WorkbenchError(502,'远端配置声明的模型用途与所选 Qwen 规格不一致。');
  for(const file of files.filter(file=>file.filename.endsWith('.index.json'))){
    let index;try{index=JSON.parse(contents.get(file.filename).toString('utf8'));}catch{}
    if(!index?.weight_map||typeof index.weight_map!=='object'||Array.isArray(index.weight_map)||!Object.keys(index.weight_map).length)throw new WorkbenchError(502,'模型分片清单无效。');
    const prefix=file.filename.includes('/')?'speech_tokenizer/':'';
    for(const shard of Object.values(index.weight_map))if(typeof shard!=='string'||!weightName.test(shard)||!seen.has((prefix+shard).toLowerCase()))throw new WorkbenchError(502,'固定版本清单缺少模型索引声明的分片。');
  }
  for(const prefix of ['','speech_tokenizer/'])if(files.some(file=>file.isWeight&&file.filename.startsWith(prefix)&&file.filename.slice(prefix.length).indexOf('/')<0&&file.filename!==prefix+'model.safetensors')&&!seen.has(prefix+'model.safetensors.index.json'))throw new WorkbenchError(502,'分片模型缺少对应的索引清单。');
  files.sort((a,b)=>a.filename.localeCompare(b.filename));
  const plan={provider:'qwen3-tts',modelKind,size,repository:preset.repository,revision:metadata.sha,metadataUrl,rootDirectory,directory:await insideDirectory(rootDirectory,'components','qwen3-tts',preset.basename,metadata.sha),files,downloadBytes:total,diskPeakBytes:total,diskPeakBasis:'分片校验后原地发布，无解压或第二份权重副本；已有其他模型另计。',preparedMetadataBytes:budget.bytes,status:'prepared',createdAt:new Date().toISOString()};
  plan.manifestSha256=fingerprint(plan);plan.id='qwen-model-'+plan.manifestSha256;return plan;
}

async function hashFile(path,signal,hash=createHash('sha256')){for await(const chunk of createReadStream(path,{signal}))hash.update(chunk);return hash;}
async function publishFile(partial,target,signal){
  await checkedLocalPath(partial);await checkedLocalPath(target);signal.throwIfAborted();
  try{await link(partial,target);}
  catch(error){
    if(error.code==='EEXIST')throw new WorkbenchError(409,'模型目标已出现同名文件，原文件与已校验的部分下载均已保留。');
    if(['ENOTSUP','EOPNOTSUPP','EXDEV','EPERM','ENOSYS'].includes(error.code))throw new WorkbenchError(409,'目标文件系统无法安全发布模型；部分下载已保留，请改用支持硬链接的本地磁盘。');
    throw error;
  }
  // link creates a new name atomically and never replaces an existing target.
  // Unlink only the controller-owned temporary name after successful publication.
  await unlink(partial);
}
async function downloadFile(file,target,{fetchImpl,signal,idleTimeoutMs,onProgress,onStage}){
  const existing=await ordinaryFile(target);
  if(existing){if(existing.size===file.bytes&&(await hashFile(target,signal)).digest('hex')===file.sha256){onProgress(file.bytes);return;}throw new WorkbenchError(409,`${file.filename} 已存在且校验不符，原文件已保留。`);}
  const partial=target+'.part',partialInfo=await ordinaryFile(partial);let offset=partialInfo?.size||0,hash=createHash('sha256');
  if(offset>file.bytes){await checkedLocalPath(partial);await rm(partial);offset=0;}
  if(offset)hash=await hashFile(partial,signal,hash);
  if(offset===file.bytes){if(hash.digest('hex')!==file.sha256){await checkedLocalPath(partial);await rm(partial,{force:true});throw new WorkbenchError(502,`${file.filename} 的 SHA256 校验失败。`);}signal.throwIfAborted();if(!file.bytes&&!partialInfo){await checkedLocalPath(partial);const empty=await open(partial,'wx');await empty.close();}await publishFile(partial,target,signal);onProgress(file.bytes);return;}
  const controller=new AbortController(),combined=AbortSignal.any([signal,controller.signal]);let timer,reader,handle;
  const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>controller.abort(new WorkbenchError(504,'模型下载长时间没有响应，可使用原计划续传。')),idleTimeoutMs);};
  try{
    signal.throwIfAborted();touch();const response=await abortable(fetchImpl(file.url,{signal:combined,headers:{'accept-encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})}}),combined);
    if(![200,206].includes(response.status))throw new WorkbenchError(502,`模型下载返回 HTTP ${response.status}。`);
    if(response.headers.get('content-encoding')&&response.headers.get('content-encoding')!=='identity')throw new WorkbenchError(502,'模型下载响应不支持压缩传输。');
    if(response.status===206){const match=response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);if(!match||Number(match[1])!==offset||Number(match[2])!==file.bytes-1||Number(match[3])!==file.bytes)throw new WorkbenchError(502,'模型续传范围与固定文件清单不一致。');}
    else if(offset){offset=0;hash=createHash('sha256');}
    const length=response.headers.get('content-length');if(length!==null&&Number(length)!==file.bytes-offset)throw new WorkbenchError(502,'模型下载长度与固定清单不一致。');
    if(!response.body)throw new WorkbenchError(502,'模型下载响应没有内容。');
    await checkedLocalPath(partial);handle=await open(partial,offset?'a':'w');reader=response.body.getReader();onStage('downloading');onProgress(offset);
    while(true){touch();const item=await abortable(reader.read(),combined);if(item.done)break;if(offset+item.value.byteLength>file.bytes)throw new WorkbenchError(502,'模型响应超过固定文件长度。');await handle.writeFile(item.value);hash.update(item.value);offset+=item.value.byteLength;onProgress(offset);}
    await handle.close();handle=null;signal.throwIfAborted();if(offset!==file.bytes)throw new WorkbenchError(502,'模型未下载完整，可使用原计划续传。');
    onStage('verifying');if(hash.digest('hex')!==file.sha256){await checkedLocalPath(partial);await rm(partial);throw new WorkbenchError(502,`${file.filename} 的 SHA256 校验失败。`);}
    await publishFile(partial,target,signal);
  }finally{clearTimeout(timer);controller.abort();await reader?.cancel().catch(()=>{});await handle?.close().catch(()=>{});}
}

/** Caller holds the shared voice installation lock. Never changes a manual binding. */
export async function downloadQwenModelPlan({plan,directory,fetchImpl=fetch,signal,createRecord,onProgress=()=>{},onStage=()=>{},idleTimeoutMs=30000}={}){
  if(!plan||!Array.isArray(plan.files))throw new WorkbenchError(409,'模型下载计划无效，请重新查询清单。');
  const preset=qwenModelPreset(plan.modelKind,plan.size);
  if(plan.provider!=='qwen3-tts'||plan.repository!==preset.repository||!/^[a-f0-9]{40}$/.test(plan.revision)||fingerprint(plan)!==plan.manifestSha256||plan.id!=='qwen-model-'+plan.manifestSha256||plan.rootDirectory!==await checkedLocalPath(directory))throw new WorkbenchError(409,'模型下载计划已改变，请重新查询清单。');
  const expected=await insideDirectory(directory,'components','qwen3-tts',preset.basename,plan.revision);if(expected!==plan.directory)throw new WorkbenchError(409,'模型计划目标与资料目录不一致。');
  if(!Array.isArray(plan.files)||!plan.files.length||plan.files.length>MAX_FILES||plan.files.some(file=>!selectedFile(file.filename)||!Number.isSafeInteger(file.bytes)||file.bytes<0||!/^[a-f0-9]{64}$/.test(file.sha256)||file.url!==fileUrl(plan.repository,plan.revision,file.filename)))throw new WorkbenchError(409,'模型下载清单无效。');
  await mkdir(dirname(expected),{recursive:true});const marker=await insideDirectory(expected,'.workbench-qwen-model.json');
  try{await mkdir(expected);await createRecord(marker,{owner:OWNER,planId:plan.id,repository:plan.repository,revision:plan.revision});}
  catch(error){if(error.code!=='EEXIST')throw error;const record=JSON.parse(await readFile(marker,'utf8').catch(()=>'{"owner":"unknown"}'));if(record.owner!==OWNER||record.planId!==plan.id)throw new WorkbenchError(409,'模型目标目录已有其他文件，原目录已保留。');}
  let completed=0;
  for(const file of plan.files){
    signal.throwIfAborted();const target=await insideDirectory(expected,...safeName(file.filename).split('/'));await mkdir(dirname(target),{recursive:true});
    await downloadFile(file,target,{fetchImpl,signal,idleTimeoutMs,onProgress:bytes=>onProgress(completed+bytes,file.filename),onStage:stage=>onStage(stage,file.filename)});completed+=file.bytes;
  }
  signal.throwIfAborted();onStage('checking-model');const binding=await inspectVoiceModel(expected,{provider:'qwen3-tts',kind:plan.modelKind});
  if(binding.status!=='available')throw new WorkbenchError(409,'下载后模型用途检验未通过：'+(binding.issue||binding.status));return binding;
}
