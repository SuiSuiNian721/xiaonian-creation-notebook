import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { checkedLocalPath } from './drawing-files.mjs';

const categories=['checkpoints','unet','diffusion_models','loras','clip','text_encoders','vae','controlnet','upscale_models'];
const equivalent=category=>category==='unet'||category==='diffusion_models'?['unet','diffusion_models']:category==='clip'||category==='text_encoders'?['clip','text_encoders']:[category];
const comparable=value=>basename(value.replaceAll('\\','/')).toLowerCase();
const identity=value=>[value.dev,value.ino,value.birthtimeMs,value.size,value.mtimeMs,value.ctimeMs].join(':');

export async function discoverModelRoots(comfyPath,explicit=[],signal) {
  const roots=[],warnings=[];
  if(!comfyPath)return {roots,warnings:['未选择本地 ComfyUI 目录。']};
  try { await checkedLocalPath(comfyPath); } catch(error){return {roots,warnings:[error.message]};}
  for(const category of categories) roots.push({path:join(comfyPath,'models',category),category,source:'comfy-models'});
  try {
    const file=join(comfyPath,'extra_model_paths.yaml');const data=await readFile(file,'utf8');if(data.length>1024*1024)throw new Error('extra_model_paths.yaml 超过 1 MiB。');
    const config=parse(data,{maxAliasCount:100});
    for(const entry of Object.values(config||{})) {
      if(!entry||typeof entry!=='object')continue;const base=resolve(comfyPath,typeof entry.base_path==='string'?entry.base_path:'.');
      for(const category of categories)if(typeof entry[category]==='string')for(const value of entry[category].split(/\r?\n/).map(value=>value.trim()).filter(Boolean))roots.push({path:resolve(base,value),category,source:'extra-model-paths',configFile:file});
    }
  }catch(error){if(error.code!=='ENOENT')warnings.push(`额外模型目录未完全读取：${error.message}`);}
  for(const entry of explicit)if(entry&&categories.includes(entry.category)&&typeof entry.path==='string')roots.push({path:resolve(entry.path),category:entry.category,source:'explicit-link',allowLink:true});
  const unique=new Map();
  for(const root of roots){signal?.throwIfAborted();try{const target=await realpath(root.path);await checkedLocalPath(root.allowLink?target:root.path);unique.set(root.category+':'+target.toLowerCase(),{...root,path:target});}catch(error){if(error.code!=='ENOENT')warnings.push(`${root.path}：${error.message}`);}}
  return {roots:[...unique.values()],warnings};
}

export async function indexModelNames(roots,{signal,limit=10000}={}) {
  const files=[],warnings=[];let visited=0,partial=false;
  const walk=async(directory,root,depth=0)=>{
    if(depth>20){partial=true;return;}
    for(const entry of await readdir(directory,{withFileTypes:true})){
      signal?.throwIfAborted();if(++visited>limit){partial=true;return;}
      const path=join(directory,entry.name);
      if(entry.isSymbolicLink()){warnings.push(`未遍历链接 ${path}；如需使用请显式选择该目录。`);continue;}
      if(entry.isDirectory())await walk(path,root,depth+1);
      else if(entry.isFile()&&/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(entry.name))files.push({path,filename:entry.name,category:root.category,root:root.path,source:root.source});
      if(visited>limit)return;
    }
  };
  for(const root of roots){try{await walk(root.path,root);}catch(error){if(signal?.aborted)throw error;warnings.push(`目录读取失败：${root.path}（${error.code||error.message}）`);}if(visited>limit)break;}
  return {files,warnings,partial};
}

export async function inspectLocalModels(dependency,files,{cache,budget,signal}) {
  const expected=new Set(dependency.candidates?.map(item=>item.sha256).filter(Boolean)||[]);
  const names=new Set([dependency.filename,...(dependency.candidates||[]).map(item=>item.filename).filter(Boolean)].map(comparable));
  const matches=new Map(),found=[],unhashed=[];let partial=false,hashAttempts=dependency.local?.hashAttempts||0;
  for(const file of files) {
    if(!equivalent(dependency.category).includes(file.category))continue;
    const named=names.has(comparable(file.filename));
    // 改名文件只能由已有可信 SHA 缓存缩小范围，不能为寻找同内容而全盘读取模型。
    if(named||expected.has(cache[file.path]?.sha256))matches.set(file.path,{...file,named});
  }
  // 先校验缓存文件身份；缓存命中不占新读预算，也不占每依赖三个新哈希名额。
  for(const file of matches.values()) {
    signal?.throwIfAborted();let before;
    try{before=await stat(file.path);}catch{partial=true;continue;}
    const key=identity(before),cached=cache[file.path];const sha256=cached?.identity===key?cached.sha256:null;
    const {named,...entry}=file;const item={...entry,reference:relative(file.root,file.path).split(sep).join('/'),sizeBytes:before.size};
    if(sha256)found.push({...item,sha256,verification:expected.has(sha256)?'sha256':'calculated'});
    else if(named)unhashed.push({item,before,key});
  }
  for(const {item,before,key} of unhashed) {
      signal?.throwIfAborted();
      if(before.size>budget.maxBytes){partial=true;found.push({...item,sha256:null,verification:'file-exceeds-budget'});continue;}
      if(hashAttempts>=3||budget.bytes+before.size>budget.maxBytes||Date.now()>budget.deadline){partial=true;found.push({...item,sha256:null,verification:'budget-exhausted'});continue;}
      hashAttempts++;
      const hash=createHash('sha256');let completed=true;
      for await(const chunk of createReadStream(item.path,{signal})){
        if(Date.now()>budget.deadline||budget.bytes+chunk.length>budget.maxBytes){completed=false;break;}budget.bytes+=chunk.length;hash.update(chunk);
      }
      const after=await stat(item.path);
      if(!completed||identity(after)!==key){partial=true;found.push({...item,sha256:null,verification:completed?'file-changed':'budget-exhausted'});continue;}
      const sha256=hash.digest('hex');cache[item.path]={identity:key,sha256};
      found.push({...item,sha256,verification:expected.has(sha256)?'sha256':'calculated'});
  }
  return {status:found.length?'exists':'missing',identity:found.some(file=>file.verification==='sha256')?'verified':'unverified',files:found,partial,hashAttempts,continuable:found.some(file=>['budget-exhausted','file-changed'].includes(file.verification))};
}
