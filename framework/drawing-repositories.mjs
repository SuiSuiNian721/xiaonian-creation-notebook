import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, fileName, insideDirectory } from './drawing-files.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export async function exists(path) { try { return await lstat(path); } catch(error) { if(error.code==='ENOENT') return null; throw error; } }
export function publicRemote(value) {
  if(!value) return null;
  try { const url=new URL(value); url.username='';url.password='';url.search='';url.hash='';return url.href; }
  catch { return value.replace(/^[^@/\\]+@/,'').split(/[?#]/)[0]; }
}

// Every process is owned by one operation. Cancellation waits for process exit before shutdown closes SQLite.
export function runManaged(executable,args,{cwd,signal,timeoutMs=120000,maxBytes=256*1024,onOutput}={}) {
  return new Promise(resolveResult=>{
    let child,timer,finished=false,reason=null,total=0;const out=[],err=[];
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const publish=(text,stream)=>{if(!text||!onOutput)return;try{onOutput(text,stream);}catch(error){stop(`保存实时日志失败：${error.message}`);}};
    const finish=code=>{if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(!reason)for(const [stream,decoder] of Object.entries(decoders))publish(decoder.end(),stream);resolveResult({code,stdout:Buffer.concat(out).toString('utf8'),stderr:Buffer.concat(err).toString('utf8'),...(reason?{error:reason}:{})});};
    const stop=message=>{reason=message;if(!child?.pid){finish(null);return;}if(process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',shell:false});killer.on('error',()=>child.kill());}else child.kill('SIGTERM');};
    const cancel=()=>stop('操作已取消。');if(signal?.aborted){finish(null);return;}
    try{child=spawn(executable,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_OPTIONAL_LOCKS:'0',PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8',PYTHONUNBUFFERED:'1',PIP_NO_INPUT:'1'}});}catch(error){reason=error.message;finish(null);return;}
    signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>stop('操作超时，已终止。'),timeoutMs);
    const collect=(target,stream)=>bytes=>{if(finished||reason)return;total+=bytes.length;if(total>maxBytes){stop('进程输出超过限制。');return;}target.push(bytes);publish(decoders[stream].write(bytes),stream);};
    child.stdout.on('data',collect(out,'stdout'));child.stderr.on('data',collect(err,'stderr'));child.once('error',error=>{reason=error.message;finish(null);});child.once('close',finish);
  });
}

export class RepositoryAccess {
  constructor({runner=runManaged,directory,allowLocalRepositories=false}){this.runner=runner;this.directory=directory;this.allowLocalRepositories=allowLocalRepositories;}
  async git(cwd,args,{signal,allowFailure=false,onOutput}={}) {
    const result=await this.runner('git',['-c',`core.hooksPath=${join(this.directory,'disabled-hooks')}`,'-c','core.fsmonitor=false','-c','protocol.allow=never','-c','protocol.http.allow=always','-c','protocol.https.allow=always','-c',`protocol.file.allow=${this.allowLocalRepositories?'always':'never'}`,...args],{cwd,signal,onOutput});
    if(!allowFailure&&(result.code!==0||result.error))throw new WorkbenchError(409,`Git 操作失败：${publicRemote(result.error||result.stderr?.trim()||String(result.code))}`);
    return result;
  }
  source(value) {
    if(typeof value!=='string'||!value||value.length>8192||/[\u0000-\u001f]/.test(value))throw new WorkbenchError(400,'Git 来源无效。');
    if(this.allowLocalRepositories&&isAbsolute(value))return resolve(value);
    let url;try{url=new URL(value);}catch{throw new WorkbenchError(400,'Git 来源须为 HTTP/HTTPS 地址。');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new WorkbenchError(400,'Git 来源须为不含凭据、查询参数的 HTTP/HTTPS 地址。');
    return url.href;
  }
  name(source,name) { const value=fileName(name||basename(source.replace(/\/$/,''),'.git')); if(value.endsWith('.disabled'))throw new WorkbenchError(400,'插件名称不能以 .disabled 结尾。');return value; }
  async inspect(path,{signal}={}) {
    const marker=await exists(join(path,'.git'));if(!marker)return null;
    await checkedLocalPath(join(path,'.git'));
    const top=(await this.git(path,['rev-parse','--show-toplevel'],{signal})).stdout.trim();
    if(resolve(top).toLowerCase()!==resolve(path).toLowerCase())throw new WorkbenchError(400,'Git 仓库根目录与插件目录不一致。');
    const head=(await this.git(path,['rev-parse','HEAD'],{signal})).stdout.trim();
    const branch=(await this.git(path,['symbolic-ref','--quiet','--short','HEAD'],{signal,allowFailure:true})).stdout.trim()||null;
    const status=(await this.git(path,['status','--porcelain=v1','--untracked-files=all'],{signal})).stdout;
    const remote=(await this.git(path,['remote','get-url','origin'],{signal,allowFailure:true})).stdout.trim()||null;
    return {head,branch,remote,dirty:!!status,status};
  }
  async remoteTarget(source,revision='HEAD',{signal,cwd=this.directory}={}) {
    this.source(source);
    if(typeof revision!=='string'||!revision||revision.length>240||revision.startsWith('-')||/[\s~^:?*\[\\\u0000-\u001f]/.test(revision)||revision.includes('..'))throw new WorkbenchError(400,'版本须为分支、标签或远端公开的完整提交 SHA。');
    const lines=(await this.git(cwd,['ls-remote','--symref','--',source],{signal})).stdout.trim().split('\n');
    const refs=new Map();let defaultBranch=null;
    for(const line of lines){const [sha,ref]=line.trim().split('\t');if(sha?.startsWith('ref: ')&&ref==='HEAD')defaultBranch=sha.slice(5);else if(/^[a-f0-9]{40,64}$/.test(sha))refs.set(ref,sha);}
    let ref=revision==='HEAD'?'HEAD':refs.has(revision)?revision:refs.has('refs/heads/'+revision)?'refs/heads/'+revision:refs.has('refs/tags/'+revision)?'refs/tags/'+revision:null;
    if(!ref&&/^[a-f0-9]{40,64}$/.test(revision))ref=[...refs].find(([,sha])=>sha===revision)?.[0];
    if(!ref||!refs.get(ref))throw new WorkbenchError(409,'远端未公开该版本；请使用存在的分支、标签或其完整提交 SHA。');
    return {sha:refs.get(ref+'^{}')||refs.get(ref),ref:ref==='HEAD'?(defaultBranch||'HEAD'):ref};
  }
  async requirements(path,file=false) {
    if(file)return null;const target=await insideDirectory(path,'requirements.txt');const stat=await exists(target);if(!stat)return null;
    if(!stat.isFile()||stat.size>2*1024*1024)throw new WorkbenchError(400,'requirements.txt 不是普通小型文件。');
    return {path:target,sha256:digest(await readFile(target))};
  }
}
