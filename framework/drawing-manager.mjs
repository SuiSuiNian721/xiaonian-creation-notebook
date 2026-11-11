import { mkdir, rename, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkbenchError, fields, identifier } from './contracts.mjs';
import { checkedLocalPath, insideDirectory } from './drawing-files.mjs';
import { isComfyDirectory, pythonForComfy } from './drawing-workflows.mjs';
import { DrawingDownloads } from './drawing-downloads.mjs';
import { RepositoryAccess, runManaged, exists, digest, publicRemote } from './drawing-repositories.mjs';
import { readRepositories, repositoryFingerprint, scanInventory } from './drawing-inventory.mjs';
import { DrawingSnapshots, readConfigFiles, SNAPSHOT_SCOPE, CONFIG_FILES } from './drawing-snapshots.mjs';
export { runManaged } from './drawing-repositories.mjs';

const now=()=>new Date().toISOString();
const ACTIVE=new Set(['queued','running']);
const titles={'install-plugin':'安装插件',update:'更新 Git 版本','disable-plugin':'停用插件','enable-plugin':'启用插件',dependencies:'安装 Python 依赖',restore:'恢复快照'};
const conflict=message=>new WorkbenchError(409,message);
const clean=repo=>{if(repo.git?.dirty)throw conflict(`${repo.name} 存在未提交或未跟踪文件，请先处理后再操作。`);};
const samePath=(a,b)=>!!a&&!!b&&(process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));
function includeDownload(catalog,task){
  if(!catalog||!samePath(catalog.comfyPath,task.comfyPath))return false;
  const model={id:digest(task.target),name:task.filename,category:task.category,path:task.target,size:task.downloadedBytes,source:task.source,sha256:task.actualSha256||null};
  const index=catalog.models.findIndex(item=>samePath(item.path,task.target));
  if(index===-1)catalog.models.push(model);else catalog.models[index]=model;
  return true;
}

export class DrawingManager {
  constructor({drawing,store,dataDir,fetchImpl=fetch,runner=runManaged,isRunning,allowLocalRepositories=false,planTtlMs=15*60*1000,coordination}){
    this.drawing=drawing;this.store=store;this.directory=join(dataDir,'drawing');this.fetch=fetchImpl;this.runner=runner;this.isRunning=isRunning;this.planTtlMs=planTtlMs;
    this.coordination=coordination;
    this.repositories=new RepositoryAccess({runner,directory:this.directory,allowLocalRepositories});
    this.downloads=new DrawingDownloads({store,directory:this.directory,config:()=>drawing.config(),fetchImpl,onCompleted:task=>{
      if(!samePath(this.catalog?.comfyPath,task.comfyPath)&&samePath(drawing.config().comfyPath,task.comfyPath)){
        this.catalog={at:now(),comfyPath:task.comfyPath,partial:true,models:[],repositories:[],warnings:['仅包含下载后登记的模型，尚未完整索引本机模型与插件。']};
      }
      if(includeDownload(this.catalog,task))this.store.setSetting('drawing.inventory',this.catalog);
    }});
    this.snapshots=new DrawingSnapshots(this);this.catalog=store.getSetting('drawing.inventory')||null;
    this.tasks=store.getSetting('drawing.manager.tasks')||[];this.plans=new Map();this.applying=new Map();this.pending=new Set();this.controllers=new Set();this.closed=false;this.active=null;this.snapshotting=false;
    let changed=false;for(const task of this.tasks)if(ACTIVE.has(task.status)){task.status='interrupted';task.error='上次管理任务已中断，请检查环境后重新预览；不会自动重做。';task.updatedAt=now();changed=true;}if(changed)this.persist();
  }
  open(){if(this.closed)throw conflict('资源管理已关闭。');}
  assertIdle(){this.open();if(this.active||this.applying.size)throw conflict('环境管理任务正在准备或运行，请等待结束后再启动 ComfyUI。');}
  persist(){this.store.setSetting('drawing.manager.tasks',this.tasks);}
  state(){return structuredClone({inventory:samePath(this.catalog?.comfyPath,this.drawing.config().comfyPath)?this.catalog:null,downloads:this.downloads.list(),snapshots:this.snapshots.list(),tasks:this.tasks.slice().reverse()});}
  logs(id){identifier(id,'任务标识');const task=this.tasks.find(item=>item.id===id);if(!task)throw new WorkbenchError(404,'找不到这个管理任务。');const {title,status,error,createdAt,updatedAt}=task;return {text:task.log||'',truncated:!!task.logTruncated,task:{id,title,status,error,createdAt,updatedAt}};}
  async root(){this.open();const root=await checkedLocalPath(this.drawing.config().comfyPath);if(!isComfyDirectory(root))throw new WorkbenchError(400,'请先配置有效的 ComfyUI 本体目录。');return root;}
  async python(root,settings=this.drawing.runtime.settings()){const executable=await checkedLocalPath(settings.pythonPath||pythonForComfy(root));if(!(await lstat(executable)).isFile())throw new WorkbenchError(400,'Python 路径不是文件。');return executable;}
  track(work){this.open();const controller=new AbortController();this.controllers.add(controller);const promise=Promise.resolve().then(()=>work(controller.signal)).finally(()=>{this.controllers.delete(controller);this.pending.delete(promise);});this.pending.add(promise);return promise;}
  inventory(){return this.track(async signal=>{
    const comfyPath=await this.root();const downloads=this.downloads.list();const completed=new Set(downloads.filter(task=>task.status==='completed').map(task=>task.id));
    const result=await scanInventory(comfyPath,this.repositories,{signal,downloads});this.open();if(comfyPath!==await this.root())throw conflict('扫描期间 ComfyUI 路径发生变化，请重新扫描。');
    // 扫描期间完成的下载可能错过目录枚举，合并已发布文件，避免覆盖完成通知。
    for(const task of this.downloads.list())if(task.status==='completed'&&!completed.has(task.id))includeDownload(result,task);
    this.catalog=result;this.store.setSetting('drawing.inventory',result);return structuredClone(result);
  });}
  snapshot(value={}){
    this.open();if(this.active||this.applying.size||this.snapshotting)return Promise.reject(conflict('环境管理任务或快照正在运行，请等待结束后再创建快照。'));
    this.snapshotting=true;return this.track(signal=>this.snapshots.create(value,{signal})).finally(()=>{this.snapshotting=false;});
  }
  snapshotById(id){return this.snapshots.get(id);}
  configFingerprint(){return digest({config:this.drawing.config(),runtime:this.drawing.runtime.settings()});}
  async records(root,signal){const warnings=[];const records=await readRepositories(root,this.repositories,{signal,warnings});return {records,warnings};}
  repo(records,id){if(typeof id!=='string')throw new WorkbenchError(400,'请选择插件或本体。');const matches=records.filter(x=>x.id===id);if(matches.length!==1)throw conflict(matches.length?'启用与停用目录同名冲突，请先处理。':'所选仓库不存在或不可安全读取。');return matches[0];}
  async absent(path){await checkedLocalPath(path);if(await exists(path))throw conflict('目标已存在同名文件或目录，无法覆盖。');}
  async offline(root){
    if(this.drawing.launchPromise||this.drawing.runtime.launchPromise)throw conflict('ComfyUI 正在启动，请先等待启动结束并退出服务。');
    const config=this.drawing.config();let url;try{url=new URL(config.serviceUrl);}catch{throw conflict('请配置本机 ComfyUI 服务地址后再管理环境。');}
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw conflict('环境管理仅支持本机 ComfyUI 服务地址。');
    if(this.isRunning){if(await this.isRunning({comfyPath:root,url:url.href}))throw conflict('ComfyUI 正在运行，请退出后再应用。');return;}
    const launch=this.drawing.runtime.launchRecord;if(launch?.pid&&(!launch.cwd||launch.cwd.toLowerCase()===root.toLowerCase())){try{process.kill(launch.pid,0);throw conflict('ComfyUI 启动记录中的进程仍在运行，请退出后再应用。');}catch(error){if(error.code!=='ESRCH')throw conflict('ComfyUI 进程仍在运行或无法确认已退出。');}}
    try{await this.fetch(new URL('system_stats',url),{signal:AbortSignal.timeout(1800),redirect:'error'});throw conflict('ComfyUI 服务仍有响应，请退出后再应用。');}
    catch(error){let current=error;while(current){if(current.code==='ECONNREFUSED')return;current=current.cause;}throw conflict('无法确认 ComfyUI 已离线；请退出服务并确认本机地址可用。');}
  }
  plan(value){return this.track(signal=>this.makePlan(value,signal));}
  async makePlan(value,signal){
    fields(value,['operation','url','name','repositoryId','revision','snapshotId']);if(!titles[value.operation])throw new WorkbenchError(400,'不支持的管理操作。');
    const root=await this.root();const configKey=this.configFingerprint();const {records,warnings}=await this.records(root,signal);
    const plan={id:randomUUID(),operation:value.operation,title:titles[value.operation],changes:[],warnings:[...warnings],createdAt:now(),expiresAt:new Date(Date.now()+this.planTtlMs).toISOString(),comfyPath:root,configKey,targets:[],internal:{}};
    const remember=repo=>plan.targets.push({id:repo.id,fingerprint:repositoryFingerprint(repo)});
    if(value.operation==='install-plugin'){
      const source=this.repositories.source(value.url);const name=this.repositories.name(source,value.name);const destination=await insideDirectory(root,'custom_nodes',name);
      await this.absent(destination);await this.absent(destination+'.disabled');
      const target=await this.repositories.remoteTarget(source,'HEAD',{signal,cwd:root});plan.internal={source,name,destination,target};
      plan.changes.push({label:name,path:destination,source:publicRemote(source),before:'未安装',after:`${publicRemote(source)} @ ${target.sha}`});plan.warnings.push('仅安装插件代码，不运行 install.py，也不自动安装 Python 依赖。');
    }else if(value.operation==='restore'){
      const snapshot=await this.snapshots.get(value.snapshotId);if(snapshot.comfyPath!==root)throw conflict('快照属于另一 ComfyUI 目录，不能恢复到当前目录。');
      for(const saved of snapshot.repositories){
        clean(saved);const current=this.repo(records,saved.id);clean(current);remember(current);
        if(saved.git){if(!current.git)throw conflict(`${saved.name} 已不再是 Git 仓库。`);await this.repositories.git(current.path,['cat-file','-e',`${saved.git.head}^{commit}`],{signal});}
        const destination=saved.kind==='core'?root:await insideDirectory(root,'custom_nodes',saved.name+(saved.enabled?'':'.disabled'));
        if(destination!==current.path)await this.absent(destination);
        plan.changes.push({label:saved.name,path:current.path,source:publicRemote(current.git?.remote),before:`${current.git?.head||'本地文件'}${current.git?` (${current.git.branch||'分离 HEAD'})`:''} · ${current.enabled?'启用':'停用'}`,after:`${saved.git?.head||'本地文件'}${saved.git?` (${saved.git.branch||'分离 HEAD'})`:''} · ${saved.enabled?'启用':'停用'}`});
      }
      await this.protectRestoredResources(snapshot,records,signal);
      plan.changes.push({label:'运行设置',before:JSON.stringify(this.drawing.runtime.settings()),after:JSON.stringify(snapshot.runtimeSettings)});
      for(const file of snapshot.files.filter(x=>x.exists))plan.changes.push({label:file.relativePath,path:join(root,file.relativePath),before:'当前文件',after:file.sha256});
      plan.internal={snapshotId:snapshot.id,filesKey:digest(await readConfigFiles(root))};plan.warnings.push(SNAPSHOT_SCOPE,'已前进的同名分支会先保留备份分支，再恢复其原位置。快照未保存的配置文件保持当前状态。');
    }else{
      const repo=this.repo(records,value.repositoryId);remember(repo);plan.internal={repositoryId:repo.id};
      if(value.operation==='update'){
        clean(repo);if(!repo.git?.remote)throw conflict('该目录不是带 origin 的 Git 仓库。');
        if(!value.revision&&!repo.git.branch)throw conflict('当前是分离 HEAD，请明确填写远端分支或标签。');
        const source=this.repositories.source(repo.git.remote);const revision=value.revision||repo.git.branch;const target=await this.repositories.remoteTarget(source,revision,{signal,cwd:root});
        plan.internal={...plan.internal,source,target,detached:!!value.revision};plan.changes.push({label:repo.name,path:repo.path,source:publicRemote(source),before:`${repo.git.head} (${repo.git.branch||'分离 HEAD'})`,after:`${target.sha} (${value.revision?'分离 HEAD':repo.git.branch+'，仅快进'})`});
        plan.warnings.push('不自动安装依赖；本地分支与提交保留。');
      }else if(value.operation==='dependencies'){
        if(repo.kind!=='plugin'||!repo.requirementsInfo)throw conflict('该插件没有 requirements.txt，无法安装依赖；不执行 install.py。');
        plan.internal.python=await this.python(root);plan.changes.push({label:repo.name,path:repo.path,source:publicRemote(repo.git?.remote),before:'当前 Python 环境',after:`${plan.internal.python} -m pip install -r ${repo.requirementsInfo.path}`});plan.warnings.push('将安装第三方 Python 依赖，可能变更现有环境；快照只记录依赖清单，不能自动回退 Python。');
      }else{
        if(repo.kind!=='plugin')throw conflict('本体不能启用或停用。');const enabled=value.operation==='enable-plugin';if(repo.enabled===enabled)throw conflict('插件已处于所选状态。');
        const destination=await insideDirectory(root,'custom_nodes',repo.name+(enabled?'':'.disabled'));await this.absent(destination);plan.internal.destination=destination;plan.changes.push({label:repo.name,path:repo.path,source:publicRemote(repo.git?.remote),before:repo.path,after:destination});
      }
    }
    this.open();if(configKey!==this.configFingerprint())throw conflict('配置发生变化，请重新预览。');if(this.plans.size>=200)this.plans.delete(this.plans.keys().next().value);this.plans.set(plan.id,plan);return this.publicPlan(plan);
  }
  publicPlan(plan){const {configKey,targets,internal,...value}=plan;return structuredClone(value);}
  async validate(plan,signal){
    if(Date.now()>Date.parse(plan.expiresAt)||plan.configKey!==this.configFingerprint()||plan.comfyPath!==await this.root())throw conflict('计划已过期或配置发生变化，请重新预览。');
    const {records}=await this.records(plan.comfyPath,signal);for(const target of plan.targets){const repo=this.repo(records,target.id);if(repositoryFingerprint(repo)!==target.fingerprint)throw conflict('仓库状态或来源已发生变化，请重新预览。');}
    if(plan.internal.filesKey&&plan.internal.filesKey!==digest(await readConfigFiles(plan.comfyPath)))throw conflict('配置文件发生变化，请重新预览。');
    if(plan.internal.destination)await this.absent(plan.internal.destination);
    if(plan.operation==='install-plugin')await this.absent(plan.internal.destination+'.disabled');
    return records;
  }
  apply(value){return this.coordination?this.coordination.run('maintenance',()=>this.applyInternal(value)):this.applyInternal(value);}
  applyInternal(value){
    fields(value,['planId']);identifier(value.planId,'计划标识');this.open();const existing=this.tasks.find(x=>x.planId===value.planId);if(existing)return Promise.resolve(structuredClone(existing));
    if(this.applying.has(value.planId))return this.applying.get(value.planId);
    const promise=this.track(signal=>this.prepareApply(value.planId,signal)).finally(()=>this.applying.delete(value.planId));this.applying.set(value.planId,promise);return promise;
  }
  async prepareApply(planId,signal){
    const plan=this.plans.get(planId);if(!plan)throw conflict('计划不存在或服务已重启，请重新预览。');
    if(this.active||this.snapshotting)throw conflict('已有环境管理任务或手工快照运行，请等待结束。');
    await this.validate(plan,signal);await this.offline(plan.comfyPath);this.open();if(this.active||this.snapshotting)throw conflict('已有环境管理任务或手工快照运行，请等待结束。');
    const task={id:randomUUID(),planId,operation:plan.operation,title:plan.title,status:'queued',comfyPath:plan.comfyPath,createdAt:now(),updatedAt:now(),log:'',error:null,snapshotId:null};
    this.tasks.push(task);try{this.persist();}catch(error){this.tasks.pop();throw error;}
    this.active=task.id;
    const job=this.track(jobSignal=>this.execute(plan,task,jobSignal)).catch(error=>{task.status=this.closed?'interrupted':'failed';task.error=`任务记录无法保存：${error.message}`;task.updatedAt=now();}).finally(()=>{this.active=null;});
    // Keep the fully caught promise in pending too, so closing cannot race the failure handler.
    this.pending.add(job);job.finally(()=>this.pending.delete(job));return structuredClone(task);
  }
  update(task,value){Object.assign(task,value,{updatedAt:now()});this.persist();}
  appendLog(task,message){const value=task.log+message;let log=value.slice(-32000);if(/^[\uDC00-\uDFFF]/.test(log))log=log.slice(1);this.update(task,{log,logTruncated:!!task.logTruncated||value.length>32000});}
  log(task,message){this.appendLog(task,message+'\n');}
  async execute(plan,task,signal){
    try{
      this.update(task,{status:'running'});await this.validate(plan,signal);await this.offline(plan.comfyPath);
      const snapshot=await this.snapshots.create({name:`${plan.title}前`},{comfyPath:plan.comfyPath,signal,reason:plan.operation});this.update(task,{snapshotId:snapshot.id});this.log(task,`已保存快照 ${snapshot.id}`);
      const records=await this.validate(plan,signal);await this.offline(plan.comfyPath);if(signal.aborted)throw conflict('操作已取消。');
      const operation=plan.operation;const internal=plan.internal;const repo=internal.repositoryId?this.repo(records,internal.repositoryId):null;
      const outputOptions={signal,onOutput:chunk=>this.appendLog(task,chunk)};
      if(operation==='install-plugin'){
        const target=await this.repositories.remoteTarget(internal.source,'HEAD',{signal,cwd:plan.comfyPath});if(target.sha!==internal.target.sha)throw conflict('远端来源发生变化，请重新预览。');
        // A disabled staging directory on the target volume keeps publication atomic even when app data is on C: and ComfyUI is on another disk.
        const stage=await insideDirectory(plan.comfyPath,'custom_nodes',`.ai-future-${task.id}.disabled`);await mkdir(dirname(stage),{recursive:true});await mkdir(stage);
        this.update(task,{stagingPath:stage});this.log(task,`暂存目录（未发布，失败或中断后保持停用）：${stage}`);
        await this.repositories.git(plan.comfyPath,['clone','--progress','--no-checkout','--',internal.source,stage],outputOptions);
        await this.repositories.git(stage,['checkout','--no-overwrite-ignore','--detach',internal.target.sha],outputOptions);
        if((await this.repositories.inspect(stage,{signal})).head!==internal.target.sha)throw conflict('下载后的提交与计划不一致。');
        if(internal.target.ref.startsWith('refs/heads/'))await this.repositories.git(stage,['checkout','--no-overwrite-ignore','-B',internal.target.ref.slice(11),internal.target.sha],outputOptions);
        await this.validate(plan,signal);await this.offline(plan.comfyPath);await checkedLocalPath(internal.destination);await rename(stage,internal.destination);this.update(task,{stagingPath:null});
      }else if(operation==='update'){
        const target=await this.repositories.remoteTarget(internal.source,internal.target.ref,{signal,cwd:repo.path});if(target.sha!==internal.target.sha)throw conflict('远端版本发生变化，请重新预览。');
        await this.repositories.git(repo.path,['fetch','--progress','--no-tags','--no-recurse-submodules','--',internal.source,internal.target.ref],outputOptions);
        const fetched=(await this.repositories.git(repo.path,['rev-parse','FETCH_HEAD^{commit}'],{signal})).stdout.trim();if(fetched!==internal.target.sha)throw conflict('实际获取的提交与计划不一致。');
        await this.validate(plan,signal);await this.offline(plan.comfyPath);
        if(internal.detached)await this.repositories.git(repo.path,['checkout','--no-overwrite-ignore','--detach',internal.target.sha],outputOptions);else await this.repositories.git(repo.path,['merge','--ff-only','--no-overwrite-ignore',internal.target.sha],outputOptions);
      }else if(operation==='dependencies'){
        let streamed=false;
        const result=await this.runner(internal.python,['-I','-m','pip','install','-r',repo.requirementsInfo.path],{cwd:repo.path,signal,timeoutMs:30*60*1000,maxBytes:2*1024*1024,onOutput:chunk=>{streamed=true;this.appendLog(task,chunk);}});
        if(!streamed)this.log(task,[result.stdout,result.stderr].filter(Boolean).join('\n'));if(result.code!==0||result.error)throw conflict(result.error||`依赖安装失败，退出码 ${result.code}。请查看日志；Python 环境可能已发生部分变更。`);
      }else if(operation==='restore'){
        const saved=await this.snapshots.get(internal.snapshotId);await this.restore(saved,records,task,signal,plan.configKey);
      }else {await checkedLocalPath(repo.path);await this.absent(internal.destination);await rename(repo.path,internal.destination);}
      this.update(task,{status:'completed'});this.log(task,'操作完成。请主动重新索引查看环境。');
    }catch(error){this.update(task,{status:signal.aborted||this.closed?'interrupted':'failed',error:error.message});}
  }
  async restore(snapshot,records,task,signal,configKey){
    // Validate all files and all commit objects before touching the first repository.
    for(const file of snapshot.files){if(!CONFIG_FILES.includes(file.relativePath))throw conflict('快照含不支持的配置路径。');if(file.exists&&digest(Buffer.from(file.bytes,'base64'))!==file.sha256)throw conflict('配置备份校验失败。');await insideDirectory(snapshot.comfyPath,file.relativePath);}
    for(const saved of snapshot.repositories){const current=this.repo(records,saved.id);clean(saved);clean(current);if(saved.git)await this.repositories.git(current.path,['cat-file','-e',`${saved.git.head}^{commit}`],{signal});}
    await this.protectRestoredResources(snapshot,records,signal);
    for(const saved of snapshot.repositories){
      const current=this.repo(records,saved.id);clean(saved);clean(current);
      if(saved.git){
        await this.repositories.git(current.path,['checkout','--no-overwrite-ignore','--detach',saved.git.head],{signal});
        if(saved.git.branch){
          const old=await this.repositories.git(current.path,['rev-parse','--verify',`refs/heads/${saved.git.branch}`],{signal,allowFailure:true});
          if(old.code===0&&old.stdout.trim()!==saved.git.head){const backup=`workbench-backup/${task.id}`;await this.repositories.git(current.path,['branch',backup,old.stdout.trim()],{signal});this.log(task,`${saved.name} 原分支提交保存在 ${backup}`);}
          await this.repositories.git(current.path,['branch','-f',saved.git.branch,saved.git.head],{signal});await this.repositories.git(current.path,['checkout','--no-overwrite-ignore',saved.git.branch],{signal});
        }
      }
      if(saved.kind==='plugin'&&current.enabled!==saved.enabled){const destination=await insideDirectory(snapshot.comfyPath,'custom_nodes',saved.name+(saved.enabled?'':'.disabled'));await this.absent(destination);await rename(current.path,destination);}
    }
    await this.snapshots.restoreFiles(snapshot,snapshot.comfyPath,configKey);
  }
  async protectRestoredResources(snapshot,records,signal){
    const saved=snapshot.repositories.find(repo=>repo.kind==='core');const current=records.find(repo=>repo.kind==='core');
    if(!saved?.git||!current?.git||saved.git.head===current.git.head)return;
    const laterPlugins=records.filter(repo=>repo.kind==='plugin'&&!snapshot.repositories.some(old=>old.id===repo.id)).map(repo=>relative(snapshot.comfyPath,repo.path).split(sep).join('/'));
    const changed=(await this.repositories.git(current.path,['diff','--name-only','-z','--no-renames','--diff-filter=MD',current.git.head,saved.git.head,'--','models','custom_nodes'],{signal})).stdout.split('\0').filter(Boolean);
    for(const plugin of records.filter(repo=>repo.kind==='plugin')){
      const path=relative(snapshot.comfyPath,plugin.path).split(sep).join('/');
      const affected=changed.filter(file=>file===path||file.startsWith(path+'/'));if(!affected.length)continue;
      const previous=snapshot.repositories.find(repo=>repo.id===plugin.id);
      if(previous&&!previous.git){
        const savedPath=relative(snapshot.comfyPath,previous.path).split(sep).join('/');
        for(const file of affected){
          const savedFile=savedPath+file.slice(path.length);
          const captured=await this.repositories.git(current.path,['cat-file','-e',`${saved.git.head}:${savedFile}`],{signal,allowFailure:true});
          if(captured.code!==0||captured.error)throw conflict(`插件 ${plugin.name} 的 ${file} 未保存在快照的本体 Git 中，不能通过本体恢复覆盖或删除其资源。`);
        }
      }
    }
    for(const path of changed){
      if(laterPlugins.some(plugin=>path===plugin||path.startsWith(plugin+'/')))throw conflict('恢复本体版本将修改或删除快照后新增的插件资源，请先手动保留这些资源。');
      if(path.startsWith('models/')&&/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(path)&&await exists(await insideDirectory(snapshot.comfyPath,path)))throw conflict('恢复本体版本将修改或删除模型文件，请先手动处理这些资源。');
    }
  }
  async close(){if(this.closed)return;this.closed=true;for(const controller of this.controllers)controller.abort();await this.downloads.close();await Promise.allSettled([...this.pending]);}
}
