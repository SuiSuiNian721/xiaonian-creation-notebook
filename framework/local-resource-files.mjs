import {createHash} from 'node:crypto';
import {readdir,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {readableLocalPath} from './resource-local-path.mjs';

// Bounded, metadata-only discovery. Explicit junction roots can be reused; cycles cannot.
export async function findLocalResourceFiles({roots=[],accept,signal,maxEntries=4000,maxDepth=5,maxResults=120,maxMs=1500}={}){
  const started=Date.now(),visited=new Set(),found=new Set(),candidates=[],warnings=[],queue=[];let entries=0,partial=false;
  for(const value of roots){if(typeof value!=='string'||!isAbsolute(value)||/^[\\/]{2}/.test(value))continue;queue.push({path:value,depth:0});}
  while(queue.length){
    signal?.throwIfAborted();
    if(entries>=maxEntries||candidates.length>=maxResults||Date.now()-started>=maxMs){partial=true;warnings.push('已达到本次检索范围，可指定更具体的目录后重新检索。');break;}
    const current=queue.shift();let actual,items;
    try{actual=await readableLocalPath(current.path);const key=process.platform==='win32'?actual.toLowerCase():actual;if(visited.has(key))continue;visited.add(key);items=await readdir(actual,{withFileTypes:true});}
    catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))warnings.push('无法读取 '+current.path);continue;}
    for(const item of items){
      signal?.throwIfAborted();if(++entries>maxEntries||candidates.length>=maxResults||Date.now()-started>=maxMs){partial=true;break;}
      const path=join(actual,item.name);
      const kind=accept(item.name,path);
      if(kind){
        try{
          const target=await readableLocalPath(path);if(found.has(target))continue;
          const info=await stat(target);if(!info.isFile()||!info.size)continue;found.add(target);
          candidates.push({id:createHash('sha256').update(target).digest('hex'),kind,path:target,label:item.name,bytes:info.size,mtimeMs:info.mtimeMs,verification:'metadata'});
        }catch{warnings.push('文件暂不可读：'+path);}
      }
      if((item.isDirectory()||item.isSymbolicLink())&&!/^(?:node_modules|\.git|site-packages|logs?|outputs?|temp|tmp|__pycache__)$/i.test(item.name)){
        if(current.depth<maxDepth)queue.push({path,depth:current.depth+1});else partial=true;
      }
    }
  }
  return {candidates,partial,warnings:[...new Set(warnings)].slice(0,30),scannedAt:new Date().toISOString()};
}
