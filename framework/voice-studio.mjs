import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {copyFile,lstat,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fields,identifier,text,WorkbenchError} from './contracts.mjs';
import {checkedLocalPath,insideDirectory} from './drawing-files.mjs';
import {completeWav} from './voice.mjs';
import {runHttpVoice} from './voice-http-provider.mjs';
import {inspectVoiceModel,VOICE_MODEL_INSPECTION_VERSION} from './voice-providers.mjs';
import {acquireResourceStorageLease} from './resource-storage.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(value).digest('hex');
const cancelled=()=>new WorkbenchError(409,'声音任务已取消。');
const check=signal=>{if(signal?.aborted)throw cancelled();};
const clone=value=>structuredClone(value);
function duration(bytes){let seconds=0;for(let offset=12;offset+8<=bytes.length;){const length=bytes.readUInt32LE(offset+4);if(bytes.toString('latin1',offset,offset+4)==='data')seconds+=length/48000;offset+=8+length+(length%2);}return seconds;}
async function atomic(path,value){const temporary=path+'.'+randomBytes(6).toString('hex')+'.tmp';await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx'});await rename(temporary,path);}
async function ordinary(path,maxBytes=32*1024*1024){
  await checkedLocalPath(path);const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>maxBytes)throw new WorkbenchError(400,'请选择大小不超过 32 MiB 的普通本地音频文件。');
  return info;
}

export async function runVoiceWorker(request,{pythonPath,signal,timeoutMs=900000}={}){
  check(signal);await ordinary(pythonPath,512*1024*1024);
  const requestPath=join(dirname(request.output),'request.json');await atomic(requestPath,request);check(signal);
  return new Promise((resolveWorker,reject)=>{
    const adapter=request.provider==='qwen3-tts'?'qwen-voice':'moss-voice';
    const child=spawn(pythonPath,['-B','-u',join(root,'integrations',adapter,'studio.py'),'--request',requestPath],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_PROGRESS_BARS:'1'}});
    let errors='',done=false,timedOut=false;
    child.stdout.on('data',()=>{});child.stderr.setEncoding('utf8');child.stderr.on('data',value=>{errors=(errors+value).slice(-2500);});
    const stop=()=>{if(child.exitCode===null){if(process.platform==='win32'){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.on('error',()=>child.kill());}else child.kill('SIGKILL');}};
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',stop);error?reject(error):resolveWorker();};
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    child.once('error',()=>finish(new WorkbenchError(503,'无法启动声音 Python，请检测或安装声音运行环境。')));
    child.once('close',code=>finish(signal?.aborted?cancelled():timedOut?new WorkbenchError(504,'声音任务等待超时，请缩短台词后重试。'):code!==0?new WorkbenchError(502,errors.trim().slice(-1600)||'声音任务失败，请检查模型与运行环境。'):null));
  });
}

/** 音色库共享声音素材；角色、聊天与绑定仍由各实例自己保存。 */
export class VoiceStudio{
  constructor({dataDir,resources,coordination,baseUrl=()=>'',runWorker=runVoiceWorker,readAudio,fetchImpl=fetch,timeoutMs=900000}={}){
    this.dataDir=resolve(dataDir);this.directory=join(this.dataDir,'shared-voice','studio');this.resources=resources;this.baseUrl=baseUrl;this.worker=runWorker;this.timeoutMs=timeoutMs;
    this.coordination=coordination??{tail:Promise.resolve(),active:0,queued:0};this.entries=[];this.jobs=new Map();this.job=null;this.pending=null;this.operation=null;this.operations=new Set();this.libraryTail=Promise.resolve();this.jobWrites=Promise.resolve();this.closed=false;this.lifetime=new AbortController();
    this.fetch=fetchImpl;
    this.readAudio=readAudio||((id,signature)=>this.audio(id,signature));this.candidates=new Map();this.maintenance=0;
    this.initialized=this.initialize();
  }
  async initialize(){
    await checkedLocalPath(this.directory);for(const name of ['jobs','voices','audio'])await mkdir(join(this.directory,name),{recursive:true});
    const identity=join(this.directory,'identity.json');
    try{await ordinary(identity,4096);const value=JSON.parse(await readFile(identity,'utf8'));if(!/^[a-f0-9]{64}$/.test(value.key))throw new Error('invalid');this.key=value.key;}
    catch(error){if(error.code!=='ENOENT')throw new WorkbenchError(409,'声音库身份文件无效，请检查资料目录。');this.key=randomBytes(32).toString('hex');await atomic(identity,{version:1,key:this.key});}
    try{
      const path=join(this.directory,'voices.json');await ordinary(path,1024*1024);const value=JSON.parse(await readFile(path,'utf8'));
      if(![1,2].includes(value.version)||!Array.isArray(value.voices)||value.voices.some(item=>!/^voice-[a-f0-9-]{36}$/.test(item.id)||!['design','clone','synthesis'].includes(item.source)||typeof item.name!=='string'||!/^[a-f0-9]{64}$/.test(item.referenceSha256)))throw new Error('invalid');
      this.entries=value.voices;
    }catch(error){if(error.code!=='ENOENT')throw new WorkbenchError(409,'音色库清单无效，请检查资料目录。');}
    try{
      const path=join(this.directory,'job.json');await ordinary(path,16*1024*1024);const saved=JSON.parse(await readFile(path,'utf8')),jobs=[2,3].includes(saved.version)?saved.jobs:[saved];
      if(!Array.isArray(jobs))throw new Error('invalid');
      for(const candidate of saved.candidates||[]){identifier(candidate.id,'试听候选');if(candidate.status!=='completed'||!candidate.owner)throw new Error('invalid');this.candidates.set(candidate.id,candidate);}
      for(const value of jobs){
        identifier(value.id,'试听任务');if(!['design','clone','synthesis'].includes(value.mode))throw new Error('invalid');const job={...value,owner:value.owner||'shared'};
        if(['queued','running','cancelling'].includes(job.status)){job.status=job.stage='interrupted';job.error='上次声音任务已中断，请重新生成。';delete job.result;}
        this.jobs.set(job.owner,job);if(job.status==='completed')this.candidates.set(job.id,job);if(saved.latest===job.id||![2,3].includes(saved.version))this.job=job;
      }
      if(!this.job)this.job=[...this.jobs.values()].at(-1)||null;await this.persistJob();
    }
    catch(error){if(error.code!=='ENOENT')throw new WorkbenchError(409,'声音任务记录无效，请检查资料目录。');}
    await this.resources?.initialized;
  }
  ensureOpen(){if(this.closed)throw new WorkbenchError(409,'声音工作室正在关闭。');}
  voices(){return this.entries.map(({id,name,source,createdAt,provider='moss',modelKind,language})=>({id,name,source,createdAt,provider,modelKind,language}));}
  async exportVoice(id){
    this.ensureOpen();await this.initialized;identifier(id,'音色标识');
    const entry=this.entries.find(item=>item.id===id);if(!entry)throw new WorkbenchError(404,'未找到指定音色。');
    const bytes=await this.readWav(await insideDirectory(this.directory,'voices',entry.id,'reference.wav'));
    if(digest(bytes)!==entry.referenceSha256)throw new WorkbenchError(409,'音色参考音频已改变，无法导出。');
    return {bytes,mime:'audio/wav',filename:entry.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_')+'.wav'};
  }
  state({owner}={}){
    const job=owner===undefined?this.job:this.job?.owner===owner?this.job:this.jobs.get(owner)||null,voices=this.voices();
    const present=item=>item?{...clone(item),...(item.result?{result:this.result(item.result)}:{})}:null;
    const candidates=[...this.candidates.values()].filter(item=>owner===undefined||item.owner===owner).map(item=>({...present(item),savedVoice:voices.find(voice=>voice.id===this.entries.find(entry=>entry.jobId===item.id)?.id)||null}));
    return {voices,job:present(job),candidates,busy:!!this.operation||this.maintenance>0,canCancel:!!this.operation&&job?.id===this.job?.id,resources:this.resources?.state()};
  }
  persistJob(){
    if(this.job)this.jobs.set(this.job.owner,clone(this.job));
    const snapshot={version:3,latest:this.job?.id||null,jobs:[...this.jobs.values()].map(clone),candidates:[...this.candidates.values()].map(clone)};
    const task=this.jobWrites.catch(()=>{}).then(()=>atomic(join(this.directory,'job.json'),snapshot));this.jobWrites=task.catch(()=>{});return task;
  }
  config(mode,provider,entry){
    const state=this.resources?.state(),config=this.resources?.executionConfig?.()||state?.config||{};provider=provider||config.provider||'moss';
    if(provider==='http'){
      if(mode!=='synthesis')throw new WorkbenchError(400,'HTTP speech 不支持声音克隆或文本设计。');
      if(!config.httpUrl||!config.httpModel||!config.httpVoice)throw new WorkbenchError(409,'请先保存 HTTP 接口、模型和声音名称。');
      if(entry?.httpEndpoint&&entry.httpEndpoint!==config.httpUrl)throw new WorkbenchError(409,'此音色所属的 HTTP 接口已改变，请恢复与创建音色时一致的接口配置。');
      return {...config,provider,model:entry?.model||config.httpModel,speaker:entry?.speaker||config.httpVoice};
    }
    if(provider==='qwen3-tts'){
      const field=mode==='design'?'qwenDesignPath':mode==='clone'?'qwenBasePath':'qwenCustomVoicePath',model=entry?.model||config[field];
      if(state.modelInspectionVersion!==undefined&&state.bindings?.[field]?.inspectionVersion!==VOICE_MODEL_INSPECTION_VERSION)throw new WorkbenchError(409,'模型判定尚未检验，请点击「重新检索本机」手动检验。');
      if(!config.qwenPythonPath||!model||state?.environments?.find(item=>item.provider===provider)?.status!=='available'||state?.bindings?.[field]?.status!=='available')throw new WorkbenchError(409,'请在声音组件中绑定兼容的 Qwen3-TTS 独立 Python 和对应模型。');
      return {...config,provider,pythonPath:config.qwenPythonPath,model,modelKind:mode==='design'?'voice-design':mode==='clone'?'base':'custom-voice',sourcePath:config.qwenSourcePath};
    }
    if(provider!=='moss')throw new WorkbenchError(400,'声音提供者无效。');
    const required=['runtime','codec',mode==='design'?'generator':'clone'];
    if(state?.modelInspectionVersion!==undefined&&['codecPath',mode==='design'?'generatorPath':'clonePath'].some(field=>state.bindings?.[field]?.inspectionVersion!==VOICE_MODEL_INSPECTION_VERSION||state.bindings[field].status!=='available'))throw new WorkbenchError(409,'模型判定尚未通过检验，请点击「重新检索本机」手动检验并检查绑定用途。');
    if(!config.pythonPath||!config.codecPath||!(mode==='design'?config.generatorPath:config.clonePath)||!required.every(id=>state?.components?.find(item=>item.id===id)?.installed))throw new WorkbenchError(409,'请先检测已有环境，或在「声音组件」下载所需模型与运行环境。');
    return {...config,provider,model:entry?.model||(mode==='design'?config.generatorPath:config.clonePath),modelKind:mode==='design'?'generator':'clone'};
  }
  async run(request,config,options){
    if(config.provider!=='http'&&this.resources?.state()?.modelInspectionVersion!==undefined){
      const targets=[[config.model,config.modelKind],...(config.provider==='moss'?[[config.codecPath,'codec']]:[])];
      for(const [path,kind] of targets){const binding=await inspectVoiceModel(path,{provider:config.provider,kind});if(binding.status!=='available')throw new WorkbenchError(409,`声音模型检验未通过：${binding.issue||binding.status}`);}
    }
    return config.provider==='http'?runHttpVoice(request,{config,fetchImpl:this.fetch,...options}):this.worker(request,{pythonPath:config.pythonPath,...options});
  }
  exclusive(work,signal){
    const coordinator=this.coordination;
    if(coordinator.queued>=8)throw new WorkbenchError(429,'声音等待队列已满，请稍后重试。');
    const release=acquireResourceStorageLease(this.dataDir,'voice');coordinator.queued++;
    const task=coordinator.tail.catch(()=>{}).then(async()=>{coordinator.queued--;check(signal);this.ensureOpen();coordinator.active++;try{return await work();}finally{coordinator.active--;}}).finally(release);
    coordinator.tail=task.catch(()=>{});return task;
  }
  create(value,{owner='shared'}={}){
    fields(value,['mode','instruction','referencePath','referenceAudio','count','text','seed','provider','modelKind','speaker','transcript','language']);this.ensureOpen();
    if(this.operation||this.maintenance)throw new WorkbenchError(409,'已有声音任务或候选正在删除，请稍后再生成。');
    if(!['design','clone','synthesis'].includes(value.mode))throw new WorkbenchError(400,'请选择普通合成、声音生成或声音克隆。');
    const provider=value.provider||this.resources?.state()?.config?.provider||'moss';
    if(provider==='http'&&value.mode!=='synthesis')throw new WorkbenchError(400,'HTTP speech 不支持声音克隆或文本设计。');
    if(provider==='moss'&&value.mode==='synthesis')throw new WorkbenchError(400,'MOSS 普通合成请先从音色库选择已保存音色。');
    const input=text(value.text,'试听台词',500),instruction=value.mode==='design'?text(value.instruction,'声音描述',1200):'';
    const count=value.count??1;if(!Number.isInteger(count)||count<1||count>8||value.mode!=='design'&&count!==1)throw new WorkbenchError(400,'生成份数需要为 1–8 的整数，克隆和普通合成一次生成一份。');
    if(value.referenceAudio&&value.referencePath)throw new WorkbenchError(400,'请选择一种参考来源。');
    if(value.referenceAudio){fields(value.referenceAudio,['id','signature']);if(value.mode!=='clone'||!['id','signature'].every(key=>typeof value.referenceAudio[key]==='string'&&/^[a-f0-9]{64}$/.test(value.referenceAudio[key])))throw new WorkbenchError(400,'生成音频的引用无效，请重新选择。');}
    const referenceAudio=value.referenceAudio?clone(value.referenceAudio):undefined;
    const referencePath=value.mode==='clone'&&!referenceAudio?text(value.referencePath,'参考录音',4096):undefined;
    const transcript=value.mode==='design'?input:provider==='qwen3-tts'&&value.mode==='clone'?text(value.transcript,'参考录音转录',2000):text(value.transcript??'','参考录音转录',2000,{empty:true});
    const language=text(value.language||'Chinese','语言',60),speaker=text(value.speaker||'Vivian','声音名称',100);
    if(value.modelKind&&value.modelKind!==(provider==='qwen3-tts'?(value.mode==='design'?'voice-design':value.mode==='clone'?'base':'custom-voice'):provider==='moss'?(value.mode==='design'?'generator':'clone'):'speech'))throw new WorkbenchError(400,'所选模型不支持当前声音任务。');
    const seed=value.seed??90321;if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new WorkbenchError(400,'随机种子需要为 0–4294967295 的整数。');
    const config=this.config(value.mode,provider),controller=new AbortController(),id=randomUUID();
    const job={id,owner,provider,model:config.model,httpEndpoint:provider==='http'?config.httpUrl:undefined,modelKind:config.modelKind||'speech',speaker:provider==='http'?config.speaker:speaker,transcript,language,mode:value.mode,status:'queued',stage:'queued',text:input,instruction,seed,...(count>1?{batch:{id,index:1,count}}:{}),createdAt:new Date().toISOString()};
    const signal=AbortSignal.any([controller.signal,this.lifetime.signal]);
    const completed=new Set();
    const pending=this.exclusive(async()=>{
      await this.initialized;
      for(let index=0;index<count;index++){
      check(signal);const candidateId=index?randomUUID():id;
      if(index)this.job={...job,id:candidateId,seed:(seed+index)>>>0,batch:{id,index:index+1,count},createdAt:new Date().toISOString()};
      const directory=await insideDirectory(this.directory,'jobs',candidateId);await mkdir(directory,{recursive:true});
      const request={provider,mode:value.mode,text:input,instruction,seed:this.job.seed,model:config.model,modelKind:config.modelKind||'speech',sourcePath:config.sourcePath,speaker:this.job.speaker,transcript,language,codec:config.codecPath,output:join(directory,'preview.wav')};
      if(referencePath){const extension=extname(referencePath).toLowerCase();if(!['.wav','.flac','.mp3','.ogg'].includes(extension))throw new WorkbenchError(400,'参考录音需要为 WAV、FLAC、MP3 或 OGG。');await ordinary(referencePath);check(signal);request.reference=join(directory,'input-audio'+extension);request.referenceOutput=join(directory,'reference.wav');await copyFile(referencePath,request.reference);}
      if(referenceAudio){const {bytes}=await this.readAudio(referenceAudio.id,referenceAudio.signature);check(signal);if(!completeWav(bytes)||bytes.length>32*1024*1024||duration(bytes)<1||duration(bytes)>30)throw new WorkbenchError(400,'克隆参考需要 1–30 秒的完整音频，请使用较短台词重新生成。');request.reference=join(directory,'input-audio.wav');request.referenceOutput=join(directory,'reference.wav');await writeFile(request.reference,bytes,{flag:'wx'});}
      this.job.status='running';this.job.stage='generating';await this.persistJob();check(signal);
      await this.run(request,config,{signal,timeoutMs:this.timeoutMs});check(signal);
      const audio=await this.readWav(request.output),reference=await this.readWav(request.referenceOutput||request.output);check(signal);
      const result=await this.cache(audio,{voiceId:null,source:value.mode,requestId:candidateId});check(signal);
      this.job={...this.job,status:'completed',stage:'completed',result,referenceSha256:digest(reference),referenceFile:value.mode==='clone'?'reference.wav':'preview.wav',finishedAt:new Date().toISOString()};
      await this.persistJob();check(signal);
      this.candidates.set(candidateId,clone(this.job));await this.persistJob();check(signal);completed.add(candidateId);
      }
    },signal).catch(async error=>{
      if(!completed.has(this.job.id))this.candidates.delete(this.job.id);
      this.job={...this.job,status:signal.aborted?'cancelled':'failed',stage:signal.aborted?'cancelled':'failed',error:signal.aborted?undefined:error.message,finishedAt:new Date().toISOString()};delete this.job.result;
      try{await this.persistJob();}catch{this.job.error='无法保存声音任务记录，请检查磁盘空间和资料目录权限。';this.jobs.set(owner,clone(this.job));}
    })
      .finally(()=>{if(this.operation===controller)this.operation=null;});
    // 同步准入成功后再替换候选；队列已满或维护锁拒绝时，保留原试听和空闲状态。
    this.operation=controller;this.job=job;this.jobs.set(owner,job);this.pending=pending;
    return this.state({owner});
  }
  async cancel({owner}={}){this.ensureOpen();if(this.operation){if(owner!==undefined&&this.job.owner!==owner)throw new WorkbenchError(409,'不能取消另一实例的声音任务。');this.operation.abort();this.job.status='cancelling';this.job.stage='cancelling';delete this.job.result;try{await this.persistJob();}catch{this.job.error='无法保存取消记录，请检查磁盘空间。';}}return this.state({owner});}
  async readWav(path){await ordinary(path);const bytes=await readFile(path);if(!completeWav(bytes))throw new WorkbenchError(502,'声音任务没有返回完整的 24 kHz 单声道 PCM16 WAV。');return bytes;}
  async save(value,{owner='shared'}={}){
    fields(value,['jobId','name']);identifier(value.jobId,'试听任务');const name=text(value.name,'音色名称',60);this.ensureOpen();await this.initialized;
    const task=this.libraryTail.catch(()=>{}).then(async()=>{
      this.ensureOpen();const candidate=this.candidates.get(value.jobId)||(this.job?.id===value.jobId?this.job:[...this.jobs.values()].find(job=>job.id===value.jobId));
      if(!candidate||candidate.owner!==owner)throw new WorkbenchError(409,'请先完成本实例的试听，再保存音色。');
      const existing=this.entries.find(item=>item.jobId===value.jobId);if(existing)return this.voices().find(item=>item.id===existing.id);
      if(candidate.status!=='completed')throw new WorkbenchError(409,'请先完成本次试听，再保存音色。');
      const job=clone(candidate),referencePath=await insideDirectory(this.directory,'jobs',identifier(job.id),job.referenceFile),reference=await this.readWav(referencePath);
      if(digest(reference)!==job.referenceSha256)throw new WorkbenchError(409,'试听参考已改变，请重新生成。');
      const seconds=duration(reference);
      if(job.mode!=='synthesis'&&(seconds<1||seconds>30))throw new WorkbenchError(409,'保存音色需要 1–30 秒的参考，请缩短试听台词后重新生成，或更换参考录音。');
      const provider=job.provider||'moss';
      // 设计成果只需保存参考与转录；缺少克隆模型时在首次合成前检查并使用届时的绑定。
      let model=job.mode==='design'?undefined:job.model;
      if(job.mode==='design'){try{model=this.config('clone',provider).model;}catch(error){if(!(error instanceof WorkbenchError)||error.status!==409)throw error;}}
      const id='voice-'+randomUUID(),directory=await insideDirectory(this.directory,'voices',id);await mkdir(directory,{recursive:true});await writeFile(join(directory,'reference.wav'),reference,{flag:'wx'});
      const entry={id,name,source:job.mode,jobId:job.id,provider,model,httpEndpoint:job.httpEndpoint,modelKind:job.mode==='design'?(provider==='qwen3-tts'?'base':'clone'):job.modelKind,designModel:job.mode==='design'?job.model:undefined,speaker:job.speaker,transcript:job.transcript||'',language:job.language||'Chinese',referenceSha256:job.referenceSha256,seed:job.seed,instruction:job.instruction,createdAt:new Date().toISOString()};
      await atomic(join(this.directory,'voices.json'),{version:2,voices:[...this.entries,entry]});this.entries.push(entry);return this.voices().find(item=>item.id===id);
    });this.libraryTail=task.catch(()=>{});return task;
  }
  async discard(value,{owner='shared'}={}){
    fields(value,['jobId']);identifier(value.jobId,'试听候选');this.ensureOpen();await this.initialized;
    if(this.operation)throw new WorkbenchError(409,'请等待声音生成完成，再删除候选。');
    const release=acquireResourceStorageLease(this.dataDir,'voice');
    this.maintenance++;
    const task=this.libraryTail.catch(()=>{}).then(async()=>{
      const candidate=this.candidates.get(value.jobId);if(!candidate||candidate.owner!==owner)throw new WorkbenchError(409,'只能删除本实例的试听候选。');
      const directory=await insideDirectory(this.directory,'jobs',identifier(candidate.id));
      const files=await Promise.all(['.wav','.json'].map(extension=>insideDirectory(this.directory,'audio',candidate.result.id+extension)));
      const previous=this.job,previousOwner=this.jobs.get(owner);
      this.candidates.delete(candidate.id);
      if(previousOwner?.id===candidate.id)this.jobs.delete(owner);
      if(this.job?.id===candidate.id)this.job=null;
      try{await this.persistJob();}catch(error){this.candidates.set(candidate.id,candidate);this.job=previous;if(previousOwner)this.jobs.set(owner,previousOwner);throw error;}
      // 已保存音色的 reference.wav 是独立副本；这里只回收本任务与结果缓存。
      await rm(directory,{recursive:true,force:true});for(const file of files)await rm(file,{force:true});
      return {deleted:true,jobId:candidate.id};
    });this.libraryTail=task.catch(()=>{});try{return await task;}finally{this.maintenance--;release();}
  }
  async synthesize({voiceId,text:input,characterId=null,moduleId='voice',requestId=null,signal}={}){
    this.ensureOpen();await this.initialized;const entry=this.entries.find(item=>item.id===voiceId);if(!entry)throw new WorkbenchError(400,'未找到指定音色，不会自动替换声音。');
    const mode=entry.source==='synthesis'?'synthesis':'clone',line=text(input,'台词',500),config=this.config(mode,entry.provider||'moss',entry);const combined=signal?AbortSignal.any([signal,this.lifetime.signal]):this.lifetime.signal;
    const task=this.exclusive(async()=>{
      check(combined);const reference=await insideDirectory(this.directory,'voices',entry.id,'reference.wav'),bytes=await this.readWav(reference);
      if(digest(bytes)!==entry.referenceSha256)throw new WorkbenchError(409,'音色参考文件已改变，请重新创建音色。');
      const cacheId=digest(JSON.stringify([entry.id,entry.referenceSha256,entry.seed,config.provider,config.model,config.codecPath,entry.transcript,entry.language,line]));
      const previous=await this.cached(cacheId);if(previous){check(combined);return {...previous,characterId,moduleId,requestId};}
      const directory=await insideDirectory(this.directory,'jobs',randomUUID());await mkdir(directory,{recursive:true});
      await this.run({provider:config.provider,mode,text:line,seed:entry.seed,model:config.model,modelKind:config.modelKind,sourcePath:config.sourcePath,speaker:entry.speaker,transcript:entry.transcript,language:entry.language||'Chinese',codec:config.codecPath,...(mode==='clone'?{reference,referenceOutput:join(directory,'reference.wav')}:{}),output:join(directory,'speech.wav')},config,{signal:combined,timeoutMs:this.timeoutMs});
      check(combined);const audio=await this.readWav(join(directory,'speech.wav'));check(combined);
      const result=await this.cache(audio,{id:cacheId,voiceId:entry.id,source:entry.source,characterId,moduleId,requestId});check(combined);return result;
    },combined);this.operations.add(task);try{return await task;}finally{this.operations.delete(task);}
  }
  async cache(bytes,metadata){
    const id=metadata.id||digest(bytes+randomUUID()),record={...metadata,id,bytes:bytes.length,sha256:digest(bytes),createdAt:new Date().toISOString()};
    await writeFile(await insideDirectory(this.directory,'audio',id+'.wav'),bytes);await atomic(await insideDirectory(this.directory,'audio',id+'.json'),record);return this.result(record);
  }
  result(record){const signature=createHmac('sha256',this.key).update('studio-audio:'+record.id).digest('hex');return {type:'record',...record,url:this.baseUrl().replace(/\/$/,'')+'/internal/voice-audio/'+record.id+'/'+signature};}
  acceptsAudio(id,signature){if(!this.key||!/^[a-f0-9]{64}$/.test(id)||!/^[a-f0-9]{64}$/.test(signature))return false;const expected=createHmac('sha256',this.key).update('studio-audio:'+id).digest();return timingSafeEqual(expected,Buffer.from(signature,'hex'));}
  async cached(id){try{const path=await insideDirectory(this.directory,'audio',id+'.json');await ordinary(path,65536);const metadata=JSON.parse(await readFile(path,'utf8'));if(metadata.id!==id)return null;const bytes=await this.readWav(await insideDirectory(this.directory,'audio',id+'.wav'));return digest(bytes)===metadata.sha256?this.result(metadata):null;}catch{return null;}}
  async audio(id,signature){await this.initialized;if(!this.acceptsAudio(id,signature))throw new WorkbenchError(403,'声音地址签名无效。');const value=await this.cached(id);if(!value)throw new WorkbenchError(404,'声音文件不存在或已改变。');return {bytes:await this.readWav(await insideDirectory(this.directory,'audio',id+'.wav')),mime:'audio/wav'};}
  async close(){if(this.closed)return;this.closed=true;this.lifetime.abort();this.operation?.abort();await Promise.allSettled([this.initialized,this.pending,this.libraryTail,...this.operations].filter(Boolean));await this.jobWrites;}
}
