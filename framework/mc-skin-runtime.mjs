import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError } from './contracts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const skinSkillRoot=join(root,'integrations/minecraft-pixel-skin');
export const skinAdapter=join(root,'integrations/minecraft-skin/skin_adapter.py');

export async function localSkinDirectory(value,{create=false}={}) {
  if(typeof value!=='string'||!isAbsolute(value)||/^[\\/]{2}/.test(value)||/[\u0000-\u001f]/.test(value))throw new WorkbenchError(400,'皮肤目录需要普通本地磁盘上的绝对路径。');
  const absolute=resolve(value);let current=parse(absolute).root;
  for(const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current=join(current,part);
    let entry;try{entry=await lstat(current);}catch(error){if(error.code!=='ENOENT'||!create)throw new WorkbenchError(400,'找不到皮肤作品目录。');await mkdir(current);entry=await lstat(current);}
    if(entry.isSymbolicLink()||!entry.isDirectory())throw new WorkbenchError(400,'皮肤目录不能经过链接或普通文件。');
  }
  return absolute;
}

export class SkinRuntime {
  constructor({pythonPath='',getPythonPath=()=>'',directory}){this.pythonPath=pythonPath;this.getPythonPath=getPythonPath;this.directory=directory;this.children=new Set();this.cached=null;this.checking=null;this.closed=false;}
  async candidates(){
    const specified=this.pythonPath||this.getPythonPath()||process.env.AI_FUTURE_SKIN_PYTHON;
    if(specified)return [specified];
    const candidates=['python'];
    if(process.platform==='win32'&&process.env.LOCALAPPDATA){
      const base=join(process.env.LOCALAPPDATA,'Python');
      try{for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isDirectory())candidates.push(join(base,entry.name,'python.exe'));}catch{}
      const programs=join(process.env.LOCALAPPDATA,'Programs/Python');
      try{for(const entry of await readdir(programs,{withFileTypes:true}))if(entry.isDirectory())candidates.push(join(programs,entry.name,'python.exe'));}catch{}
    }
    return [...new Set(candidates)];
  }
  execute(python,args,{signal,timeoutMs=45000}={}){
    return new Promise((resolveRun,reject)=>{
      if(this.closed)return reject(new WorkbenchError(409,'皮肤运行端已关闭。'));
      if(signal?.aborted)return reject(new Error('皮肤制作已取消。'));
      const child=spawn(python,['-B',skinAdapter,...args],{cwd:this.directory,env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
      this.children.add(child);let output='',errors='',settled=false;
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.children.delete(child);error?reject(error):resolveRun(value);};
      const stop=message=>{child.kill();finish(new Error(message));};
      const abort=()=>stop('皮肤制作已取消。');
      const timer=setTimeout(()=>stop('像素工具运行超时，请检查 Python 环境。'),timeoutMs);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>3*1024*1024)stop('像素工具输出超过限制。');});
      child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-8000);});
      child.on('error',error=>finish(Object.assign(new Error(error.code==='ENOENT'?'未找到 Python 解释器，请在接入配置中选择已安装的 Python。':error.message),{code:error.code})));
      child.on('close',code=>{
        if(code!==0){let message=errors.trim()||output.trim()||'皮肤像素工具运行失败。';try{message=JSON.parse(output).error||message;}catch{}return finish(new Error(message.slice(-2000)));}
        try{finish(null,JSON.parse(output.trim()));}catch{finish(new Error('像素工具没有返回有效的 JSON 检查结果。'));}
      });
    });
  }
  async check(force=false){
    if(this.closed)throw new WorkbenchError(409,'皮肤运行端已关闭。');
    if(this.checking)return this.checking;if(this.cached&&!force)return this.cached;
    this.checking=(async()=>{
      let last={message:'没有可检查的 Python 解释器。',code:'ENOENT'};
      for(const candidate of await this.candidates())try{const result=await this.execute(candidate,['environment'],{timeoutMs:12000});if(this.closed)throw new WorkbenchError(409,'皮肤运行端已关闭。');if(result.available){this.cached={...result,available:true,missingComponents:[],command:candidate};return this.cached;}last={message:result.error||'适配器返回不可用状态。'};}catch(error){if(this.closed)throw error;if(last.code==='ENOENT'||error.code!=='ENOENT')last=error;}
      const dependency=/No module named ['"]([^'"]+)['"]/.exec(last.message);
      const missingComponents=[];let error;
      if(last.code==='ENOENT'){missingComponents.push({id:'python',name:'Python 解释器'});error='未找到可启动的 Python 解释器。请选择已安装的 Python 3.10+。';}
      else if(dependency){const name=dependency[1];const pillow=name==='PIL'||name.startsWith('PIL.');missingComponents.push({id:pillow?'pillow':name,name:pillow?'Pillow 图像库':'Python 依赖包 '+name});error='当前 Python 缺少 '+missingComponents[0].name+'。请在所选 Python 中安装此依赖后重新检查。';}
      else error='MC 皮肤工具检查失败：'+last.message;
      this.cached={available:false,python:'',pillow:'',templates:[],missingComponents,error};return this.cached;
    })().finally(()=>{this.checking=null;});
    return this.checking;
  }
  async run(args,options){const runtime=await this.check();if(!runtime.available)throw new WorkbenchError(409,runtime.error);return this.execute(runtime.command,args,options);}
  close(){this.closed=true;for(const child of this.children)child.kill();}
}

export async function skillInstructions(){
  const parts=await Promise.all(['SKILL.md','references/character-production.md','references/tools-and-validation.md'].map(file=>readFile(join(skinSkillRoot,file),'utf8')));
  return parts.join('\n\n');
}
