import {lstat,readlink,realpath} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,resolve,sep} from 'node:path';
import {WorkbenchError} from './contracts.mjs';

function local(value){
  if(typeof value!=='string'||!isAbsolute(value)||/^[\\/]{2}/.test(value)||/[\u0000-\u001f\u007f]/.test(value)||process.platform==='win32'&&(!/^[A-Za-z]:[\\/]/.test(value)||value.slice(2).includes(':')))throw new WorkbenchError(400,'资源须使用本地磁盘的绝对路径。');
  return resolve(value);
}

// Reading explicitly selected installations/caches has different constraints from
// writing managed files. Resolve reparse points before reading, with a hop bound;
// never use this helper to authorize deletion, extraction or managed-file writes.
export async function readableLocalPath(value){
  let target=local(value);const seen=new Set();
  for(let hops=0;hops<24;hops++){
    const identity=process.platform==='win32'?target.toLowerCase():target;
    if(seen.has(identity))throw new WorkbenchError(400,'资源路径包含链接循环。');seen.add(identity);
    const root=parse(target).root,parts=target.slice(root.length).split(sep).filter(Boolean);let current=root,redirected=false;
    for(let index=0;index<parts.length;index++){
      current=join(current,parts[index]);const info=await lstat(current);
      if(!info.isSymbolicLink())continue;
      let destination=await readlink(current);
      // NTFS directory junctions can expose a canonical DOS-device prefix.
      if(process.platform==='win32')destination=destination.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/,'');
      if(/^[\\/]{2}/.test(destination))throw new WorkbenchError(400,'资源链接必须指向本地磁盘。');
      target=local(resolve(dirname(current),destination,...parts.slice(index+1)));redirected=true;break;
    }
    if(!redirected)return local(await realpath(target));
  }
  throw new WorkbenchError(400,'资源路径链接过多，请直接选择实际目录。');
}
