import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {mkdir,readFile,writeFile,readdir,lstat,stat,rename,rm,statfs} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {WorkbenchError} from './contracts.mjs';
import {downloadVerified} from './vision-download.mjs';
import {extractComponentArchive,hashComponentFile,assertOrdinaryComponentPath,validateComponentManifest} from './component-archive.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const OWNER='AI-Future-Workbench/optional-components/v1',KEY='optional-components.v1';
const MARKER='.component-owner.json',MANIFEST='.component-manifest.json';
const names={'mc-play':'MC 陪玩运行端',training:'训练组件'};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=message=>new WorkbenchError(409,message);
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const readJSON=path=>JSON.parse(readFileSync(path,'utf8'));
export function loadComponentCatalog(){
  const paths=[process.env.AI_FUTURE_COMPONENT_CATALOG,process.resourcesPath&&join(process.resourcesPath,'component-catalog.json'),join(root,'artifacts/optional-components/catalog.json')].filter(Boolean);
  for(const path of paths)if(existsSync(path))return {catalog:readJSON(path),directory:dirname(path)};
  return {catalog:{format:1,components:{}},directory:null};
}
export function existingComponentCandidates(){
  const nodePath=process.env.AI_FUTURE_NODE||(!process.versions.electron?process.execPath:'C:\\Program Files\\nodejs\\node.exe');
  return {'mc-play':[{path:join(root,'integrations/airi-minecraft'),nodePath},...(process.resourcesPath?[{path:join(process.resourcesPath,'airi-minecraft')}]:[])],training:[{path:join(root,'integrations/next-trainer')}]};
}
function descriptorValid(id,d){return d?.id===id&&/^[a-zA-Z0-9._-]{1,120}$/.test(d.version)&&/^[a-zA-Z0-9._-]+\.afcomponent$/.test(d.file)&&/^[a-f0-9]{64}$/.test(d.sha256)&&/^[a-f0-9]{64}$/.test(d.manifestSha256)&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=8*1024**3&&Number.isSafeInteger(d.installedBytes)&&d.installedBytes>=0&&d.installedBytes<=8*1024**3;}
export class OptionalComponents{
  constructor({dataDir,store,catalog,candidates=existingComponentCandidates(),sourceDirectories,fetchImpl=fetch,platform=process.platform,arch=process.arch}={}){
    const loaded=catalog?{catalog,directory:null}:loadComponentCatalog();
    this.catalog=loaded.catalog;if(this.catalog.format!==1||!this.catalog.components)throw new Error('组件发布目录格式无效。');
    for(const [id,d] of Object.entries(this.catalog.components))if(!names[id]||!descriptorValid(id,d))throw new Error('组件发布目录条目无效。');
    this.store=store;this.directory=resolve(dataDir,'resources/optional-components');this.candidates=candidates;this.fetch=fetchImpl;this.platform=platform;this.arch=arch;
    this.sources=sourceDirectories??[loaded.directory,process.resourcesPath&&resolve(process.resourcesPath,'../../components')].filter(Boolean);
    this.jobs=new Map();this.plans=new Map();this.taskResults=new Map();this.pending=new Set();this.closing=false;this.closed=false;this.db=null;
    this.initialized=null;
  }
  saved(){return structuredClone(this.store.getSetting(KEY)||{installed:{},tasks:{},url:''});}
  save(change){return this.transaction(()=>{const value=this.saved();change(value);this.store.setSetting(KEY,value);});}
  async initialize(){
    await assertOrdinaryComponentPath(this.directory,{allowMissing:true});
    await mkdir(this.directory,{recursive:true});
    const marker=join(this.directory,MARKER);
    if(!existsSync(marker)){
      if((await readdir(this.directory)).length)throw fail('组件管理目录已有未知文件，请保留原目录。');
      try{await writeFile(marker,JSON.stringify({owner:OWNER}),{encoding:'utf8',flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    }
    await assertOrdinaryComponentPath(marker);if(readJSON(marker).owner!==OWNER)throw fail('组件管理目录归属不符。');
    const database=join(this.directory,'locks.sqlite');await assertOrdinaryComponentPath(database,{allowMissing:true});
    this.db=new DatabaseSync(database);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,token TEXT,pid INTEGER); CREATE TABLE IF NOT EXISTS leases(token TEXT PRIMARY KEY,id TEXT,path TEXT,owner TEXT,pid INTEGER); CREATE TABLE IF NOT EXISTS cache(path TEXT PRIMARY KEY,id TEXT,descriptor TEXT); CREATE TABLE IF NOT EXISTS trees(path TEXT PRIMARY KEY,id TEXT,descriptor TEXT,manifest TEXT,kind TEXT);');
  }
  ensureOpen(){if(this.closing||this.closed)throw fail('组件管理器正在关闭或已关闭。');}
  track(run){
    try{this.ensureOpen();}catch(error){return Promise.reject(error);}
    const pending=Promise.resolve().then(run);this.pending.add(pending);
    pending.then(()=>this.pending.delete(pending),()=>this.pending.delete(pending));return pending;
  }
  async ready(){this.ensureOpen();this.initialized??=this.initialize().catch(error=>{this.initError=error;});await this.initialized;if(this.initError)throw this.initError;this.ensureOpen();}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{for(const table of ['operations','leases'])for(const item of this.db.prepare(`SELECT token,pid FROM ${table}`).all())if(!Number.isInteger(item.pid)||item.pid<1||!alive(item.pid))this.db.prepare(`DELETE FROM ${table} WHERE token=?`).run(item.token);const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  usage(id){return this.db?this.transaction(()=>this.db.prepare('SELECT owner,pid FROM leases WHERE id=?').all(id)):[];}
  operation(id){this.ensureOpen();return this.transaction(()=>{
    if(this.db.prepare('SELECT 1 FROM operations WHERE id=? OR id=?').get(id,'cache')||id==='cache'&&this.db.prepare('SELECT 1 FROM operations').get())throw fail('组件正在安装或回收，请等待完成。');
    if(id!=='cache'&&this.db.prepare('SELECT 1 FROM leases WHERE id=?').get(id))throw fail('组件仍在使用，停止活动任务后再操作。');
    const token=randomUUID();this.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(id,token,process.pid);
    return ()=>{this.db?.prepare('DELETE FROM operations WHERE token=?').run(token);};
  });}
  owned(path){const target=resolve(path),rel=relative(this.directory,target);if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw fail('组件操作路径超出受管目录。');return target;}
  resolve(id){
    if(!names[id])return null;
    const record=this.saved().installed[id];
    if(record&&this.db?.prepare('SELECT 1 FROM trees WHERE path=? AND kind=?').get(record.path,'removing'))return null;
    if(record){try{const directory=this.owned(record.path);if(lstatSync(directory).isSymbolicLink())return null;const marker=readJSON(join(directory,MARKER));if(marker.owner===OWNER&&marker.sha256===record.descriptor.sha256&&existsSync(join(directory,MANIFEST)))return {path:directory,origin:'managed',version:record.descriptor.version};}catch{}return null;}
    for(const candidate of this.candidates[id]||[]){
      const path=resolve(candidate.path),nodePath=candidate.nodePath||join(path,'runtime',process.platform==='win32'?'node.exe':'node');
      const required=id==='training'?['source-manifest.json','runner.py','catalog.json']:['worker.mjs','node_modules/tsx/package.json','node_modules/isolated-vm/isolated-vm.js'];
      if(required.every(file=>existsSync(join(path,file)))&&(id!=='mc-play'||existsSync(nodePath)))return {path,origin:'existing',version:'已有组件',...(id==='mc-play'?{nodePath}:{})};
    }return null;
  }
  acquire(id,owner){return this.track(()=>this.acquireComponent(id,owner));}
  async acquireComponent(id,owner){
    await this.ready();const current=this.resolve(id);if(!current)throw new WorkbenchError(503,'请先安装'+(names[id]||'所需组件')+'。');
    const token=randomUUID();this.transaction(()=>{if(this.db.prepare('SELECT 1 FROM operations WHERE id=? OR id=?').get(id,'cache'))throw fail('组件正在维护，请稍后重试。');this.db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').run(token,id,current.path,String(owner).slice(0,200),process.pid);});
    let released=false;
    const release=()=>{if(released)return;released=true;if(this.db)this.db.prepare('DELETE FROM leases WHERE token=?').run(token);else{const db=new DatabaseSync(join(this.directory,'locks.sqlite'));try{db.prepare('DELETE FROM leases WHERE token=?').run(token);}finally{db.close();}}};
    try{
      if(current.origin==='managed'){
        const record=this.saved().installed[id],manifest=await this.manifest(record);
        for(const file of manifest.files){const path=join(current.path,...file.path.split('/'));await assertOrdinaryComponentPath(path);if((await stat(path)).size!==file.size||await hashComponentFile(path)!==file.sha256)throw fail('组件文件校验失败，请卸载后重新安装：'+file.path);}
      }
      this.ensureOpen();
      return {...current,release,retain:pid=>{if(!released){if(!Number.isInteger(pid)||pid<=0||!alive(pid))throw fail('组件引用的进程无效。');this.db.prepare('UPDATE leases SET pid=? WHERE token=?').run(pid,token);}}};
    }catch(error){release();throw error;}
  }
  async manifest(record){
    const directory=this.owned(record.path);await assertOrdinaryComponentPath(directory);
    const markerPath=join(directory,MARKER),manifestPath=join(directory,MANIFEST);await assertOrdinaryComponentPath(markerPath);await assertOrdinaryComponentPath(manifestPath);
    const marker=JSON.parse(await readFile(markerPath,'utf8')),text=await readFile(manifestPath,'utf8');
    const manifest=JSON.parse(text);validateComponentManifest(manifest);
    if(marker.owner!==OWNER||marker.sha256!==record.descriptor.sha256||sha(manifest)!==record.descriptor.manifestSha256)throw fail('组件所有权或清单校验失败。');return manifest;
  }
  registeredTree(row){
    const descriptor=JSON.parse(row.descriptor),manifest=JSON.parse(row.manifest),path=this.owned(row.path);
    const total=validateComponentManifest(manifest),expected=row.kind!=='staging'?`${row.id}-${descriptor.version}-${descriptor.sha256?.slice(0,12)}`:null;
    if(!names[row.id]||!descriptorValid(row.id,descriptor)||!['staging','installed','removing'].includes(row.kind)||dirname(path)!==join(this.directory,'packages')
      ||(expected?path!==join(this.directory,'packages',expected):!/^\.staging-[a-f0-9-]{36}$/.test(relative(join(this.directory,'packages'),path)))
      ||sha(manifest)!==descriptor.manifestSha256||total!==descriptor.installedBytes||['id','version','platform','arch'].some(key=>manifest[key]!==descriptor[key]))throw fail('受管组件登记与清单不符，已保留。');
    return {path,id:row.id,kind:row.kind,descriptor,manifest};
  }
  registerTree(path,id,descriptor,manifest,kind){
    const row={path,id,descriptor:JSON.stringify(descriptor),manifest:JSON.stringify(manifest),kind};this.registeredTree(row);
    const previous=this.db.prepare('SELECT * FROM trees WHERE path=?').get(path);
    if(previous&&(previous.id!==id||previous.kind!==kind||previous.descriptor!==row.descriptor||previous.manifest!==row.manifest))throw fail('组件目录已有不同登记，已保留。');
    this.db.prepare('INSERT OR IGNORE INTO trees VALUES(?,?,?,?,?)').run(path,id,row.descriptor,row.manifest,kind);
  }
  async treeSnapshot(tree){
    await assertOrdinaryComponentPath(tree.path,{allowMissing:tree.kind==='removing'});
    if(tree.kind==='removing'&&!existsSync(tree.path))return [];
    if(tree.kind==='installed')await this.manifest(tree);
    const files=await this.snapshot(tree.path,tree.manifest),byPath=new Map(files.map(file=>[relative(tree.path,file.path).split(sep).join('/'),file]));
    for(const file of tree.manifest.files){
      const present=byPath.get(file.path);
      if(!present){if(tree.kind==='installed')throw fail('旧版本文件缺失，已保留。');continue;}
      if(present.size>file.size||tree.kind!=='staging'&&present.size!==file.size||present.size===file.size&&await hashComponentFile(present.path)!==file.sha256)throw fail('受管组件文件已改变，已保留：'+file.path);
    }
    return files;
  }
  state(){return this.track(async()=>{
    await this.ready();const saved=this.saved();
    return {directory:this.directory,url:saved.url||'',components:Object.keys(names).map(id=>{
      const current=this.resolve(id),descriptor=this.catalog.components[id],local=this.taskResults.get(id),record=saved.installed[id];
      let canResumeUninstall=false;
      const row=record&&this.db.prepare('SELECT * FROM trees WHERE path=? AND kind=?').get(record.path,'removing');
      if(row){try{const tree=this.registeredTree(row);canResumeUninstall=tree.id===id&&tree.descriptor.sha256===record.descriptor.sha256;}catch{}}
      const task=this.jobs.get(id)?.task||(local?.id===saved.tasks[id]?.id?local:null)||saved.tasks[id];
      return {id,name:names[id],ready:!!current,...current,...(canResumeUninstall?{path:record.path,version:record.descriptor.version}:{}),managed:!!record,canResumeUninstall,descriptor,canInstall:!!descriptor&&!canResumeUninstall,task:task&&{...task,status:task.status==='running'&&!alive(task.pid)?'interrupted':task.status},users:this.usage(id)};
    })};
  });}
  setSource({url}){return this.track(async()=>{await this.ready();if(typeof url!=='string'||url.length>2048)throw fail('组件下载源无效。');if(url){const parsed=new URL(url);if(parsed.username||parsed.password||parsed.hash||parsed.search||!(parsed.protocol==='https:'||parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))throw fail('下载源须为 HTTPS 或本机 HTTP 地址。');url=parsed.href.replace(/\/?$/,'/');}this.save(record=>record.url=url);return this.state();});}
  install(id,options={}){return this.track(()=>this.startInstall(id,options));}
  async startInstall(id,{file}={}){
    await this.ready();const descriptor=this.catalog.components[id];if(!descriptor)throw fail('当前发行版没有此组件包，请先生成组件发布目录。');
    if(descriptor.platform!==this.platform||descriptor.arch!==this.arch)throw fail('组件平台或架构不匹配。');
    const current=this.resolve(id),saved=this.saved().installed[id];
    if(current&&(current.origin==='existing'||saved?.descriptor.sha256===descriptor.sha256)){const lease=await this.acquire(id,'reuse');lease.release();return {reused:true,component:current};}
    if(this.jobs.has(id))throw fail('组件正在安装。');
    const release=this.operation(id),controller=new AbortController();
    const task={id:randomUUID(),status:'running',stage:'preparing',completedBytes:0,totalBytes:descriptor.bytes,pid:process.pid};
    const job={controller,task};
    try{this.save(record=>record.tasks[id]=task);this.taskResults.delete(id);this.jobs.set(id,job);}catch(error){release();throw error;}
    job.promise=this.performInstall(id,descriptor,file,job).then(()=>{task.status='completed';task.stage='completed';},error=>{task.status=controller.signal.aborted?'cancelled':'failed';task.error=error.message;}).finally(()=>{
      try{this.save(record=>record.tasks[id]=task);}
      catch(error){task.status='failed';task.error='组件任务记录保存失败：'+error.message;this.taskResults.set(id,{...task});}
      finally{this.jobs.delete(id);release();}
    });
    return {task:{...task}};
  }
  async performInstall(id,descriptor,file,job){
    const signal=job.controller.signal,packages=join(this.directory,'packages'),cache=join(this.directory,'downloads');
    await assertOrdinaryComponentPath(packages,{allowMissing:true});await assertOrdinaryComponentPath(cache,{allowMissing:true});
    await mkdir(packages,{recursive:true});await mkdir(cache,{recursive:true});
    const destination=join(packages,id+'-'+descriptor.version+'-'+descriptor.sha256.slice(0,12)),previous=this.saved().installed[id];
    if(previous&&previous.path!==destination&&existsSync(previous.path))this.registerTree(previous.path,id,previous.descriptor,await this.manifest(previous),'installed');
    if(existsSync(destination)){
      const row=this.db.prepare('SELECT * FROM trees WHERE path=?').get(destination);
      if(!row)throw fail('同版本组件目录已有未知内容，请保留原目录。');
      const tree=this.registeredTree(row);
      if(tree.kind!=='installed'||tree.descriptor.sha256!==descriptor.sha256)throw fail('同版本组件登记不匹配。');
      await this.treeSnapshot(tree);signal.throwIfAborted();this.save(record=>record.installed[id]={path:destination,descriptor});return;
    }
    const priorRegistration=this.db.prepare('SELECT * FROM trees WHERE path=?').get(destination);
    if(priorRegistration){this.registeredTree(priorRegistration);this.db.prepare('DELETE FROM trees WHERE path=?').run(destination);}
    const space=await statfs(this.directory);if(Number(space.bavail)*Number(space.bsize)<descriptor.installedBytes+descriptor.bytes)throw fail('安装组件的可用空间不足。');
    let archive=file;
    if(!archive)for(const directory of this.sources){const candidate=join(directory,descriptor.file);if(existsSync(candidate)){archive=candidate;break;}}
    if(!archive){
      const source=this.saved().url;if(!source)throw fail('尚未设置下载源，请选择本地组件包。');
      archive=join(cache,id+'-'+descriptor.sha256+'.afcomponent');this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?,?)').run(archive,id,JSON.stringify(descriptor));
      await downloadVerified({file:{...descriptor,filename:descriptor.file,url:new URL(descriptor.file,source).href},target:archive,fetchImpl:this.fetch,signal,idleTimeoutMs:30000,onProgress:bytes=>job.task.completedBytes=bytes,onStage:stage=>job.task.stage=stage});
    }
    signal.throwIfAborted();job.task.stage='extracting';
    const staging=join(packages,'.staging-'+randomUUID());
    let manifest;
    try{
      // 先持久登记认证清单，再创建暂存树；异常退出后仍能核验归属。
      manifest=await extractComponentArchive({archive,directory:staging,descriptor,signal,onManifest:value=>{if(value.files.some(file=>[MARKER,MANIFEST].includes(file.path.toLowerCase())))throw fail('组件清单使用保留文件名。');this.registerTree(staging,id,descriptor,value,'staging');manifest=value;},onProgress:progress=>Object.assign(job.task,progress)});
      await writeFile(join(staging,MARKER),JSON.stringify({owner:OWNER,id,sha256:descriptor.sha256}),'utf8');
      await writeFile(join(staging,MANIFEST),JSON.stringify(manifest),'utf8');signal.throwIfAborted();
      if(existsSync(destination))throw fail('同版本组件目录已存在，请先检查或卸载原受管组件。');
      this.registerTree(destination,id,descriptor,manifest,'installed');
      await rename(staging,destination);
      try{this.save(record=>record.installed[id]={path:destination,descriptor});}catch(error){await rename(destination,staging);throw error;}
    }finally{
      if(existsSync(staging)&&manifest){await this.snapshot(staging,manifest);await rm(this.owned(staging),{recursive:true,force:true});}
      if(!existsSync(staging))this.db.prepare('DELETE FROM trees WHERE path=?').run(staging);
    }
  }
  cancel(id){return this.track(async()=>{await this.ready();const job=this.jobs.get(id);if(job){job.controller.abort();await job.promise;}return this.state();});}
  async snapshot(directory,manifest){
    this.owned(directory);await assertOrdinaryComponentPath(directory);
    const known=new Set(manifest.files.map(file=>file.path));known.add(MARKER);known.add(MANIFEST);const files=[];
    const walk=async path=>{for(const entry of await readdir(path,{withFileTypes:true})){const target=join(path,entry.name),name=relative(directory,target).split(sep).join('/');if(entry.isSymbolicLink())throw fail('受管目录含链接，已保留。');if(entry.isDirectory()){if(!manifest.files.some(file=>file.path.startsWith(name+'/')))throw fail('受管目录含未知目录，已保留。');await walk(target);}else{if(!known.has(name))throw fail('受管目录含未知文件，已保留。');const info=await lstat(target);if(!info.isFile())throw fail('受管目录文件类型无效。');files.push({path:target,size:info.size,mtimeMs:info.mtimeMs,ino:String(info.ino)});}}};await walk(directory);files.sort((a,b)=>a.path.localeCompare(b.path));return files;
  }
  storage(){return this.track(async()=>{await this.ready();return this.inspectStorage();});}
  async inspectStorage(){
    const caches=[],trees=[],installed=new Set(Object.values(this.saved().installed).map(record=>resolve(record.path)));
    const references=this.transaction(()=>({operations:this.db.prepare('SELECT id FROM operations').all(),leases:this.db.prepare('SELECT path FROM leases').all()}));
    for(const record of this.db.prepare('SELECT * FROM cache').all())for(const path of [record.path,record.path+'.part']){this.owned(path);await assertOrdinaryComponentPath(path,{allowMissing:true});try{const info=await stat(path);if(!info.isFile())throw fail('缓存不是普通文件。');caches.push({path,size:info.size,mtimeMs:info.mtimeMs,ino:String(info.ino)});}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const row of this.db.prepare('SELECT * FROM trees').all()){
      const tree=this.registeredTree(row);
      if(installed.has(tree.path)||references.operations.some(operation=>operation.id===tree.id)||references.leases.some(lease=>resolve(lease.path)===tree.path))continue;
      await assertOrdinaryComponentPath(tree.path,{allowMissing:true});if(!existsSync(tree.path))continue;
      trees.push({path:tree.path,id:tree.id,kind:tree.kind,files:await this.treeSnapshot(tree)});
    }
    caches.sort((a,b)=>a.path.localeCompare(b.path));trees.sort((a,b)=>a.path.localeCompare(b.path));
    return {cacheBytes:[...caches,...trees.flatMap(tree=>tree.files)].reduce((sum,file)=>sum+file.size,0),caches,trees};
  }
  plan(options){return this.track(async()=>{await this.ready();return this.createPlan(options);});}
  async createPlan({id,action}){
    let files,directory,removalTree,trees=[],cacheFiles=[];
    if(action==='cleanup'&&id==='cache'){const storage=await this.inspectStorage();trees=storage.trees;cacheFiles=storage.caches;files=[...cacheFiles,...trees.flatMap(tree=>tree.files)];}
    else if(action==='uninstall'&&names[id]){
      if(this.usage(id).length)throw fail('组件仍在使用，请停止活动任务。');
      const record=this.saved().installed[id];if(!record)throw fail('已有外部复用组件不属于工作台受管资源，不能删除。');directory=record.path;
      const row=this.db.prepare('SELECT * FROM trees WHERE path=?').get(directory);
      if(row?.kind==='removing'){
        removalTree=this.registeredTree(row);
        if(removalTree.id!==id||removalTree.descriptor.sha256!==record.descriptor.sha256)throw fail('组件移除登记不匹配。');
        files=await this.treeSnapshot(removalTree);
      }else{const manifest=await this.manifest(record);files=await this.snapshot(directory,manifest);removalTree={path:directory,id,descriptor:record.descriptor,manifest,kind:'installed'};}
    }
    else throw fail('资源回收操作无效。');
    const planId=randomUUID(),plan={planId,id,action,directory,files,trees,cacheFiles,removalTree,fingerprint:sha({directory,files,trees,removal:removalTree?.descriptor.sha256}),expires:Date.now()+15*60000};this.plans.set(planId,plan);
    return {planId,id,action,bytes:files.reduce((sum,file)=>sum+file.size,0),consequence:action==='uninstall'?'将删除此受管组件，角色、聊天、训练产物和外部环境保留。':'将删除组件下载缓存、已登记的旧版本和中断暂存；当前组件和个人资料保留。'};
  }
  execute(options){return this.track(()=>this.executePlan(options));}
  async executePlan({planId,confirmed}){
    await this.ready();const plan=this.plans.get(planId);if(!plan||plan.expires<Date.now()||confirmed!==true)throw fail('回收计划失效或尚未确认。');
    const release=this.operation(plan.id);
    try{
      const current=await this.createPlan({id:plan.id,action:plan.action}),fresh=this.plans.get(current.planId);this.plans.delete(current.planId);
      if(fresh.fingerprint!==plan.fingerprint)throw fail('资源内容发生变化，请重新查看回收计划。');
      if(plan.action==='uninstall'){
        const tree=fresh.removalTree;
        if(tree.kind!=='removing')this.registerTree(tree.path,tree.id,tree.descriptor,tree.manifest,'installed');
        this.db.prepare('UPDATE trees SET kind=? WHERE path=?').run('removing',tree.path);
        await assertOrdinaryComponentPath(this.owned(plan.directory),{allowMissing:true});await rm(plan.directory,{recursive:true,force:true});
        this.save(record=>delete record.installed[plan.id]);this.db.prepare('DELETE FROM trees WHERE path=?').run(plan.directory);
      }
      else{
        for(const file of plan.cacheFiles){await assertOrdinaryComponentPath(this.owned(file.path));await rm(file.path);}
        for(const tree of plan.trees){
          if(tree.kind==='installed')this.db.prepare('UPDATE trees SET kind=? WHERE path=?').run('removing',tree.path);
          await assertOrdinaryComponentPath(this.owned(tree.path));await rm(tree.path,{recursive:true});this.db.prepare('DELETE FROM trees WHERE path=?').run(tree.path);
        }
      }
      this.plans.delete(planId);return {completed:true,reclaimedBytes:current.bytes};
    }finally{release();}
  }
  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;
    this.closePromise=(async()=>{
      await this.initialized;for(const job of this.jobs.values())job.controller.abort();
      while(this.pending.size||this.jobs.size)await Promise.allSettled([...this.pending,...[...this.jobs.values()].map(job=>job.promise)]);
      this.closed=true;this.db?.close();this.db=null;
    })();return this.closePromise;
  }
}
