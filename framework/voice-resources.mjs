import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname,join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fields, WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, insideDirectory } from './drawing-files.mjs';
import { readableLocalPath } from './resource-local-path.mjs';
import { downloadVerified, extractVisionArchive, ordinaryFile, verifiedFile } from './vision-download.mjs';
import { VOICE_PACKAGE } from './voice-package.mjs';
import { CachedDiscovery } from './resource-discovery.mjs';
import { VOICE_CONFIG_FIELDS,VOICE_PATH_FIELDS,VOICE_PROVIDERS,VOICE_MODEL_INSPECTION_VERSION,voiceDefaults,discoverVoiceResources,inspectVoiceEnvironment,inspectVoiceModel } from './voice-providers.mjs';
import {QWEN_DOWNLOAD_PRESETS,qwenModelPreset,prepareQwenModelPlan,downloadQwenModelPlan} from './voice-model-downloads.mjs';
import {acquireResourceStorageLease,beginManagedRoot,recordManagedTree} from './resource-storage.mjs';

const SETTING = 'voice.resources';
const KEYS = {runtime:'pythonPath',generator:'generatorPath',clone:'clonePath',codec:'codecPath'};
const OWNER = 'AI-Future-Workbench/voice-resources';
const VENV_OWNER = 'voice-venv-owner.json';
const IDS = Object.keys(KEYS);
const REQUIRED_COMPONENTS = {'clone-required':['runtime','codec','clone'],'generator-required':['runtime','codec','generator']};
const MODEL_BINDINGS={generatorPath:['moss','generator'],clonePath:['moss','clone'],codecPath:['moss','codec'],qwenBasePath:['qwen3-tts','base'],qwenCustomVoicePath:['qwen3-tts','custom-voice'],qwenDesignPath:['qwen3-tts','voice-design']};
const unverifiedModel=binding=>({...binding,status:'unverified',stale:true,issue:'模型判定规则已更新，请点击「重新检索本机」手动检验。'});
const defaultCandidates = () => ({
  pythonPath:['E:\\voice\\envs\\moss-py312\\Scripts\\python.exe'],
  generatorPath:['E:\\voice\\models\\moss-voice-generator\\MOSS-VoiceGenerator'],
  clonePath:['E:\\voice\\models\\moss-clone\\MOSS-TTS-Local-Transformer'],
  codecPath:['E:\\voice\\models\\moss-voice-generator\\MOSS-Audio-Tokenizer'],
  uvPath:process.env.USERPROFILE?[join(process.env.USERPROFILE,'.local','bin','uv.exe')]:[],
});

function errorText(error) {
  return String(error?.code==='ENOSPC'?'磁盘空间不足，可释放空间后重试。':error?.message||error||'声音组件操作失败。')
    .replace(/\x1b\[[0-9;]*m/g,'').replace(/视觉扩展|视觉运行器/g,'声音组件').slice(-1800);
}

export class VoiceResources {
  constructor({store,dataDir,directory,sharedResourceDirectory,fetchImpl=fetch,spawnImpl=spawn,
    extractImpl=extractVisionArchive,packageSpec=VOICE_PACKAGE,candidates=defaultCandidates(),runtimeProbeImpl,
    runCommandImpl,openFileImpl=open,discoverImpl=discoverVoiceResources,searchRoots=['E:\\voice',...(process.env.USERPROFILE?[join(process.env.USERPROFILE,'.cache','huggingface','hub'),join(process.env.USERPROFILE,'voice')]:[])],platform=process.platform,arch=process.arch,idleTimeoutMs=30000,commandTimeoutMs=3600000,runtimeProbeTimeoutMs=180000}={}) {
    this.store=store;this.dataDir=resolve(dataDir);this.spec=structuredClone(packageSpec);this.fetch=fetchImpl;this.spawn=spawnImpl;this.extract=extractImpl;
    this.candidates=structuredClone(candidates);this.runtimeProbe=runtimeProbeImpl;this.runCommand=runCommandImpl;
    this.openFile=openFileImpl;
    this.discover=discoverImpl;this.searchRoots=searchRoots;
    this.discovery=new CachedDiscovery({store,key:'voice.discovery'});
    this.idleTimeoutMs=idleTimeoutMs;this.commandTimeoutMs=commandTimeoutMs;this.runtimeProbeTimeoutMs=runtimeProbeTimeoutMs;
    this.supported=platform==='win32'&&arch==='x64';this.closed=false;this.job=null;this.operation=null;
    this.lifetime=new AbortController();this.installed=Object.fromEntries(IDS.map(id=>[id,false]));
    const saved=store.getSetting(SETTING)||{};
    this.record={directory:typeof saved.directory==='string'?saved.directory:directory||sharedResourceDirectory||join(resolve(dataDir),'resources','voice'),
      config:{...voiceDefaults(),...Object.fromEntries(VOICE_CONFIG_FIELDS.filter(key=>typeof saved.config?.[key]==='string').map(key=>[key,saved.config[key]])),searchRoots:Array.isArray(saved.config?.searchRoots)?saved.config.searchRoots:[]},
      bindings:structuredClone(saved.bindings||{}),environments:saved.environments||[],
      environmentPlan:saved.environmentPlan||null,
      modelPlan:structuredClone(saved.modelPlan||null),
      task:saved.task&&typeof saved.task==='object'?saved.task:null};
    if(this.record.task?.status==='running')this.record.task={...this.record.task,status:'interrupted',stage:'interrupted',error:'上次安装已中断，已下载的部分保留，可继续安装。'};
    if(this.record.environmentPlan?.status==='running')this.record.environmentPlan.status='interrupted';
    if(['planning','running'].includes(this.record.modelPlan?.status))this.record.modelPlan.status='interrupted';
    this.signature=createHash('sha256').update(JSON.stringify(this.spec.runtime)).digest('hex');
    this.installed={...this.installed,...saved.installed};
    for(const [field,[provider,kind]] of Object.entries(MODEL_BINDINGS))if(this.record.config[field]&&this.record.bindings[field]?.inspectionVersion!==VOICE_MODEL_INSPECTION_VERSION)this.record.bindings[field]=unverifiedModel({...this.record.bindings[field],path:this.record.config[field],provider,kind});
    // Startup and state reads use persisted metadata only. Discovery starts explicitly on module entry.
    this.initialized=Promise.resolve();
  }
  state() {
    const config=structuredClone(this.record.config);delete config.httpApiKey;
    const modelPlan=structuredClone(this.record.modelPlan);if(modelPlan?.rootDirectory)modelPlan.stale=modelPlan.rootDirectory!==this.record.directory;
    const discovery=this.discovery.read({fingerprint:JSON.stringify([this.searchRoots,this.record.config.searchRoots])});
    if(discovery.result?.models?.some(item=>item.inspectionVersion!==VOICE_MODEL_INSPECTION_VERSION)){
      discovery.stale=true;discovery.result.models=discovery.result.models.map(item=>item.inspectionVersion===VOICE_MODEL_INSPECTION_VERSION?item:unverifiedModel(item));
    }
    return {directory:this.record.directory,config,hasHttpApiKey:!!this.record.config.httpApiKey,
      providers:structuredClone(VOICE_PROVIDERS),modelInspectionVersion:VOICE_MODEL_INSPECTION_VERSION,discovery,bindings:structuredClone(this.record.bindings),environments:structuredClone(this.record.environments),environmentPlan:structuredClone(this.record.environmentPlan),modelPlan,modelDownloads:structuredClone(QWEN_DOWNLOAD_PRESETS),
      components:IDS.map(id=>({id,name:id==='runtime'?this.spec.runtime.name:this.spec.models[id].name,
        repository:id==='runtime'?null:this.spec.models[id].repository??null,revision:id==='runtime'?null:this.spec.models[id].revision??null,
        sourceUrl:id==='runtime'?(this.spec.runtime.uv?.version?`https://github.com/astral-sh/uv/releases/tag/${this.spec.runtime.uv.version}`:null):
          this.spec.models[id].repository&&this.spec.models[id].revision?`https://huggingface.co/${this.spec.models[id].repository}/tree/${this.spec.models[id].revision}`:null,
        installed:this.installed[id],ready:this.installed[id]&&(id==='runtime'||this.record.bindings[KEYS[id]]?.status==='available'&&this.record.bindings[KEYS[id]]?.inspectionVersion===VOICE_MODEL_INSPECTION_VERSION),downloadBytes:id==='runtime'?this.spec.runtime.downloadBytes:this.spec.models[id].downloadBytes})),
      task:structuredClone(this.record.task),supported:this.supported};
  }
  ensureOpen() { if(this.closed)throw new WorkbenchError(409,'声音组件控制器已关闭。'); }
  ensureIdle() { if(this.job||this.operation)throw new WorkbenchError(409,'请等待当前声音组件操作完成。'); }
  persist() { this.store.setSetting(SETTING,{...this.record,installed:this.installed}); }
  async createRecord(path,value) {
    await checkedLocalPath(path);const handle=await this.openFile(path,'wx');let created;
    try{
      created=await handle.stat();await handle.writeFile(JSON.stringify(value),'utf8');await handle.close();
    }catch(error){
      await handle.close().catch(()=>{});
      // 排他创建成功后，只有路径仍指向本次句柄的文件才允许清理；EEXIST 从不进入这里。
      try{
        const current=await ordinaryFile(path);
        if(created&&current&&current.ino===created.ino&&current.dev===created.dev){await checkedLocalPath(path);await rm(path);}
      }catch{}
      throw error;
    }
  }
  updateTask(patch) { Object.assign(this.record.task,patch);this.persist(); }
  async modelDirectory(id) { return insideDirectory(this.record.directory,'components',this.spec.models[id].directory); }
  async runtimeDirectory() { return insideDirectory(this.record.directory,'components',this.spec.runtime.directory); }
  async managedPython() { return insideDirectory(await this.runtimeDirectory(),'moss-py312','Scripts','python.exe'); }
  async verifyModel(id,path,signal) {
    await checkedLocalPath(path);signal.throwIfAborted();
    for(const file of this.spec.models[id].files) {
      if(!await verifiedFile(await insideDirectory(path,file.filename),file,signal))return false;
    }
    return true;
  }
  async verifyRuntime(path,signal) {
    await checkedLocalPath(path);signal.throwIfAborted();
    const info=await ordinaryFile(path);if(!info||!info.size)return false;
    if(this.runtimeProbe){const result=await this.runtimeProbe(path,{signal});signal.throwIfAborted();return Boolean(result);}
    const script=String.raw`import sys,json,importlib.metadata as m
assert sys.version_info[:2] == (3,12), "需要 Python 3.12"
required={"torch":"2.9.1+cu128","torchaudio":"2.9.1+cu128","transformers":"5.0.0","numpy":"2.1.0","safetensors":"0.6.2","soundfile":"0.14.0","scipy":"1.16.2"}
for name,version in required.items():
    assert m.version(name)==version, name+" 版本与声音环境不一致"
import torch,torchaudio,numpy,soundfile,transformers
from scipy.signal import resample_poly
from transformers import AutoModel,AutoProcessor
from transformers.modeling_utils import PreTrainedAudioTokenizerBase
print(json.dumps({"ready":True}))`;
    const result=await this.command(path,['-I','-B','-X','utf8','-c',script],{signal,timeoutMs:this.runtimeProbeTimeoutMs});signal.throwIfAborted();
    return result.stdout.trim().split(/\r?\n/).some(line=>{try{return JSON.parse(line).ready===true;}catch{return false;}});
  }
  async verifiedCandidate(id,path,signal) {
    if(!path)return false;
    try{return id==='runtime'?await this.verifyRuntime(path,signal):await this.verifyModel(id,path,signal);}
    catch { signal.throwIfAborted();return false; }
  }
  async inspectConfigured() {
    const signal=this.lifetime.signal;
    for(const id of IDS) {
      if(this.closed)return;
      signal.throwIfAborted();const path=this.record.config[KEYS[id]];
      const binding=id==='runtime'?await inspectVoiceEnvironment(path,'moss'):await inspectVoiceModel(path,{provider:'moss',kind:id});
      this.record.bindings[KEYS[id]]=binding;this.installed[id]=binding.status==='available';
    }
    this.record.environments=[this.record.bindings.pythonPath,await inspectVoiceEnvironment(this.record.config.qwenPythonPath,'qwen3-tts',{sourcePath:this.record.config.qwenSourcePath})];
    for(const [field,kind] of [['qwenBasePath','base'],['qwenCustomVoicePath','custom-voice'],['qwenDesignPath','voice-design']])this.record.bindings[field]=await inspectVoiceModel(this.record.config[field],{provider:'qwen3-tts',kind});
  }
  async findComponent(id,signal) {
    const key=KEYS[id];
    const own=id==='runtime'?await this.managedPython():await this.modelDirectory(id);
    for(const path of [...new Set([this.record.config[key],...(this.candidates[key]||[]),own].filter(Boolean))]) {
      signal.throwIfAborted();if(await this.verifiedCandidate(id,path,signal))return path;
    }
    return null;
  }
  async reusableExternalBinding(id,signal) {
    const configured=this.record.config[KEYS[id]];if(!configured)return null;
    try{
      signal.throwIfAborted();const path=await readableLocalPath(configured),own=id==='runtime'?await this.managedPython():await this.modelDirectory(id);
      const identity=value=>process.platform==='win32'?resolve(value).toLowerCase():resolve(value);
      if(identity(path)===identity(own))return null;
      const root=id==='runtime'?dirname(dirname(path)):path;
      const markers=[join(root,'.workbench-storage-owner.json'),...(id==='runtime'?[join(root,VENV_OWNER),join(dirname(root),'voice-runtime-owner.json')]:[])];
      // Even a damaged ownership marker keeps managed resources on the full hash/probe path.
      for(const marker of markers){try{await lstat(marker);return null;}catch(error){if(error.code!=='ENOENT')throw error;}}
      const binding=id==='runtime'?await inspectVoiceEnvironment(path,'moss'):await inspectVoiceModel(path,{provider:'moss',kind:id});
      signal.throwIfAborted();return binding.status==='available'?{path:configured,binding}:null;
    }catch{signal.throwIfAborted();return null;}
  }
  async detect(value={}) {
    fields(value,['refresh']);if(value.refresh!==undefined&&typeof value.refresh!=='boolean')throw new WorkbenchError(400,'刷新选项必须为布尔值。');this.ensureOpen();this.ensureIdle();
    const operation={promise:null};this.operation=operation;
    operation.promise=(async()=>{
      await this.initialized;const signal=this.lifetime.signal;signal.throwIfAborted();
      await this.discovery.run(async()=>{
        const result=await this.discover({roots:[...this.searchRoots,...this.record.config.searchRoots,this.record.directory],candidates:this.candidates,signal});
        await this.inspectConfigured();this.persist();return result;
      },{refresh:value.refresh===true,fingerprint:JSON.stringify([this.searchRoots,this.record.config.searchRoots])});
      signal.throwIfAborted();return this.state();
    })();
    try{return await operation.promise;}finally{if(this.operation===operation)this.operation=null;}
  }
  async configure(values) {
    fields(values,['directory',...VOICE_CONFIG_FIELDS],'声音组件配置');this.ensureOpen();this.ensureIdle();
    const operation={promise:null};this.operation=operation;
    operation.promise=(async()=>{
      await this.initialized;const signal=this.lifetime.signal;signal.throwIfAborted();
      const config={...this.record.config};const installed={...this.installed};let directory=this.record.directory;
      for(const [key,value] of Object.entries(values)) {
        if(key==='searchRoots'){
          if(!Array.isArray(value)||value.length>16)throw new WorkbenchError(400,'扫描目录最多 16 项。');
          config.searchRoots=await Promise.all(value.map(path=>readableLocalPath(path)));continue;
        }
        if(typeof value!=='string'||value.length>32767)throw new WorkbenchError(400,'组件路径必须是本地绝对路径。');
        if(key==='directory') {directory=await checkedLocalPath(value);continue;}
        if(key==='provider'){if(!VOICE_PROVIDERS.some(item=>item.id===value))throw new WorkbenchError(400,'声音提供者无效。');config.provider=value;continue;}
        if(!VOICE_PATH_FIELDS.includes(key)){
          if(/[\u0000-\u001f]/.test(value)||value.length>4096)throw new WorkbenchError(400,'HTTP 声音配置无效。');
          if(key==='httpUrl'&&value){let url;try{url=new URL(value);}catch{}if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new WorkbenchError(400,'请填写 HTTP 或 HTTPS speech 接口地址。');}
          config[key]=value;continue;
        }
        const id=IDS.find(id=>KEYS[id]===key);
        if(!value) {config[key]='';if(id)installed[id]=false;continue;}
        const path=await readableLocalPath(value).catch(error=>{if(['ENOENT','ENOTDIR'].includes(error.code))throw new WorkbenchError(409,'配置路径不存在，请检查本地路径。');throw error;});
        const info=await lstat(path).catch(()=>null);if(!info||(/PythonPath$|^pythonPath$/.test(key)?!info.isFile():!info.isDirectory()))throw new WorkbenchError(409,'配置路径不存在或类型不符，请检查本地路径。');
        config[key]=path;
      }
      signal.throwIfAborted();this.record.directory=directory;this.record.config=config;this.installed=installed;await this.inspectConfigured();this.persist();return this.state();
    })();
    try{return await operation.promise;}finally{if(this.operation===operation)this.operation=null;}
  }
  install(value={}) {
    fields(value,['component','provider','environmentMode','planId','action','modelKind','size']);this.ensureOpen();
    if(!this.supported)throw new WorkbenchError(400,'声音组件自动安装当前仅支持 Windows x64。');
    if(value.action){if(value.action!=='plan-model'||value.provider!=='qwen3-tts')throw new WorkbenchError(400,'请选择有效的 Qwen 模型下载操作。');return this.prepareModel(value);}
    if(value.planId&&this.record.modelPlan?.id===value.planId)return this.installModel(value.planId);
    if(value.environmentMode){this.ensureIdle();return this.prepareEnvironment(value);}
    let plan;
    if(value.planId){
      plan=this.record.environmentPlan;
      if(!plan||plan.id!==value.planId||!['prepared','failed','cancelled','interrupted'].includes(plan.status))throw new WorkbenchError(409,'环境安装计划无效或已执行，请重新准备计划。');
      const current=this.record.config[plan.provider==='qwen3-tts'?'qwenPythonPath':'pythonPath'];
      if(current!==plan.pythonPath||(plan.sourcePath||'')!==(plan.provider==='qwen3-tts'?this.record.config.qwenSourcePath||'':''))throw new WorkbenchError(409,'环境配置已改变，请重新准备计划。');
    }else if(![...IDS,'all',...Object.keys(REQUIRED_COMPONENTS)].includes(value.component))throw new WorkbenchError(400,'请选择有效的声音组件。');
    if(this.job)return this.state();this.ensureIdle();
    const job={controller:new AbortController(),intent:null,promise:null};this.job=job;
    this.record.task={status:'running',stage:'preparing',component:plan?'runtime':value.component,provider:plan?.provider,completedBytes:0,
      totalBytes:plan||value.component==='runtime'||value.component==='all'||REQUIRED_COMPONENTS[value.component]?null:this.spec.models[value.component].downloadBytes,error:null};
    if(plan){this.record.task.totalBytes=null;plan.status='running';}
    try{this.persist();}catch(error){this.job=null;throw error;}
    job.promise=Promise.resolve().then(async()=>{const release=acquireResourceStorageLease(this.dataDir,'voice');try{return await (plan?this.performEnvironment(job,plan):this.performInstall(job,value.component));}finally{release();}}).catch(error=>{
      if(plan)plan.status=job.intent||'failed';
      this.updateTask({status:job.intent||'failed',stage:job.intent||this.record.task.stage,
        error:job.intent==='cancelled'?null:job.intent==='interrupted'?'工作台已关闭，下载已保留，可继续安装。':errorText(error)});
    }).finally(()=>{if(this.job===job)this.job=null;});
    // 错误始终反映在任务状态，避免后台 Promise 造成未处理拒绝。
    job.promise=job.promise.catch(()=>{if(this.record.task)this.record.task.error='无法保存声音安装记录，请检查资料目录。';});
    return this.state();
  }
  modelJob({stage,work,planId=null,totalBytes=null}){
    this.ensureIdle();const job={controller:new AbortController(),intent:null,promise:null,modelPlanId:planId};this.job=job;
    this.record.task={status:'running',stage,provider:'qwen3-tts',component:this.record.modelPlan.modelKind,planId,completedBytes:0,totalBytes,error:null};
    try{this.persist();}catch(error){this.job=null;this.record.task.status=this.record.task.stage='failed';this.record.task.error='无法保存模型下载记录，请检查资料目录。';if(this.record.modelPlan)this.record.modelPlan.status='failed';throw error;}
    const signal=AbortSignal.any([job.controller.signal,this.lifetime.signal]);
    job.promise=Promise.resolve().then(async()=>{const release=acquireResourceStorageLease(this.dataDir,'voice');try{return await work(signal);}finally{release();}}).catch(error=>{
      if(this.record.modelPlan)this.record.modelPlan.status=job.intent||'failed';
      this.updateTask({status:job.intent||'failed',stage:job.intent||'failed',error:job.intent==='cancelled'?null:job.intent==='interrupted'?'工作台已关闭，下载计划与部分文件已保留。':errorText(error)});
    }).finally(()=>{if(this.job===job)this.job=null;});
    job.promise=job.promise.catch(()=>{if(this.record.task)this.record.task.error='无法保存模型下载记录，请检查资料目录。';});return this.state();
  }
  prepareModel(value){
    qwenModelPreset(value.modelKind,value.size);this.ensureIdle();
    this.record.modelPlan={provider:'qwen3-tts',modelKind:value.modelKind,size:value.size,status:'planning'};
    const directory=this.record.directory;
    return this.modelJob({stage:'querying-model',work:async signal=>{
      const plan=await prepareQwenModelPlan({modelKind:value.modelKind,size:value.size,directory,fetchImpl:this.fetch,signal});signal.throwIfAborted();
      this.record.modelPlan=plan;this.updateTask({status:'completed',stage:'model-plan-ready',totalBytes:plan.downloadBytes,completedBytes:0,planId:plan.id});
    }});
  }
  installModel(planId){
    const plan=this.record.modelPlan;
    if(plan.rootDirectory!==this.record.directory)throw new WorkbenchError(409,'模型下载目录已改变，请重新查询清单后再执行。');
    if(this.job?.modelPlanId===planId||plan.status==='completed')return this.state();
    if(!['prepared','failed','cancelled','interrupted'].includes(plan.status))throw new WorkbenchError(409,'模型下载计划尚未准备好，请重新查询清单。');
    this.ensureIdle();plan.status='running';
    return this.modelJob({stage:'preparing',planId,totalBytes:plan.downloadBytes,work:async signal=>{
      const release=await this.acquireLock(signal);let ownership,binding;
      try{
        ownership=await beginManagedRoot({dataDir:this.dataDir,root:plan.directory,existingOnly:true});
        binding=await downloadQwenModelPlan({plan,directory:this.record.directory,fetchImpl:this.fetch,signal,createRecord:async(path,record)=>{
          ownership=await beginManagedRoot({dataDir:this.dataDir,root:dirname(path)});await this.createRecord(path,record);
        },idleTimeoutMs:this.idleTimeoutMs,
          onProgress:(bytes,filename)=>{this.record.task.completedBytes=bytes;this.record.task.filename=filename;},onStage:(stage,filename)=>this.updateTask({stage,filename})});
      }finally{
        try{
          const names=new Set(plan.files.map(file=>file.filename)),id=plan.id+'-'+createHash('sha256').update(plan.directory).digest('hex').slice(0,16),name=qwenModelPreset(plan.modelKind,plan.size).basename;
          await recordManagedTree({dataDir:this.dataDir,ownership,id,name,family:'voice',select:path=>names.has(path)||path==='.workbench-qwen-model.json',expectedHashes:new Map(plan.files.map(file=>[file.filename,file.sha256]))});
          await recordManagedTree({dataDir:this.dataDir,ownership,id:id+'-parts',name:name+' 下载分片',family:'voice',kind:'cache',select:path=>path.endsWith('.part')&&names.has(path.slice(0,-5))});
        }finally{await release();}
      }
      // 完成状态会开放绑定操作，必须等文件登记和锁释放全部结束后再发布。
      signal.throwIfAborted();plan.status='completed';plan.bindingStatus=binding.status;plan.finishedAt=new Date().toISOString();this.updateTask({status:'completed',stage:'completed',completedBytes:plan.downloadBytes,totalBytes:plan.downloadBytes});
    }});
  }
  prepareEnvironment(value){
    const provider=value.provider,mode=value.environmentMode,config=this.record.config;
    if(!['moss','qwen3-tts'].includes(provider)||!['repair-existing','create-isolated'].includes(mode))throw new WorkbenchError(400,'请选择有效的声音环境方案。');
    const pythonPath=config[provider==='qwen3-tts'?'qwenPythonPath':'pythonPath'];
    if(!pythonPath)throw new WorkbenchError(409,'请先绑定此引擎的 Python 解释器，作为修复或新建环境的基础。');
    if(mode==='repair-existing'&&config.pythonPath&&config.qwenPythonPath&&resolve(config.pythonPath).toLowerCase()===resolve(config.qwenPythonPath).toLowerCase())throw new WorkbenchError(409,'MOSS 与 Qwen 当前共用 Python，请选择新建隔离环境，避免替换另一引擎的依赖。');
    const id=randomUUID(),target=mode==='create-isolated'?join(this.record.directory,'environments',provider+'-'+id):dirname(dirname(pythonPath));
    const python=mode==='create-isolated'?join(target,'Scripts','python.exe'):pythonPath;
    const packages=provider==='qwen3-tts'?['qwen-tts==0.1.1','transformers==4.57.3','accelerate==1.12.0','soundfile==0.14.0','scipy==1.16.2']:this.spec.runtime.packages;
    const sourcePath=provider==='qwen3-tts'?config.qwenSourcePath:'';
    const commands=[];
    if(mode==='create-isolated')commands.push({executable:pythonPath,args:['-I','-B','-m','venv',target],stage:'creating-environment'});
    if(provider==='moss')commands.push({executable:python,args:['-I','-B','-m','pip','install','--disable-pip-version-check','--index-url','https://download.pytorch.org/whl/cu128',...this.spec.runtime.torchPackages],stage:'installing-pytorch'});
    commands.push({executable:python,args:['-I','-B','-m','pip','install','--disable-pip-version-check',...packages,...(sourcePath?[sourcePath]:[])],stage:'installing-dependencies'});
    this.record.environmentPlan={id,provider,mode,status:'prepared',pythonPath,sourcePath,target,python,packages,commands,createdAt:new Date().toISOString(),
      consequence:mode==='repair-existing'?'执行会安装或更换原环境中的依赖，使用该环境的其他程序也会受到影响。':'执行会在资料目录创建独立环境并联网安装依赖；原环境保留。'};
    this.persist();return this.state();
  }
  async performEnvironment(job,plan){
    const signal=AbortSignal.any([job.controller.signal,this.lifetime.signal]);signal.throwIfAborted();
    await checkedLocalPath(plan.pythonPath);if(!await ordinaryFile(plan.pythonPath))throw new WorkbenchError(409,'基础 Python 已不存在，请重新绑定。');
    if(plan.sourcePath){await checkedLocalPath(plan.sourcePath);if(!(await lstat(plan.sourcePath))?.isDirectory())throw new WorkbenchError(409,'Qwen 源码目录不存在。');}
    const release=await this.acquireLock(signal);
    try{
      if(plan.mode==='create-isolated'){
        const parent=await insideDirectory(this.record.directory,'environments');await mkdir(parent,{recursive:true});
        const target=await insideDirectory(parent,plan.target),marker=await insideDirectory(target,'workbench-environment.json');
        try{await mkdir(target);await this.createRecord(marker,{owner:OWNER,planId:plan.id,provider:plan.provider});}
        catch(error){if(error.code!=='EEXIST')throw error;const previous=JSON.parse(await readFile(marker,'utf8').catch(()=>'{"owner":"unknown"}'));if(previous.owner!==OWNER||previous.planId!==plan.id)throw new WorkbenchError(409,'隔离环境目录已有其他文件，已保留原目录。');}
      }
      for(const step of plan.commands){
        signal.throwIfAborted();this.updateTask({stage:step.stage,log:''});
        await this.command(step.executable,step.args,{signal,env:{PYTHONUTF8:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1'},cwd:plan.mode==='create-isolated'?plan.target:dirname(plan.pythonPath),onOutput:chunk=>{this.record.task.log=(this.record.task.log+chunk.replace(/\x1b\[[0-9;]*m/g,'')).slice(-4096);}});
      }
      signal.throwIfAborted();const environment=await inspectVoiceEnvironment(plan.python,plan.provider,{sourcePath:plan.sourcePath});
      if(environment.status!=='available')throw new WorkbenchError(409,'依赖安装后仍未兼容：'+environment.issues.join('；'));
      this.record.config[plan.provider==='qwen3-tts'?'qwenPythonPath':'pythonPath']=plan.python;await this.inspectConfigured();
      plan.status='completed';this.updateTask({status:'completed',stage:'completed',error:null});
    }finally{await release();}
  }
  executionConfig(){return structuredClone(this.record.config);}
  async acquireLock(signal) {
    const root=await insideDirectory(this.record.directory,'components');await mkdir(root,{recursive:true});
    const path=await insideDirectory(root,'.install-lock.json');const token=randomUUID();
    const mutex=await insideDirectory(root,'.install-lock.sqlite');
    const existing=await ordinaryFile(mutex);
    if(existing?.size)throw new WorkbenchError(409,'安装锁目录已有未知数据库，请保留原文件后检查目录。');
    for(const suffix of ['-journal','-wal','-shm']){
      await ordinaryFile(await insideDirectory(root,'.install-lock.sqlite'+suffix));
    }
    let database;
    const releaseMutex=()=>{if(database){try{database.exec('ROLLBACK');}catch{}try{database.close();}finally{database=null;}}};
    const create=async()=>{
      signal.throwIfAborted();await this.createRecord(path,{owner:OWNER,pid:process.pid,token});
    };
    try{
      signal.throwIfAborted();database=new DatabaseSync(mutex,{timeout:0});
      // 无 schema、无写事务内容；OS 在连接关闭或进程退出时释放互斥，不遗留第二种 stale 锁。
      database.exec('PRAGMA busy_timeout=0;BEGIN EXCLUSIVE');
      try{await create();}catch(error){
        if(error.code!=='EEXIST')throw error;
        let stale=false;
        try{
          const info=await ordinaryFile(path);if(info?.size<4096) {
            const saved=JSON.parse(await readFile(path,'utf8'));
            if(saved.owner===OWNER&&Number.isInteger(saved.pid)&&saved.pid>0) {
              try{process.kill(saved.pid,0);}catch(failure){stale=failure.code==='ESRCH';}
            }
          }
        }catch{}
        if(!stale)throw new WorkbenchError(409,'另一个工作台正在安装声音组件，请等待它完成。');
        // stale 接管也必须在 SQLite 互斥内，避免旧判断删除另一实例的新活动锁。
        await checkedLocalPath(path);signal.throwIfAborted();await rm(path);await create();
      }
    }catch(error){
      releaseMutex();
      if(/database is (?:locked|busy)/i.test(error.message||''))throw new WorkbenchError(409,'另一个工作台正在安装声音组件，请等待它完成。');
      throw error;
    }
    return async()=>{
      try{await checkedLocalPath(path);const saved=JSON.parse(await readFile(path,'utf8'));if(saved.token===token)await rm(path);}catch{}
      finally{releaseMutex();}
    };
  }
  async performInstall(job,component) {
    await this.initialized;const signal=AbortSignal.any([job.controller.signal,this.lifetime.signal]);signal.throwIfAborted();
    const release=await this.acquireLock(signal);
    try{
      const required=REQUIRED_COMPONENTS[component],ids=required||(component==='all'?IDS:[component]);let completed=0;
      const total=ids.filter(id=>id!=='runtime').reduce((sum,id)=>sum+this.spec.models[id].downloadBytes,0);
      for(const id of ids) {
        signal.throwIfAborted();this.updateTask({component:id,stage:'detecting',completedBytes:id==='runtime'?0:completed,totalBytes:id==='runtime'?null:total});
        const reusable=required?await this.reusableExternalBinding(id,signal):null;
        const existing=reusable?.path||await this.findComponent(id,signal);signal.throwIfAborted();
        if(existing) {
          this.record.config[KEYS[id]]=existing;this.installed[id]=true;
          if(reusable)this.record.bindings[KEYS[id]]=reusable.binding;
          else if(id!=='runtime')this.record.bindings[KEYS[id]]=await inspectVoiceModel(existing,{provider:'moss',kind:id});
          this.persist();
          if(id!=='runtime')completed+=this.spec.models[id].downloadBytes;
          continue;
        }
        this.installed[id]=false;
        if(id==='runtime')await this.installRuntime(signal);
        else {
          const root=await this.modelDirectory(id),ownership=await beginManagedRoot({dataDir:this.dataDir,root});await mkdir(root,{recursive:true});let current=completed;
          try{for(const file of this.spec.models[id].files) {
            const target=await insideDirectory(root,file.filename);const base=current;
            await downloadVerified({file,target,fetchImpl:this.fetch,signal,idleTimeoutMs:this.idleTimeoutMs,
              onProgress:bytes=>{this.record.task.completedBytes=base+bytes;},onStage:stage=>this.updateTask({stage})});
            current+=file.bytes;
          }}finally{
            const names=new Set(this.spec.models[id].files.map(file=>file.filename));
            await recordManagedTree({dataDir:this.dataDir,ownership,id:'voice-'+id,scopeToRoot:true,name:this.spec.models[id].name,family:'voice',select:path=>names.has(path)});
            await recordManagedTree({dataDir:this.dataDir,ownership,id:'voice-'+id+'-parts',scopeToRoot:true,name:this.spec.models[id].name+' 下载分片',family:'voice',kind:'cache',select:path=>path.endsWith('.part')&&names.has(path.slice(0,-5))});
          }
          signal.throwIfAborted();completed=current;this.record.config[KEYS[id]]=root;
        }
        signal.throwIfAborted();this.installed[id]=true;
        if(id!=='runtime')this.record.bindings[KEYS[id]]=await inspectVoiceModel(this.record.config[KEYS[id]],{provider:'moss',kind:id});
        this.persist();
      }
      signal.throwIfAborted();this.updateTask({status:'completed',stage:'completed',component,completedBytes:component==='runtime'?0:completed,
        totalBytes:component==='runtime'?null:total,error:null});
    }finally{await release();}
  }
  async ownedRuntime(root,signal) {
    await checkedLocalPath(root);await mkdir(root,{recursive:true});const owner=await insideDirectory(root,'voice-runtime-owner.json');
    const info=await ordinaryFile(owner);
    if(info) {
      if(info.size>4096)throw new WorkbenchError(409,'声音运行环境的安装记录无效。');
      const saved=JSON.parse(await readFile(owner,'utf8'));
      if(saved.owner!==OWNER||saved.signature!==this.signature)throw new WorkbenchError(409,'运行环境目录包含其他版本，请保留并移走原目录后重试。');
    } else {
      if((await readdir(root)).length)throw new WorkbenchError(409,'运行环境目录已有其他文件，请保留并移走原目录后重试。');
      signal.throwIfAborted();await this.createRecord(owner,{owner:OWNER,signature:this.signature});
    }
  }
  async findUv(signal) {
    for(const path of this.candidates.uvPath||[]) {
      try{
        await checkedLocalPath(path);if(!await ordinaryFile(path))continue;
        const result=await this.command(path,['--version'],{signal,timeoutMs:10000});
        const version=result.stdout.match(/^uv (\d+\.\d+\.\d+)(?:\s|$)/);
        if(version&&version[1]===this.spec.runtime.uv.version)return path;
      }catch {signal.throwIfAborted();}
    }
    return null;
  }
  async installUv(root,signal) {
    const spec=this.spec.runtime.uv;const downloads=await insideDirectory(root,'downloads');await mkdir(downloads,{recursive:true});
    const archive=await insideDirectory(downloads,spec.filename);
    this.updateTask({stage:'downloading-uv',completedBytes:0,totalBytes:spec.bytes});
    await downloadVerified({file:spec,target:archive,fetchImpl:this.fetch,signal,idleTimeoutMs:this.idleTimeoutMs,
      onProgress:bytes=>{this.record.task.completedBytes=bytes;},onStage:stage=>this.updateTask({stage:stage==='verifying'?'verifying-uv':'downloading-uv'})});
    const target=await insideDirectory(root,'uv');
    const executable=await insideDirectory(target,spec.executable);
    if(await ordinaryFile(executable)) {
      if(await verifiedFile(executable,spec.executableFile,signal))return executable;
      throw new WorkbenchError(409,'已安装 uv 工具校验失败，原文件保持不变，请保留并移走后重试。');
    }
    const staging=await insideDirectory(root,`uv-${randomUUID()}.part`);
    try{
      this.updateTask({stage:'extracting-uv',completedBytes:0,totalBytes:null});
      await this.extract({archive,destination:staging,unpackedBytes:spec.unpackedBytes,signal});
      signal.throwIfAborted();if(!await verifiedFile(await insideDirectory(staging,spec.executable),spec.executableFile,signal))throw new WorkbenchError(500,'解压后的 uv 工具未通过 SHA256 校验。');
      await checkedLocalPath(target);await rename(staging,target);return executable;
    }finally{await insideDirectory(root,staging);await rm(staging,{recursive:true,force:true}).catch(()=>{});}
  }
  async installRuntime(signal) {
    const root=await this.runtimeDirectory();await this.ownedRuntime(root,signal);
    const uv=await this.findUv(signal)||await this.installUv(root,signal);
    const managed=await insideDirectory(root,'python');const cache=await insideDirectory(root,'uv-cache');
    const cacheOwnership=await beginManagedRoot({dataDir:this.dataDir,root:cache});
    try{
    const environment=await insideDirectory(root,'moss-py312');const python=await this.managedPython();
    const env={UV_PYTHON_INSTALL_DIR:managed,UV_CACHE_DIR:cache,UV_PYTHON_INSTALL_BIN:'0',UV_NO_CONFIG:'1'};
    const run=async(args,stage)=>{
      this.updateTask({stage,completedBytes:0,totalBytes:null,log:''});
      return this.command(uv,args,{signal,env,cwd:root,onOutput:chunk=>{this.record.task.log=(this.record.task.log+chunk.replace(/\x1b\[[0-9;]*m/g,'')).slice(-4096);}});
    };
    await run(['python','install',this.spec.runtime.pythonVersion,'--no-bin','--no-registry','--no-config'],'installing-python');
    const result=await run(['python','find',this.spec.runtime.pythonVersion,'--managed-python','--no-python-downloads','--no-config'],'creating-environment');
    const base=await checkedLocalPath(result.stdout.trim());
    let environmentInfo;
    try{environmentInfo=await lstat(environment);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(environmentInfo){
      const owner=await insideDirectory(environment,VENV_OWNER);let owned=false;
      try{const info=await ordinaryFile(owner);if(info&&info.size<4096){const record=JSON.parse(await readFile(owner,'utf8'));owned=record.owner===OWNER&&record.signature===this.signature&&record.kind==='venv';}}catch{}
      if(!environmentInfo.isDirectory()||!owned)throw new WorkbenchError(409,'Python 环境目录已有其他文件，归属未确认，原目录保持不变。');
      if(!await ordinaryFile(python))throw new WorkbenchError(409,'已安装 Python 解释器缺失，请保留并移走此环境目录后重试。');
    }else{
      // 随机私有暂存目录中的 venv 可随失败清理；最终目录只接收已能启动的解释器。
      const staging=await mkdtemp(await insideDirectory(root,'venv-'));const token=randomUUID();let marked=false;
      const marker=await insideDirectory(staging,'owner.json');
      try{
        await this.createRecord(marker,{owner:OWNER,signature:this.signature,token,kind:'venv-staging'});marked=true;
        const temporary=await insideDirectory(staging,'moss-py312');
        await run(['venv','--relocatable','--python',base,'--no-python-downloads','--no-config',temporary],'creating-environment');
        const candidate=await insideDirectory(temporary,'Scripts','python.exe');
        if(!(await ordinaryFile(candidate))?.size)throw new WorkbenchError(500,'新建 Python 环境缺少解释器，已保留重试能力。');
        signal.throwIfAborted();const probe=await this.command(candidate,['-I','-B','-X','utf8','-c',
          'import sys,json; assert sys.version_info[:2]==(3,12); print(json.dumps({"pythonReady":True}))'],{signal,timeoutMs:this.runtimeProbeTimeoutMs});
        if(!probe.stdout.trim().split(/\r?\n/).some(line=>{try{return JSON.parse(line).pythonReady===true;}catch{return false;}}))throw new WorkbenchError(500,'新建 Python 解释器未通过启动验证。');
        await this.createRecord(await insideDirectory(temporary,VENV_OWNER),{owner:OWNER,signature:this.signature,kind:'venv'});
        signal.throwIfAborted();await checkedLocalPath(environment);
        try{await lstat(environment);throw new WorkbenchError(409,'Python 环境目标出现其他目录，原目录保持不变。');}catch(error){if(error.code!=='ENOENT')throw error;}
        await rename(temporary,environment);
      }finally{
        await insideDirectory(root,staging);
        if(marked){
          const saved=JSON.parse(await readFile(await insideDirectory(staging,'owner.json'),'utf8'));
          if(saved.owner===OWNER&&saved.token===token&&saved.signature===this.signature&&saved.kind==='venv-staging')await rm(staging,{recursive:true,force:true});
        }else await rmdir(staging).catch(()=>{});
      }
    }
    const shared=['pip','install','--python',python,'--no-deps','--only-binary',':all:','--no-config'];
    await run([...shared,'--index-url','https://download.pytorch.org/whl/cu128',...this.spec.runtime.torchPackages],'installing-pytorch');
    await run([...shared,'--index-url','https://pypi.org/simple',...this.spec.runtime.packages],'installing-dependencies');
    this.updateTask({stage:'verifying-runtime',completedBytes:0,totalBytes:null});
    if(!await this.verifyRuntime(python,signal))throw new WorkbenchError(500,'Python 依赖验证未通过，未启用声音组件。');
    signal.throwIfAborted();this.record.config.pythonPath=python;
    }finally{await recordManagedTree({dataDir:this.dataDir,ownership:cacheOwnership,id:'voice-runtime-cache',scopeToRoot:true,name:'声音运行环境 UV 缓存',family:'voice',kind:'cache'});}
  }
  async command(executable,args,{signal,env={},cwd,timeoutMs=this.commandTimeoutMs,onOutput}={}) {
    signal.throwIfAborted();
    // 清除全局索引/解释器覆盖，下载源只来自本控制器传入的固定参数。
    const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^UV_|^PIP_|^PYTHON|^VIRTUAL_ENV$|^CONDA_PREFIX$|^HF_ENDPOINT$/i.test(key)));
    Object.assign(environment,env,{CUDA_VISIBLE_DEVICES:'',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1'});
    const options={signal,env:environment,cwd,windowsHide:true,shell:false,onOutput};
    if(this.runCommand)return this.runCommand(executable,args,options);
    return new Promise((resolveCommand,reject)=>{
      const child=this.spawn(executable,args,{env:environment,cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='',failure=null,finished=false,stopping=false,termination=Promise.resolve();
      const stop=()=>{
        if(finished||stopping)return;stopping=true;
        const direct=()=>{try{child.kill('SIGKILL');}catch{}};
        if(process.platform==='win32'&&child.pid) {
          // Windows venv 的 python.exe 可能有解释器子进程，只终止本次 spawn 的确切 PID 树。
          termination=new Promise(done=>{
            try{
              const killer=this.spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore'});
              killer.once('error',()=>{direct();done();});killer.once('close',code=>{if(code!==0)direct();done();});
            }catch{direct();done();}
          });
        }else direct();
      };
      const timer=setTimeout(()=>{failure=new WorkbenchError(504,'声音环境安装超时，可重试继续。');stop();},timeoutMs);
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);};
      const finish=code=>{
        if(finished)return;finished=true;cleanup();
        termination.then(()=>{
          if(signal.aborted)reject(signal.reason);
          else if(failure)reject(failure);
          else if(code===0)resolveCommand({stdout,stderr});
          else reject(new WorkbenchError(500,`声音环境操作失败：${errorText(stderr||stdout||`进程退出 ${code}`)}`));
        });
      };
      child.stdout?.setEncoding('utf8');child.stderr?.setEncoding('utf8');
      child.stdout?.on('data',chunk=>{stdout=(stdout+chunk).slice(-65536);onOutput?.(chunk);});
      child.stderr?.on('data',chunk=>{stderr=(stderr+chunk).slice(-8192);onOutput?.(chunk);});
      child.once('error',error=>{failure=error;finish(null);});child.once('close',finish);
      signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    });
  }
  async cancel(value={}) {
    fields(value,[]);this.ensureOpen();const job=this.job;
    if(job){job.intent='cancelled';job.controller.abort();await job.promise;}
    return this.state();
  }
  async close() {
    if(this.closing)return this.closing;this.closed=true;
    if(this.job){this.job.intent='interrupted';this.job.controller.abort();}
    this.lifetime.abort();
    this.closing=Promise.allSettled([this.initialized,this.operation?.promise,this.job?.promise]).then(()=>{});return this.closing;
  }
}
