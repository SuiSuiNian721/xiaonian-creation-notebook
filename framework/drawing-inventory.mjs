import { readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { checkedLocalPath, insideDirectory } from './drawing-files.mjs';
import { exists, digest, publicRemote } from './drawing-repositories.mjs';

export async function readRepositories(comfyPath,access,{signal,warnings=[]}={}) {
  const repositories=[];
  const add=async(path,kind,file=false)=>{
    const diskName=basename(path),enabled=kind==='core'||!diskName.endsWith('.disabled');
    const name=kind==='core'?'ComfyUI':diskName.replace(/\.disabled$/,'');
    const stat=await exists(path);const git=file?null:await access.inspect(path,{signal});
    const requirements=await access.requirements(path,file);
    repositories.push({id:kind==='core'?'core':'plugin:'+name,name,kind,path,enabled,file,git,requirements:!!requirements,requirementsInfo:requirements,identity:{birthtimeMs:stat.birthtimeMs,ino:stat.ino}});
  };
  await add(comfyPath,'core');
  let custom;try{custom=await insideDirectory(comfyPath,'custom_nodes');}catch(error){warnings.push(error.message);return repositories;}
  if(!await exists(custom))return repositories;
  const entries=await readdir(custom,{withFileTypes:true});
  if(entries.length>1000)warnings.push('插件目录超过 1000 项，仅索引前 1000 项。');
  for(const entry of entries.slice(0,1000)){
    if(signal?.aborted)throw new Error('操作已取消。');
    if(entry.name.startsWith('.')||entry.name==='__pycache__')continue;
    if(entry.isSymbolicLink()){warnings.push(`跳过插件链接或联接：${entry.name}`);continue;}
    if(!entry.isDirectory()&&!/\.py(?:\.disabled)?$/i.test(entry.name))continue;
    try{await add(await insideDirectory(custom,entry.name),'plugin',entry.isFile());}catch(error){warnings.push(`${entry.name}：${error.message}`);}
  }
  return repositories;
}
export function publicRepository(repo){const {requirementsInfo,identity,...value}=repo;return {...value,git:value.git?{...value.git,remote:publicRemote(value.git.remote)}:null};}
export function repositoryFingerprint(repo){return digest(repo);}

export async function scanInventory(comfyPath,access,{signal,downloads=[],limit=10000}={}) {
  await checkedLocalPath(comfyPath);const warnings=['仅索引当前 ComfyUI/models；extra_model_paths.yaml 的外部模型目录不在此次索引范围。'];
  const repositories=await readRepositories(comfyPath,access,{signal,warnings});const models=[];let visited=0,truncated=false;
  const walk=async(path,depth=0)=>{
    if(depth>30){warnings.push(`目录过深，跳过：${path}`);return;}
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(signal?.aborted)throw new Error('操作已取消。');
      if(++visited>limit){truncated=true;return;}
      if(entry.isSymbolicLink()){warnings.push(`跳过模型链接或联接：${entry.name}`);continue;}
      const target=await insideDirectory(comfyPath,'models',relative(join(comfyPath,'models'),join(path,entry.name)));
      if(entry.isDirectory())await walk(target,depth+1);
      else if(entry.isFile()&&/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(entry.name)){
        const stat=await exists(target);const rel=relative(join(comfyPath,'models'),target);const downloaded=downloads.find(x=>x.status==='completed'&&x.target?.toLowerCase()===target.toLowerCase());
        models.push({id:digest(target),name:entry.name,category:rel.includes(sep)?rel.split(sep)[0]:'models',path:target,size:stat.size,...(downloaded?{source:downloaded.source,sha256:downloaded.actualSha256||null}:{})});
      }
      if(truncated)return;
    }
  };
  try{const modelsPath=await insideDirectory(comfyPath,'models');if(await exists(modelsPath))await walk(modelsPath);}catch(error){warnings.push(error.message);}
  if(truncated)warnings.push(`索引达到 ${limit} 项限制；结果不是全部模型。`);
  return {at:new Date().toISOString(),comfyPath,models,repositories:repositories.map(publicRepository),warnings};
}
