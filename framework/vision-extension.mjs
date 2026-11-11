import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open,readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname,extname,join, resolve } from 'node:path';
import {homedir} from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fields, WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, insideDirectory } from './drawing-files.mjs';
import { downloadVerified, extractVisionArchive, ordinaryFile } from './vision-download.mjs';
import { publicVisionPackage, VISION_PACKAGE } from './vision-package.mjs';
import {CachedDiscovery} from './resource-discovery.mjs';
import {findLocalResourceFiles} from './local-resource-files.mjs';
import {readableLocalPath} from './resource-local-path.mjs';
import {acquireResourceStorageLease,beginManagedRoot,recordManagedTree} from './resource-storage.mjs';

const SETTING = 'vision.extension';
const MANIFEST = 'installed.json';
const exists = async path => { try { await lstat(path);return true; } catch(error) { if(error.code==='ENOENT')return false;throw error; } };

async function waitForExit(promise,timeoutMs){
  const controller=new AbortController();
  try{await Promise.race([promise,delay(timeoutMs,undefined,{signal:controller.signal})]);}finally{controller.abort();}
}

async function availablePort(port=0) {
  const server=createServer();
  return new Promise((resolve,reject)=>{
    server.once('error',()=>reject(new WorkbenchError(409,'本地视觉服务端口已被占用，请先停止占用此端口的程序。')));
    server.listen({host:'127.0.0.1',port,exclusive:true},()=>{const selected=server.address().port;server.close(error=>error?reject(error):resolve(selected));});
  });
}

export class VisionExtension {
  constructor({store,dataDir,chooseDirectory,fetchImpl=fetch,spawnImpl=spawn,extractImpl=extractVisionArchive,discoverImpl=findLocalResourceFiles,packageSpec=VISION_PACKAGE,
    platform=process.platform,arch=process.arch,startupTimeoutMs=180000,healthIntervalMs=500,idleTimeoutMs=30000,stopTimeoutMs=3000,statfsImpl=statfs}={}) {
    this.store=store;this.dataDir=resolve(dataDir);this.spec=structuredClone(packageSpec);this.choose=chooseDirectory;this.fetch=fetchImpl;this.spawn=spawnImpl;this.extract=extractImpl;this.discoverFiles=discoverImpl;
    this.startupTimeoutMs=startupTimeoutMs;this.healthIntervalMs=healthIntervalMs;this.idleTimeoutMs=idleTimeoutMs;this.stopTimeoutMs=stopTimeoutMs;this.statfs=statfsImpl;
    this.supported=platform==='win32'&&arch==='x64';this.closed=false;this.picking=false;this.installed=false;this.child=null;this.job=null;this.starting=null;this.closing=null;
    this.runtime={status:'stopped'};this.signature=createHash('sha256').update(JSON.stringify(this.spec)).digest('hex');
    const saved=store.getSetting(SETTING)||{};
    this.record={directory:typeof saved.directory==='string'?saved.directory:join(resolve(dataDir),'resources','vision'),
      apiKey:typeof saved.apiKey==='string'&&/^[a-f0-9]{64}$/.test(saved.apiKey)?saved.apiKey:randomBytes(32).toString('hex'),
      port:Number.isInteger(saved.port)&&saved.port>1023&&saved.port<=65535?saved.port:null,autoStart:saved.autoStart===true,
      device:saved.device==='cpu'?'cpu':'auto',task:saved.task&&typeof saved.task==='object'?saved.task:null,
      bindings:saved.bindings&&typeof saved.bindings==='object'?saved.bindings:{},searchRoots:Array.isArray(saved.searchRoots)?saved.searchRoots:[]};
    this.discovery=new CachedDiscovery({store,key:'vision'});this.discoveryAbort=new AbortController();this.componentRecords=[];
    if(this.record.task?.status==='running')this.record.task={...this.record.task,status:'interrupted',error:'上次安装已中断，可继续安装。'};
    this.persist();
    this.initialized=this.inspectInstallation().then(installed=>{this.installed=installed;})
      .catch(error=>{this.installed=false;this.runtime={status:'failed',error:this.errorText(error)};});
    this.ready=this.restore().catch(error=>{this.runtime={status:'failed',error:this.errorText(error)};});
  }
  persist(){this.store.setSetting(SETTING,this.record);}
  errorText(error){
    let message=typeof error==='string'?error:error instanceof WorkbenchError?error.message:error?.code==='ENOSPC'?'磁盘空间不足，可释放空间后重试。':error?.message||'本地视觉扩展操作失败。';
    message=String(message).split(this.record.apiKey).join('[已隐藏密钥]').replace(/Bearer\s+[^\s,;]+/gi,'Bearer [已隐藏]').replace(/\x1b\[[0-9;]*m/g,'');
    return message.slice(-1800);
  }
  state(){return {package:publicVisionPackage(this.spec),directory:this.record.directory,canChooseDirectory:typeof this.choose==='function',supported:this.supported,
    components:structuredClone(this.componentRecords),bindings:structuredClone(this.record.bindings),searchRoots:[...this.record.searchRoots],discovery:this.discovery.read({fingerprint:JSON.stringify(this.record.searchRoots)}),
    installed:this.installed,task:structuredClone(this.record.task),runtime:structuredClone(this.runtime),autoStart:this.record.autoStart};}
  ensureOpen(){if(this.closed)throw new WorkbenchError(409,'本地视觉扩展已关闭。');}
  ensureSupported(){if(!this.supported)throw new WorkbenchError(400,'此视觉扩展当前仅支持 Windows x64。');}
  busy(){return Boolean(this.job||this.starting||this.picking||this.child);}
  async paths(){
    const directory=await checkedLocalPath(this.record.directory);
    const root=await insideDirectory(directory,this.spec.id);
    return {directory,root,runtime:await insideDirectory(root,this.spec.runtime.directory),manifest:await insideDirectory(root,MANIFEST)};
  }
  async inspectInstallation(){
    const componentPaths=await this.componentPaths();this.componentRecords=[];
    for(const file of this.spec.files){
      const key=file.id==='model'?'modelPath':file.id==='projector'?'projectorPath':'runtimePath';
      let installed=false;try{const info=await ordinaryFile(componentPaths[file.id]);installed=Boolean(info?.size)&&(this.record.bindings[key]?true:file.id==='runtime'||info.size===file.bytes);}catch{}
      this.componentRecords.push({id:file.id,label:{model:'视觉模型',projector:'视觉投影文件',runtime:'推理运行器'}[file.id],path:componentPaths[file.id],installed,bytes:file.bytes,sha256:file.sha256,url:file.url,verification:this.record.bindings[key]?'unverified':'package'});
    }
    if(Object.values(this.record.bindings).some(Boolean)){
      if(!this.record.bindings.runtimePath){try{await this.checkRuntime(dirname(componentPaths.runtime));}catch{return false;}}
      return this.componentRecords.every(item=>item.installed);
    }
    try{
      const paths=await this.paths();const info=await ordinaryFile(paths.manifest);
      if(!info||info.size>64*1024)return false;
      const manifest=JSON.parse(await readFile(paths.manifest,'utf8'));
      if(manifest.signature!==this.signature)return false;
      for(const file of this.spec.files){const info=await ordinaryFile(await insideDirectory(paths.root,file.filename));if(!info||info.size!==file.bytes)return false;}
      await this.checkRuntime(paths.runtime);return true;
    }catch{return false;}
  }
  async componentPaths(){
    const paths=await this.paths(),bindings=this.record.bindings;
    return {model:bindings.modelPath||await insideDirectory(paths.root,this.spec.files.find(file=>file.id==='model').filename),projector:bindings.projectorPath||await insideDirectory(paths.root,this.spec.files.find(file=>file.id==='projector').filename),runtime:bindings.runtimePath||await insideDirectory(paths.runtime,this.spec.runtime.executable)};
  }
  async configure(value={}){
    fields(value,['modelPath','projectorPath','runtimePath','searchRoots']);this.ensureOpen();if(this.busy())throw new WorkbenchError(409,'请先停止视觉服务或等待任务结束。');
    const bindings={...this.record.bindings};
    for(const key of ['modelPath','projectorPath','runtimePath']){
      if(value[key]===undefined)continue;
      if(value[key]===''){delete bindings[key];continue;}
      if(typeof value[key]!=='string'||!value[key].trim())throw new WorkbenchError(400,'组件路径须为本地文件绝对路径。');
      const path=await readableLocalPath(value[key]);const info=await ordinaryFile(path);
      if(!info?.size)throw new WorkbenchError(400,'找不到'+({modelPath:'视觉模型',projectorPath:'视觉投影文件',runtimePath:'llama-server 运行器'}[key])+'，请重新选择文件。');
      if(key!=='runtimePath'&&extname(path).toLowerCase()!=='.gguf'||key==='runtimePath'&&extname(path).toLowerCase()!=='.exe')throw new WorkbenchError(400,'视觉模型和投影文件须为 GGUF，运行器须为 llama-server.exe。');
      if(key!=='runtimePath'){
        const handle=await open(path,'r');try{const magic=Buffer.alloc(4);await handle.read(magic,0,4,0);if(magic.toString('ascii')!=='GGUF')throw new WorkbenchError(400,'所选文件不包含有效的 GGUF 文件头。');}finally{await handle.close();}
      }
      bindings[key]=path;
    }
    if(value.searchRoots!==undefined){if(!Array.isArray(value.searchRoots)||value.searchRoots.length>12)throw new WorkbenchError(400,'检索目录最多 12 项。');const roots=[];for(const path of value.searchRoots)roots.push(await readableLocalPath(path));this.record.searchRoots=roots;}
    this.record.bindings=bindings;this.record.autoStart=false;this.persist();this.installed=await this.inspectInstallation();return this.state();
  }
  async discover(value={}){
    fields(value,['refresh']);if(value.refresh!==undefined&&typeof value.refresh!=='boolean')throw new WorkbenchError(400,'重新检索须为布尔值。');this.ensureOpen();
    const roots=[...this.record.searchRoots,this.record.directory,...Object.values(this.record.bindings).map(path=>dirname(path)),join(homedir(),'.cache','huggingface','hub'),join(homedir(),'Downloads'),...['C:','D:','E:','F:'].flatMap(drive=>['ai draw','AI','voice','llama.cpp'].map(name=>join(drive+'\\',name)))];
    await this.discovery.run(()=>this.discoverFiles({roots,signal:this.discoveryAbort.signal,accept:name=>/^llama-server\.exe$/i.test(name)?'runtime':/\.gguf$/i.test(name)?'gguf':null}),{refresh:value.refresh===true,fingerprint:JSON.stringify(this.record.searchRoots)});
    return this.state();
  }
  async checkRuntime(directory){
    for(const filename of this.spec.runtime.requiredFiles){
      const info=await ordinaryFile(await insideDirectory(directory,filename));
      if(!info||info.size===0)throw new WorkbenchError(409,`视觉运行器缺少 ${filename}，请重新安装修复。`);
    }
  }
  async restore(){
    await this.initialized;
    if(this.closed||this.job||this.picking||!this.supported||!this.record.autoStart)return;
    if(!this.installed){this.runtime={status:'failed',error:'本地视觉扩展文件不完整，请手动安装修复。'};return;}
    this.beginStart(this.record.device);await this.starting?.promise;
  }
  async chooseDirectory(value={}){
    fields(value,[]);this.ensureOpen();
    if(this.busy())throw new WorkbenchError(409,'请先停止运行或等待安装结束，再选择目录。');
    if(typeof this.choose!=='function')throw new WorkbenchError(400,'当前入口不支持原生目录选择。');
    this.picking=true;
    try{
      await this.ready;this.ensureOpen();
      const chosen=await this.choose({moduleId:'qq',defaultPath:this.record.directory});
      this.ensureOpen();
      if(chosen){this.record.directory=await checkedLocalPath(typeof chosen==='string'?chosen:chosen.path);this.record.autoStart=false;this.record.task=null;this.persist();this.installed=await this.inspectInstallation();}
      return this.state();
    }finally{this.picking=false;}
  }
  install(value={}){
    fields(value,['components','startAfter']);this.ensureOpen();this.ensureSupported();
    if(value.startAfter!==undefined&&typeof value.startAfter!=='boolean')throw new WorkbenchError(400,'安装后启动须为布尔值。');
    if(value.components!==undefined&&(!Array.isArray(value.components)||!value.components.length||value.components.some(id=>!this.spec.files.some(file=>file.id===id))))throw new WorkbenchError(400,'请选择需要下载的视觉组件。');
    if(this.job)return this.state();
    if(this.busy())throw new WorkbenchError(409,'请先停止视觉服务或关闭目录选择，再安装。');
    const job={controller:new AbortController(),intent:null,promise:null,components:[...new Set(value.components??this.spec.files.map(file=>file.id))],startAfter:value.startAfter===true};this.job=job;
    this.record.task={id:randomUUID(),status:'running',stage:'preparing',completedBytes:0,totalBytes:this.spec.files.filter(file=>job.components.includes(file.id)).reduce((sum,file)=>sum+file.bytes,0)};
    try{this.persist();}catch(error){this.job=null;throw error;}
    job.promise=Promise.resolve().then(async()=>{
      const release=acquireResourceStorageLease(this.dataDir,'vision');let ownership;
      try{const paths=await this.paths();ownership=await beginManagedRoot({dataDir:this.dataDir,root:paths.root});return await this.performInstall(job);}
      finally{
        try{for(const file of this.spec.files)await recordManagedTree({dataDir:this.dataDir,ownership,id:'vision-'+file.id,scopeToRoot:true,name:{model:'视觉模型',projector:'视觉投影文件',runtime:'视觉推理运行器'}[file.id],family:'vision',select:path=>file.id==='runtime'?path.startsWith(this.spec.runtime.directory+'/'):path===file.filename||file.id==='model'&&path===MANIFEST});
          const downloads=new Set(this.spec.files.flatMap(file=>[file.filename+'.part',...(file.id==='runtime'?[file.filename]:[])]));
          await recordManagedTree({dataDir:this.dataDir,ownership,id:'vision-download-cache',scopeToRoot:true,name:'视觉安装包与下载分片',family:'vision',kind:'cache',select:path=>downloads.has(path)});
        }finally{release();}
      }
    }).catch(error=>{
      this.record.task.status=job.intent||'failed';this.record.task.error=job.intent==='cancelled'?undefined:job.intent==='interrupted'?'工作台已关闭，下载已保留，可继续安装。':this.errorText(error);
      try{this.persist();}catch{this.record.task.error='无法保存安装记录，请检查资料目录。';}
    }).finally(()=>{if(this.job===job)this.job=null;});
    return this.state();
  }
  updateTask(patch){Object.assign(this.record.task,patch);this.persist();}
  async performInstall(job){
    await this.ready;const {signal}=job.controller;signal.throwIfAborted();
    const paths=await this.paths();await mkdir(paths.root,{recursive:true});signal.throwIfAborted();
    const space=await this.statfs(paths.root);const available=Number(space.bavail)*Number(space.bsize);
    const selected=this.spec.files.filter(file=>job.components.includes(file.id));
    let remaining=job.components.includes('runtime')?this.spec.runtime.unpackedBytes:0;
    for(const file of selected){const saved=await ordinaryFile(await insideDirectory(paths.root,file.filename));const partial=await ordinaryFile(await insideDirectory(paths.root,file.filename+'.part'));if(!saved)remaining+=Math.max(0,file.bytes-(partial?.size||0));}
    if(!Number.isFinite(available)||available<remaining+8*1024*1024)throw new WorkbenchError(409,'磁盘可用空间不足，可释放空间或更换安装目录。');
    let completed=0;
    for(const file of selected){
      signal.throwIfAborted();const target=await insideDirectory(paths.root,file.filename);
      await downloadVerified({file,target,fetchImpl:this.fetch,signal,idleTimeoutMs:this.idleTimeoutMs,
        onProgress:bytes=>{this.record.task.completedBytes=completed+bytes;},onStage:stage=>this.updateTask({stage})});
      completed+=file.bytes;this.updateTask({completedBytes:completed});
    }
    signal.throwIfAborted();
    if(!job.components.includes('runtime'))return this.finishInstall(job,paths,completed);
    this.updateTask({stage:'extracting'});
    const staging=await insideDirectory(paths.root,`runtime-${job.controller===this.job?.controller?this.record.task.id:randomUUID()}.part`);
    try{
      await this.extract({archive:await insideDirectory(paths.root,this.spec.files.find(file=>file.id==='runtime').filename),destination:staging,unpackedBytes:this.spec.runtime.unpackedBytes,signal});
      signal.throwIfAborted();await this.checkRuntime(staging);signal.throwIfAborted();
      // 固定包子目录中的运行库由本控制器拥有；删除前再次核对路径及链接。
      await insideDirectory(paths.root,this.spec.runtime.directory);
      if(await exists(paths.runtime))await rm(paths.runtime,{recursive:true,force:true});
      signal.throwIfAborted();await rename(staging,paths.runtime);
      await this.finishInstall(job,paths,completed);
    }finally{
      await insideDirectory(paths.root,staging.slice(paths.root.length+1));
      await rm(staging,{recursive:true,force:true}).catch(()=>{});
    }
  }
  async finishInstall(job,paths,completed){
    const {signal}=job.controller;signal.throwIfAborted();await checkedLocalPath(paths.manifest);
    await writeFile(paths.manifest,JSON.stringify({signature:this.signature,installedAt:new Date().toISOString()},null,2)+'\n',{encoding:'utf8'});
    this.installed=await this.inspectInstallation();
    if(job.startAfter){
      if(!this.installed)throw new WorkbenchError(409,'已选组件已下载，其他视觉组件尚未准备完成。');
      this.updateTask({stage:'starting'});this.beginStart(this.record.device,signal);await this.starting?.promise;signal.throwIfAborted();
      if(this.runtime.status!=='running')throw new WorkbenchError(500,this.runtime.error||'视觉服务未能启动。');
    }
    this.updateTask({status:'completed',stage:'completed',completedBytes:completed,totalBytes:completed});
  }
  start(value={}){
    fields(value,['device']);this.ensureOpen();this.ensureSupported();
    if(value.device!==undefined&&!['auto','cpu'].includes(value.device))throw new WorkbenchError(400,'运行设备仅支持 auto 或 cpu。');
    if(this.job||this.picking)throw new WorkbenchError(409,'请等待安装或目录选择完成。');
    if(this.starting||this.runtime.status==='running')return this.state();
    if(this.child)throw new WorkbenchError(409,'上次视觉服务尚未退出，请先停止服务。');
    if(!this.installed)throw new WorkbenchError(409,'请先安装本地视觉扩展。');
    this.record.device=value.device||this.record.device;this.persist();this.beginStart(this.record.device);return this.state();
  }
  beginStart(device,parentSignal){
    const release=acquireResourceStorageLease(this.dataDir,'vision');this.runtimeLease=release;
    const startup={controller:new AbortController(),promise:null};this.starting=startup;this.runtime={status:'starting'};
    const signal=parentSignal?AbortSignal.any([parentSignal,startup.controller.signal]):startup.controller.signal;
    startup.promise=Promise.resolve().then(()=>this.launch(device,signal)).catch(async error=>{
      let failure=error;
      try{await this.terminateChild();}catch(stopError){failure=stopError;}
      this.runtime=signal.aborted&&!this.child?{status:'stopped'}:{status:'failed',error:this.errorText(failure)};
    }).finally(()=>{if(this.starting===startup)this.starting=null;if(!this.child){release();if(this.runtimeLease===release)this.runtimeLease=null;}});
  }
  async launch(device,signal){
    signal.throwIfAborted();this.ensureOpen();
    this.installed=await this.inspectInstallation();signal.throwIfAborted();
    if(!this.installed)throw new WorkbenchError(409,'视觉扩展文件不完整，请重新安装修复。');
    const paths=await this.paths();signal.throwIfAborted();
    const port=await availablePort(this.record.port||0);signal.throwIfAborted();
    if(!this.record.port){this.record.port=port;this.persist();}
    const components=await this.componentPaths();
    const args=['--host','127.0.0.1','--port',String(port),'--alias',this.spec.alias,'--model',components.model,'--mmproj',components.projector,
      '--jinja','--chat-template-kwargs','{"enable_thinking":false}','--ctx-size','8192','--parallel','1','-ngl',device==='cpu'?'0':'auto',...(device==='cpu'?['--no-mmproj-offload']:[])];
    signal.throwIfAborted();this.ensureOpen();
    const child=this.spawn(components.runtime,args,{cwd:dirname(components.runtime),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,LLAMA_API_KEY:this.record.apiKey}});
    const owner={child,exited:false,stopping:false,stderr:'',failure:null,exitPromise:null};this.child=owner;
    owner.exitPromise=new Promise(resolve=>{
      const finished=(code,exitSignal)=>{
        if(owner.exited)return;owner.exited=true;resolve();this.runtimeLease?.();this.runtimeLease=null;
        if(this.child===owner)this.child=null;
        if(!owner.stopping&&this.runtime.status==='running')this.runtime={status:'failed',error:this.errorText(owner.failure||new WorkbenchError(500,`视觉服务意外退出（${exitSignal||(code??'未知')}）。${owner.stderr}`))};
      };
      child.once('exit',finished);
      child.on('error',error=>{
        owner.failure=error;
        if(!child.pid){finished(null,null);return;}
        if(!owner.stopping&&this.runtime.status==='running'){
          this.runtime={status:'failed',error:this.errorText(error)};
          this.terminateChild().catch(stopError=>{this.runtime={status:'failed',error:this.errorText(stopError)};});
        }
      });
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data',chunk=>{owner.stderr=this.errorText((owner.stderr+chunk.toString()).slice(-8192));});
    child.stdout?.resume();
    const deadline=Date.now()+this.startupTimeoutMs;
    while(Date.now()<deadline){
      signal.throwIfAborted();
      if(owner.exited||owner.failure)throw new WorkbenchError(500,`视觉服务启动失败：${owner.failure?.message||owner.stderr||'进程已退出。'}`);
      const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(2000,Math.max(1,deadline-Date.now())))]);
      try{
        const headers={authorization:`Bearer ${this.record.apiKey}`};
        const health=await this.fetch(`http://127.0.0.1:${port}/health`,{headers,signal:requestSignal});
        const healthBody=await health.json();
        if(health.ok&&healthBody.status==='ok'){
          const models=await this.fetch(`http://127.0.0.1:${port}/v1/models`,{headers,signal:requestSignal});const body=await models.json();
          if(models.ok&&body.data?.some(item=>item.id===this.spec.alias)&&!owner.exited){
            const unauthorized=await this.fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:requestSignal});
            await unauthorized.body?.cancel();
            if(unauthorized.status!==401)throw new WorkbenchError(502,'本地视觉服务未启用接口鉴权，已停止。');
            signal.throwIfAborted();this.ensureOpen();if(owner.exited)continue;
            // 完成就绪检查才建立恢复意愿；停止和关闭的取消信号必须先处理。
            const previousAutoStart=this.record.autoStart;this.record.autoStart=true;
            try{this.persist();}catch{this.record.autoStart=previousAutoStart;throw new WorkbenchError(500,'无法保存视觉服务的自动恢复设置，请检查资料目录。');}
            this.runtime={status:'running'};return;
          }
        }
      }catch(error){signal.throwIfAborted();if(error instanceof WorkbenchError)throw error;}
      await delay(Math.min(this.healthIntervalMs,Math.max(1,deadline-Date.now())),undefined,{signal});
    }
    throw new WorkbenchError(504,`视觉服务启动超时，未能确认模型已就绪。${owner.stderr}`);
  }
  async terminateChild(){
    const owner=this.child;if(!owner)return;owner.stopping=true;
    if(owner.exited){if(this.child===owner)this.child=null;return;}
    try{owner.child.kill('SIGTERM');}catch{}
    await waitForExit(owner.exitPromise,this.stopTimeoutMs);
    if(!owner.exited){try{owner.child.kill('SIGKILL');}catch{}await waitForExit(owner.exitPromise,this.stopTimeoutMs);}
    if(!owner.exited)throw new WorkbenchError(500,'视觉服务进程尚未退出，请稍后重试停止。');
    if(this.child===owner)this.child=null;
  }
  async cancel(value={}){
    fields(value,[]);this.ensureOpen();
    const job=this.job;
    if(job){this.record.autoStart=false;this.persist();job.intent='cancelled';job.controller.abort();await job.promise;}
    else if(this.starting){this.record.autoStart=false;this.persist();const startup=this.starting;startup.controller.abort();await startup.promise;}
    return this.state();
  }
  async stop(value={}){
    fields(value,[]);this.ensureOpen();this.record.autoStart=false;this.persist();
    const job=this.job, startup=this.starting;
    if(job){job.intent='cancelled';job.controller.abort();}
    startup?.controller.abort();await Promise.allSettled([job?.promise,startup?.promise]);await this.terminateChild();this.runtime={status:'stopped'};return this.state();
  }
  connection(value={}){
    fields(value,[]);this.ensureOpen();
    if(this.runtime.status!=='running'||!this.child||this.child.exited)throw new WorkbenchError(409,'请先启动本地视觉服务，等待模型运行。');
    return {media:{localVisionEnabled:true,localVisionBaseUrl:`http://127.0.0.1:${this.record.port}/v1`,localVisionModel:this.spec.alias,localVisionKey:this.record.apiKey,clearLocalVisionKey:false}};
  }
  async waitForIdle(){await this.ready;while(this.job||this.starting)await Promise.allSettled([this.job?.promise,this.starting?.promise]);return this.state();}
  close(){
    if(this.closing)return this.closing;
    this.closed=true;this.discoveryAbort.abort();const job=this.job, startup=this.starting;
    if(job){job.intent='interrupted';job.controller.abort();}startup?.controller.abort();
    this.closing=(async()=>{await Promise.allSettled([this.ready,job?.promise,startup?.promise]);await this.terminateChild();this.runtime={status:'stopped'};})()
      .catch(error=>{
        this.closed=false;this.closing=null;this.runtime={status:'failed',error:this.errorText(error)};
        throw error;
      });
    return this.closing;
  }
}
