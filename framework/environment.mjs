import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { WorkbenchError, fields, text } from './contracts.mjs';
import { discoverLocalEnvironments } from './environment-local.mjs';
import { discoverMinecraftWorlds } from './environment-minecraft.mjs';
import {CachedDiscovery} from './resource-discovery.mjs';
import {readableLocalPath} from './resource-local-path.mjs';

const runFile = promisify(execFile);
const supported = new Set(['drawing','comfyui','qq','mc-play','mc-skin','training','companion']);

export async function discoveryDirectory(value) {
  const path = text(value,'扫描目录',4096);
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || /[\u0000-\u001f\u007f]/.test(path) || process.platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(path) || path.slice(2).includes(':'))) throw new WorkbenchError(400,'扫描目录须为普通本地磁盘的绝对路径。');
  let target;
  try {
    target=await readableLocalPath(path);
    if (!(await lstat(target)).isDirectory()) throw new Error('not a directory');
  } catch (error) { if (error instanceof WorkbenchError) throw error;throw new WorkbenchError(400,'无法读取扫描目录，请选择现有本地文件夹。'); }
  return target;
}

async function localRoots({ signal, env = process.env } = {}) {
  const home = homedir();
  const roots = [home,join(home,'Desktop'),join(home,'Downloads'),join(home,'Documents'),env.LOCALAPPDATA && join(env.LOCALAPPDATA,'Programs'),env.ProgramFiles,env['ProgramFiles(x86)']];
  if (process.platform === 'win32') {
    try {
      const {stdout} = await runFile('pwsh',['-NoProfile','-NonInteractive','-Command',"@(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { $_.DeviceID + '\\' }) | ConvertTo-Json -Compress"],{signal,timeout:2500,maxBuffer:16384,windowsHide:true});
      const drives = JSON.parse(stdout);
      for(const drive of (Array.isArray(drives)?drives:[drives]).filter(value=>typeof value==='string'))roots.push(...['ComfyUI','ai draw','train','voice','AI','Programs'].map(name=>join(drive,name)));
    } catch { if (signal?.aborted) throw signal.reason; }
  }
  return [...new Set(roots.filter(Boolean))];
}

export class EnvironmentDiscovery {
  constructor({ roots, hints = () => [], explicitPaths = () => [], env = process.env, scanLocal = discoverLocalEnvironments, discoverLan = discoverMinecraftWorlds, chooseDirectory,store,fingerprint=()=>'' } = {}) {
    this.roots = roots;this.hints = hints;this.explicitPaths = explicitPaths;this.env = env;this.scanLocal = scanLocal;this.discoverLan = discoverLan;this.choose = chooseDirectory;
    this.cache = new Map();this.pending = new Map();this.abort = new AbortController();this.closed = false;
    this.store=store;this.fingerprint=fingerprint;
  }
  family(id){return id==='drawing'?'comfyui':id;}
  searchRoots(id){return this.store?.getSetting('environment.searchRoots.'+this.family(id))??[];}
  signature(id){return JSON.stringify([this.fingerprint(this.family(id)),this.searchRoots(id)]);}
  // 旧陪伴结果使用 Electron 的虚拟 ASAR 文件类型，升级后只重新检查这一类缓存。
  durable(id){return this.store&&supported.has(id)?new CachedDiscovery({store:this.store,key:id==='companion'?'environment.companion.physical-files-v1':'environment.'+this.family(id)}):null;}
  state(value){const id=this.validate(value);return this.durable(id)?.read({fingerprint:this.signature(id)})??{attempted:false,result:null};}
  validate(value, choosing = false) {
    fields(value,choosing ? ['moduleId'] : ['moduleId','refresh','directory']);
    if (!supported.has(value.moduleId)) throw new WorkbenchError(400,'此模块没有可自动查找的运行环境。');
    if (value.refresh !== undefined && typeof value.refresh !== 'boolean') throw new WorkbenchError(400,'重新扫描须为布尔值。');
    if (value.directory !== undefined && typeof value.directory !== 'string') throw new WorkbenchError(400,'扫描目录格式无效。');
    if (value.moduleId === 'mc-play' && value.directory !== undefined) throw new WorkbenchError(400,'MC 陪玩通过局域网公告发现世界，无需扫描游戏目录。');
    if (this.closed) throw new WorkbenchError(503,'工作台正在关闭，扫描已取消。');
    return value.moduleId;
  }
  async scan(value) {
    const id = this.validate(value);
    const directory = value.directory === undefined ? '' : await discoveryDirectory(value.directory);
    const key = `${this.store&&id==='drawing'?'comfyui':id}:${directory}`;
    if (this.pending.has(key)) return this.pending.get(key);
    if (!value.refresh && this.cache.has(key)&&!this.durable(id)) return this.cache.get(key);
    if(directory&&this.durable(id))this.store.setSetting('environment.searchRoots.'+this.family(id),[...new Set([...this.searchRoots(id),directory])].slice(-12));
    const work = async () => {
      const signal = this.abort.signal;signal.throwIfAborted();
      let result;
      if (id === 'mc-play') result = await this.discoverLan({signal});
      else {
        this.rootPromise ||= this.roots === undefined ? localRoots({signal,env:this.env}) : Promise.resolve(this.roots);
        const roots = directory ? [directory] : [...await this.rootPromise,...this.searchRoots(id)];
        let explicitPaths = id==='companion'&&!directory ? [...await this.explicitPaths(id),this.env.AI_FUTURE_AIRI_PATH].filter(Boolean) : [];
        let hints = directory ? [] : [...await this.hints(id),this.env.AI_FUTURE_COMFY_PATH,...(id === 'mc-skin' ? [this.env.AI_FUTURE_SKIN_PYTHON,this.env.AI_FUTURE_COMFY_PYTHON,...(this.env.PATH || this.env.Path || '').split(delimiter)] : [])].filter(Boolean);
        if(id==='companion'&&!directory)hints.push(...[this.env.AI_FUTURE_AIRI_PATH,'E:\\AI-未来\\AIRI',this.env.LOCALAPPDATA&&join(this.env.LOCALAPPDATA,'Programs','AIRI'),this.env.LOCALAPPDATA&&join(this.env.LOCALAPPDATA,'AIRI')].filter(Boolean));
        if(this.durable(id)){
          const readable=async path=>{try{return await readableLocalPath(path);}catch{return path;}};
          [hints,explicitPaths]=await Promise.all([Promise.all(hints.map(readable)),Promise.all(explicitPaths.map(readable))]);
        }
        result = await this.scanLocal({moduleId:id,roots,hints,explicitPaths,selectedRoots:directory?[directory]:[],signal});
      }
      signal.throwIfAborted();
      const visible = {moduleId:id,candidates:result.candidates,issues:result.issues || [],partial:Boolean(result.partial),warnings:result.warnings || [],scannedAt:new Date().toISOString(),canChooseDirectory:id !== 'mc-play' && typeof this.choose === 'function'};
      this.cache.set(key,visible);return visible;
    };
    const durable=this.durable(id);
    const promise = (durable?durable.run(work,{refresh:Boolean(value.refresh),fingerprint:this.signature(id)}).then(record=>{
      if(this.closed)throw new WorkbenchError(503,'本机环境扫描已取消。');
      return {...(record.result??{candidates:[],issues:[],partial:true,warnings:[],canChooseDirectory:typeof this.choose==='function'}),moduleId:id,attempted:true,discoveryStatus:record.status,...(record.error?{error:record.error,warnings:[...(record.result?.warnings??[]),record.error]}:{})};
    }):work()).finally(() => {if (this.pending.get(key) === promise) this.pending.delete(key);});
    this.pending.set(key,promise);return promise;
  }
  async chooseDirectory(value) {
    const id = this.validate(value,true);
    if (id === 'mc-play' || typeof this.choose !== 'function') throw new WorkbenchError(409,'请在桌面工作台中选择扫描目录。');
    if (this.choosing) throw new WorkbenchError(409,'已有文件夹选择窗口，请先完成选择。');
    this.choosing = true;
    try {
      const selected = await this.choose({moduleId:id,defaultPath:homedir(),purpose:'environment'});
      if (this.closed) throw new WorkbenchError(503,'工作台正在关闭。');
      return selected ? {directory:await discoveryDirectory(selected),cancelled:false} : {directory:null,cancelled:true};
    } finally {this.choosing = false;}
  }
  close() {this.closed = true;this.abort.abort(new Error('本机环境扫描已取消。'));this.cache.clear();return Promise.allSettled([...this.pending.values()]);}
}
