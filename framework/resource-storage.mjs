import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,statSync} from 'node:fs';
import {lstat,mkdir,open,readFile,readdir,rename,rmdir,unlink} from 'node:fs/promises';
import {dirname,join,parse,relative,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fields,WorkbenchError} from './contracts.mjs';
import {checkedLocalPath,fileHash,insideDirectory} from './drawing-files.mjs';

const OWNER='AI-Future-Workbench/resource-storage/v1',MARKER='.workbench-storage-owner.json';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>new WorkbenchError(409,message);
const receiptsPath=dataDir=>join(resolve(dataDir),'resource-storage','receipts');
const profileId=dataDir=>digest(resolve(dataDir));
const ordinary=async path=>{await checkedLocalPath(path);try{const info=await lstat(path);if(info.isSymbolicLink()||!info.isFile())throw fail('资源包含链接或非普通文件，已保留原文件。');return info;}catch(error){if(error.code==='ENOENT')return null;throw error;}};
async function json(path){const info=await ordinary(path);if(!info)return null;if(info.size>32*1024*1024)throw fail('资源所有权清单过大，已保留原文件。');return JSON.parse(await readFile(path,'utf8'));}
async function atomic(path,value){
  await checkedLocalPath(path);await mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';
  const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value),'utf8');}finally{await handle.close();}
  await checkedLocalPath(path);await rename(temporary,path);
}

/** Shared leases cover installers and running workers; deletion needs an exclusive lease.
 * Empty SQLite files contain no application data. OS locks disappear on process exit. */
export function acquireResourceStorageLease(dataDir,family,{exclusive=false}={}){
  if(!['voice','vision','qq'].includes(family))throw fail('资源类别无效。');
  const root=resolve(dataDir,'resource-storage');let current=parse(root).root;
  for(const part of relative(current,root).split(sep).filter(Boolean)){current=join(current,part);if(existsSync(current)&&(!lstatSync(current).isDirectory()||lstatSync(current).isSymbolicLink()))throw fail('资源管理目录不能包含链接或目录联接。');}
  mkdirSync(root,{recursive:true});const path=join(root,family+'.lock.sqlite');
  for(const suffix of ['','-journal','-wal','-shm'])if(existsSync(path+suffix)){const info=lstatSync(path+suffix);if(info.isSymbolicLink()||!info.isFile()||!suffix&&info.size)throw fail('资源锁文件归属无效，请保留原文件。');}
  let database;try{database=new DatabaseSync(path,{timeout:0});database.exec(exclusive?'PRAGMA busy_timeout=0;BEGIN EXCLUSIVE':'PRAGMA busy_timeout=0;BEGIN;PRAGMA schema_version');}
  catch(error){database?.close();if(/locked|busy/i.test(error.message))throw fail('其他工作台正在使用或维护此资源，请等待任务结束。');throw error;}
  let released=false;return ()=>{if(released)return;released=true;try{database.exec('ROLLBACK');}finally{database.close();}};
}

async function receipts(dataDir){
  const directory=receiptsPath(dataDir);await checkedLocalPath(directory);let names;try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const result=[];for(const name of names.sort()){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    const receipt=await json(await insideDirectory(directory,name));
    if(receipt?.owner!==OWNER||receipt.profile!==profileId(dataDir)||typeof receipt.id!=='string'||!['voice','vision','qq'].includes(receipt.family)||!Array.isArray(receipt.files)||receipt.files.length>200000||!Array.isArray(receipt.directories))throw fail('资源所有权清单无效，已保留资源。');
    if(name!==digest(receipt.id)+'.json')throw fail('资源所有权清单名称不匹配。');
    result.push(receipt);
  }return result;
}
async function walk(root){
  await checkedLocalPath(root);const files=[],directories=[];
  const visit=async path=>{let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){const target=await insideDirectory(root,relative(root,path),entry.name),info=await lstat(target);if(info.isSymbolicLink())throw fail('资源包含链接或目录联接，已保留。');const name=relative(root,target).split(sep).join('/');
      if(info.isDirectory()){directories.push(name);await visit(target);}else if(info.isFile())files.push({path:name,bytes:info.size,mtimeMs:info.mtimeMs,ino:String(info.ino),dev:String(info.dev)});else throw fail('资源包含非普通文件，已保留。');
      if(files.length+directories.length>250000)throw fail('资源文件数量超过安全检查上限。');
    }};
  await visit(root);return {files,directories};
}
async function validateRoot(dataDir,root,token,{hashes=false}={}){
  const marker=await json(await insideDirectory(root,MARKER));
  if(marker?.owner!==OWNER||marker.profile!==profileId(dataDir)||marker.token!==token)throw fail('资源归属记录已改变，原目录保持不变。');
  const related=(await receipts(dataDir)).filter(item=>item.root===root&&item.token===token),known=new Map(related.flatMap(item=>item.files.map(file=>[file.path,file]))),knownDirectories=new Set(related.flatMap(item=>item.directories));
  const snapshot=await walk(root);
  for(const file of snapshot.files){if(file.path===MARKER)continue;const expected=known.get(file.path);if(!expected)throw fail('目录中有未知文件，归属无法确认，原目录保持不变。');if(file.bytes!==expected.bytes)throw fail('资源文件已改变，计划失效。');if(hashes&&await fileHash(await insideDirectory(root,...file.path.split('/')))!==expected.sha256)throw fail('资源文件校验失败，计划失效。');}
  for(const directory of snapshot.directories)if(!knownDirectories.has(directory))throw fail('目录中有未知目录，已保留原目录。');
  return {related,snapshot};
}

/** Called before an installer writes. Existing unmarked directories are never adopted. */
export async function beginManagedRoot({dataDir,root,existingOnly=false}){
  root=await checkedLocalPath(root);const marker=await insideDirectory(root,MARKER),saved=await json(marker);
  if(saved){if(saved.owner!==OWNER||saved.profile!==profileId(dataDir))return null;try{await validateRoot(dataDir,root,saved.token,{hashes:true});return {root,token:saved.token,profile:saved.profile};}catch{return null;}}
  if(existingOnly)return null;await mkdir(root,{recursive:true});
  if((await readdir(root)).length)return null;
  const token=randomUUID(),record={owner:OWNER,profile:profileId(dataDir),token};const handle=await open(marker,'wx',0o600);try{await handle.writeFile(JSON.stringify(record),'utf8');}finally{await handle.close();}
  return {root,token,profile:record.profile};
}

/** The caller must hold a family lease and only pass roots checked before its own writes.
 * Selection splits installable files from regenerable caches, never personal audio. */
export async function recordManagedTree({dataDir,ownership,id,name,family,kind='resource',select=()=>true,expectedHashes,scopeToRoot=false}){
  if(!ownership)return false;
  const {root,token,profile}=ownership,marker=await json(await insideDirectory(root,MARKER));
  if(profile!==profileId(dataDir)||marker?.token!==token||marker.owner!==OWNER||marker.profile!==profile)throw fail('资源归属记录已改变。');
  if(scopeToRoot)id+='-'+digest(resolve(root));
  const snapshot=await walk(root),files=[];
  for(const file of snapshot.files)if(file.path!==MARKER&&select(file.path)){
    const sha256=await fileHash(await insideDirectory(root,...file.path.split('/')));
    if(!expectedHashes?.has(file.path)||expectedHashes.get(file.path)===sha256)files.push({...file,sha256});
  }
  const directories=snapshot.directories.filter(path=>select(path+'/')||files.some(file=>file.path.startsWith(path+'/')));
  await atomic(join(receiptsPath(dataDir),digest(id)+'.json'),{owner:OWNER,profile,id,name,family,kind,root,token,files,directories});return true;
}

export class ResourceStorage{
  constructor({dataDir,store,voiceResources,voiceStudio,visionExtension,qqRuntime}={}){this.dataDir=resolve(dataDir);this.store=store;this.voiceResources=voiceResources;this.voiceStudio=voiceStudio;this.visionExtension=visionExtension;this.qqRuntime=qqRuntime;this.plans=new Map();this.pending=new Set();this.closed=false;this.closing=null;}
  ensureOpen(){if(this.closed)throw fail('资源存储控制器已关闭。');}
  async track(operation){
    this.ensureOpen();const task=Promise.resolve().then(operation);this.pending.add(task);
    try{return await task;}finally{this.pending.delete(task);}
  }
  state(){return this.track(()=>this.readState());}
  plan(value={}){return this.track(()=>this.createPlan(value));}
  execute(value={}){return this.track(()=>this.executePlan(value));}
  qq(){const value=typeof this.qqRuntime==='function'?this.qqRuntime():this.qqRuntime;return (Array.isArray(value)?value:[value]).filter(Boolean);}
  async profileDirectories(){
    const directory=join(this.dataDir,'instances');await checkedLocalPath(directory);let entries=[];
    try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    const profiles=[this.dataDir];
    for(const entry of entries)if(entry.isDirectory()||entry.isSymbolicLink())profiles.push(await insideDirectory(directory,entry.name));
    return profiles;
  }
  async activity(qq){
    const voice=this.voiceResources?.state?.(),studio=this.voiceStudio?.state?.(),vision=this.visionExtension?.state?.();
    const result={voice:Boolean(this.voiceResources?.job||this.voiceResources?.operation||voice?.task?.status==='running'||studio?.busy||this.voiceStudio?.coordination?.active||this.voiceStudio?.coordination?.queued),vision:Boolean(this.visionExtension?.busy?.()||vision?.task?.status==='running'||['running','starting'].includes(vision?.runtime?.status)),qq:qq.some(runtime=>Boolean(runtime.state?.()?.running||runtime.installing||runtime.starting||runtime.recoveryError))};
    // A detached QQ daemon may outlive every window. Inspect its existing records only.
    for(const profile of await this.profileDirectories()){
      const accounts=join(profile,'qq','accounts');await checkedLocalPath(accounts);let slots=[];try{slots=await readdir(accounts);}catch(error){if(error.code!=='ENOENT')throw error;}
      for(const slot of slots){try{const record=await json(await insideDirectory(accounts,slot,'process.json'));if(record){const ids=[record.pid,record.childPid,record.launcherPid];result.qq ||= record.version!==1||record.slot!==join(accounts,slot)||!ids.some(pid=>Number.isInteger(pid)&&pid>0)||ids.some(pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}});}}catch{result.qq=true;}}
    }
    return result;
  }
  async readState(){
    this.ensureOpen();const qq=this.qq(),active=await this.activity(qq),owned=await receipts(this.dataDir),resources=[],caches=[];
    for(const receipt of owned){
      let reason='',managed=true,snapshot;try{({snapshot}=await validateRoot(this.dataDir,receipt.root,receipt.token));}catch(error){reason=error.message;managed=false;}
      const present=new Set(snapshot?.files.map(file=>file.path)),files=receipt.files.filter(file=>!snapshot||present.has(file.path));if(!files.length)continue;
      const item={id:receipt.id,name:receipt.name,kind:receipt.kind,family:receipt.family,path:receipt.root,bytes:files.reduce((sum,file)=>sum+file.bytes,0),managed,origin:managed?'managed':'existing',active:active[receipt.family],reason:reason||(active[receipt.family]?'资源正在使用，请先结束任务。':''),actions:managed&&!active[receipt.family]?[receipt.kind==='cache'?'cleanup':'uninstall']:[]};
      (receipt.kind==='cache'?caches:resources).push(item);
    }
    const voice=this.voiceResources?.state?.()||this.store?.getSetting?.('voice.resources')||{},vision=this.visionExtension?.state?.()||this.store?.getSetting?.('vision.extension')||{};
    const existing=(id,name,family,path,type='directory')=>{
      if(typeof path!=='string'||!path||owned.some(item=>item.family===family&&(path===item.root||path.startsWith(item.root+sep))))return;
      // Existing bindings may follow links for read-only reuse; ownership checks never do.
      let info;try{info=statSync(path);}catch{return;}if(type==='file'?!info.isFile():!info.isDirectory())return;
      resources.push({id,name,kind:'resource',family,path,bytes:null,managed:false,origin:'existing',active:active[family],actions:[],reason:'已有资源或旧安装缺少完整所有权清单，仅供复用，保留原目录。'});
    };
    for(const [key,name]of Object.entries({pythonPath:'声音 Python 环境',generatorPath:'声音生成模型',clonePath:'声音克隆模型',codecPath:'声音编解码模型',qwenPythonPath:'Qwen Python 环境',qwenSourcePath:'Qwen 源码',qwenBasePath:'Qwen Base 模型',qwenCustomVoicePath:'Qwen CustomVoice 模型',qwenDesignPath:'Qwen VoiceDesign 模型'}))existing('existing-voice-'+key,name,'voice',voice.config?.[key],/pythonpath/i.test(key)?'file':'directory');
    for(const component of vision.components||[])existing('existing-vision-'+component.id,component.label||component.id,'vision',component.path,'file');
    for(const [key,path]of Object.entries(vision.bindings||{}))existing('existing-vision-'+key,'视觉 '+key,'vision',path,'file');
    const qqPaths=new Set(qq.map(runtime=>runtime.state?.()?.installation?.installDirectory||runtime.config?.installDirectory).filter(Boolean));
    for(const profile of await this.profileDirectories()){const saved=await json(join(profile,'qq','runtime.json'));if(saved?.installDirectory)qqPaths.add(saved.installDirectory);}
    for(const path of qqPaths)existing('existing-qq-'+digest(path),'QQ 独立运行端','qq',path);
    return {resources,caches};
  }
  async checked(id,action){
    const receipt=(await receipts(this.dataDir)).find(item=>item.id===id);if(!receipt)throw fail('该资源没有可验证的受管归属记录，已有目录不会删除。');
    if(action!==(receipt.kind==='cache'?'cleanup':'uninstall'))throw new WorkbenchError(400,'此资源不支持该操作。');
    if((await this.activity(this.qq()))[receipt.family])throw fail('资源正在运行或有活动任务，请先停止使用。');
    const {snapshot}=await validateRoot(this.dataDir,receipt.root,receipt.token,{hashes:true}),current=new Map(snapshot.files.map(file=>[file.path,file]));
    const files=receipt.files.filter(file=>current.has(file.path));if(!files.length)throw fail('资源已回收，请刷新存储列表。');
    const fingerprint=digest([receipt,snapshot]);return {receipt,files,fingerprint,bytes:files.reduce((sum,file)=>sum+file.bytes,0)};
  }
  async createPlan(value={}){
    fields(value,['id','action']);this.ensureOpen();if(typeof value.id!=='string'||!['uninstall','cleanup'].includes(value.action))throw new WorkbenchError(400,'请选择有效的资源和操作。');
    const receipt=(await receipts(this.dataDir)).find(item=>item.id===value.id);if(!receipt)throw fail('该目录没有受管归属记录，已有资源保持不变。');
    const release=acquireResourceStorageLease(this.dataDir,receipt.family,{exclusive:true});try{
      const checked=await this.checked(value.id,value.action),planId=randomUUID(),consequence=value.action==='uninstall'?`将删除「${receipt.name}」的受管文件；再次使用需要重新安装。角色、聊天、个人音色、预设和输出保留。`:`将删除「${receipt.name}」的可再生缓存；后续使用可能重新下载。个人音色、参考音频和输出保留。`;
      const plan={planId,id:value.id,action:value.action,bytes:checked.bytes,consequence,createdAt:Date.now()};this.plans.set(planId,{...plan,fingerprint:checked.fingerprint});return plan;
    }finally{release();}
  }
  async executePlan(value={}){
    fields(value,['planId','confirmed']);this.ensureOpen();if(value.confirmed!==true)throw new WorkbenchError(400,'请明确确认删除后果后执行。');const plan=this.plans.get(value.planId);
    if(!plan||Date.now()-plan.createdAt>10*60*1000)throw fail('回收计划已失效，请重新生成计划。');
    const receipt=(await receipts(this.dataDir)).find(item=>item.id===plan.id);if(!receipt)throw fail('资源归属已改变，请重新生成计划。');
    const release=acquireResourceStorageLease(this.dataDir,receipt.family,{exclusive:true});let voiceRelease;
    try{
      // Lock order is storage family -> existing voice install lock. Installers take the same order.
      if(receipt.family==='voice'&&this.voiceResources?.acquireLock)voiceRelease=await this.voiceResources.acquireLock(new AbortController().signal);
      const checked=await this.checked(plan.id,plan.action);if(checked.fingerprint!==plan.fingerprint)throw fail('资源已改变，回收计划失效，请重新确认。');
      this.plans.delete(value.planId);
      for(const file of checked.files){const path=await insideDirectory(receipt.root,...file.path.split('/')),info=await ordinary(path);if(!info||info.size!==file.bytes||await fileHash(path)!==file.sha256)throw fail('资源文件已改变，停止回收。');await checkedLocalPath(path);await unlink(path);}
      for(const path of [...receipt.directories].sort((a,b)=>b.length-a.length))await rmdir(await insideDirectory(receipt.root,...path.split('/'))).catch(error=>{if(!['ENOENT','ENOTEMPTY'].includes(error.code))throw error;});
      await checkedLocalPath(join(receiptsPath(this.dataDir),digest(receipt.id)+'.json'));await unlink(join(receiptsPath(this.dataDir),digest(receipt.id)+'.json'));
      if((await readdir(receipt.root)).every(name=>name===MARKER)){
        await checkedLocalPath(await insideDirectory(receipt.root,MARKER));await unlink(await insideDirectory(receipt.root,MARKER));await rmdir(receipt.root);
      }
      if(plan.action==='uninstall'&&receipt.family==='voice'&&this.voiceResources){
        for(const [key,id]of Object.entries({generatorPath:'generator',clonePath:'clone',codecPath:'codec',qwenBasePath:null,qwenCustomVoicePath:null,qwenDesignPath:null}))if(this.voiceResources.record?.config?.[key]===receipt.root){this.voiceResources.record.config[key]='';if(id)this.voiceResources.installed[id]=false;delete this.voiceResources.record.bindings[key];}
        const modelPlan=this.voiceResources.record?.modelPlan;if(modelPlan?.directory===receipt.root){modelPlan.status='prepared';delete modelPlan.bindingStatus;delete modelPlan.finishedAt;}
        this.voiceResources.persist?.();
      }
      if(plan.action==='uninstall'&&receipt.family==='vision'&&this.visionExtension){this.visionExtension.record.autoStart=false;this.visionExtension.installed=await this.visionExtension.inspectInstallation();this.visionExtension.persist();}
      if(receipt.family==='qq')for(const runtime of this.qq())runtime.inspect?.();
      return {id:plan.id,action:plan.action,bytes:checked.bytes,removedFiles:checked.files.length};
    }finally{await voiceRelease?.();release();}
  }
  close(){
    if(this.closing)return this.closing;this.closed=true;
    this.closing=Promise.allSettled([...this.pending]).then(()=>{this.plans.clear();});return this.closing;
  }
}
