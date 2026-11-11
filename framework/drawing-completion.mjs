import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, isAbsolute } from 'node:path';
import { fields, identifier, WorkbenchError } from './contracts.mjs';
import { checkedLocalPath, insideDirectory, fileName } from './drawing-files.mjs';
import { isComfyDirectory } from './drawing-workflows.mjs';
import { dependencyId, extractWorkflowDependencies, replaceWorkflowReferences } from './drawing-dependencies.mjs';
import { discoverModelRoots, indexModelNames, inspectLocalModels } from './drawing-completion-local.mjs';
import { DrawingCompletionSources } from './drawing-completion-sources.mjs';
export { extractWorkflowDependencies } from './drawing-dependencies.mjs';

const ACTIVE=new Set(['queued','running','searching']);
const now=()=>new Date().toISOString();
const conflict=message=>new WorkbenchError(409,message);
const scopeFor=config=>{try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(config.serviceUrl).hostname)?'local':'remote';}catch{return 'unverified';}};
const visibleName=value=>value.replaceAll('\\','/');
const clone=value=>structuredClone(value);

async function inspectBudgetedModels(dependency,files,{cache,budget,signal,usage}) {
  if(!budget.active){budget.startedAt=Date.now();budget.deadline=budget.startedAt+Math.max(0,budget.maxMs-budget.elapsedMs);}
  budget.active++;
  try{return await inspectLocalModels(dependency,files,{cache,budget,signal});}
  finally {
    if(!--budget.active)budget.elapsedMs+=Date.now()-budget.startedAt;
    usage.hashBytes=budget.bytes;usage.hashElapsedMs=budget.elapsedMs+(budget.active?Date.now()-budget.startedAt:0);
  }
}

export class DrawingCompletion {
  constructor({drawing,manager,store,dataDir,fetchImpl=fetch,limits={}}) {
    this.drawing=drawing;this.manager=manager;this.store=store;this.directory=join(dataDir,'drawing','workflow-copies');
    this.limits={dependencies:20,requests:40,hashBytes:32*1024**3,hashMs:90000,...limits};
    this.sources=new DrawingCompletionSources({store,fetchImpl});this.hashCache=store.getSetting('drawing.completion.sha-cache')||{};
    this.reports=new Map((store.getSetting('drawing.completion.reports')||[]).map(report=>[report.id,report]));this.active=new Map();this.starting=new Map();this.closed=false;
    for(const report of this.reports.values())if(ACTIVE.has(report.status)){report.status='interrupted';report.warnings.push('上次补全检查已中断，可手动重新检查。');}
  }
  persist(){this.store.setSetting('drawing.completion.reports',[...this.reports.values()].slice(-30));this.store.setSetting('drawing.completion.sha-cache',this.hashCache);}
  public(report){const {document,fingerprint,configuration,...value}=report;return clone(value);}
  list(){return [...this.reports.values()].reverse().map(report=>this.public(report));}
  record(id){const report=this.reports.get(identifier(id));if(!report)throw new WorkbenchError(404,'找不到工作流补全报告。');return report;}
  get(id){return this.public(this.record(id));}
  open(){if(this.closed)throw conflict('工作流补全服务已关闭。');}
  assertCurrent(report){this.open();if(report.configuration!==JSON.stringify(this.drawing.config()))throw conflict('ComfyUI 配置已变化，请重新检查此工作流。');}
  create(value) {
    this.open();fields(value,['document','name','requestId','explicitDirectories']);
    if(value.requestId)identifier(value.requestId,'补全请求标识');
    if(value.explicitDirectories!==undefined&&(!Array.isArray(value.explicitDirectories)||value.explicitDirectories.length>30))throw new WorkbenchError(400,'显式模型目录最多 30 个。');
    for(const entry of value.explicitDirectories||[]){fields(entry,['path','category']);if(typeof entry.path!=='string'||!isAbsolute(entry.path)||/^[\\/]{2}|[\u0000-\u001f]/.test(entry.path))throw new WorkbenchError(400,'显式目录请使用本地磁盘绝对路径。');if(!['checkpoints','unet','diffusion_models','loras','clip','text_encoders','vae','controlnet','upscale_models'].includes(entry.category))throw new WorkbenchError(400,'显式模型目录类别无效。');}
    const encoded=JSON.stringify(value.document);if(!encoded||encoded.length>2*1024*1024)throw new WorkbenchError(413,'工作流应为不超过 2 MiB 的 JSON。');
    const fingerprint=dependencyId([value.document,value.explicitDirectories||[],this.drawing.config()]);
    const previous=value.requestId&&[...this.reports.values()].find(item=>item.requestId===value.requestId);
    if(previous){if(previous.fingerprint!==fingerprint)throw conflict('补全请求标识已用于其他内容。');return {report:previous,existing:true};}
    const extracted=extractWorkflowDependencies(value.document);
    const report={id:randomUUID(),requestId:value.requestId||null,fingerprint,configuration:JSON.stringify(this.drawing.config()),name:typeof value.name==='string'?value.name.slice(0,180):'导入工作流',document:clone(value.document),explicitDirectories:clone(value.explicitDirectories||[]),scope:scopeFor(this.drawing.config()),comfyPath:this.drawing.config().comfyPath||null,status:'queued',dependencies:extracted.dependencies.map(item=>({...item,status:'unverified',service:{status:'unverified'},local:{status:'unverified',identity:'unverified',files:[]},candidates:[],issues:[],searched:false})),warnings:extracted.warnings,nodeCount:extracted.nodeCount,partial:false,createdAt:now(),updatedAt:now(),budget:{requests:0,cacheHits:0,hashBytes:0,uniqueDependencies:0,limits:clone(this.limits)},ai:{calls:0,inputTokens:0,outputTokens:0,decision:'manual-selection'},downloads:[]};
    this.reports.set(report.id,report);while(this.reports.size>30){const oldest=[...this.reports.values()].find(item=>!ACTIVE.has(item.status));if(!oldest)break;this.reports.delete(oldest.id);}this.persist();return {report,existing:false};
  }
  async input(value){if(!value?.key)return value;fields(value,['key','name','requestId','explicitDirectories']);const file=await this.drawing.workflowFile(value.key);return {document:file.document,name:value.name||file.name,...(value.requestId?{requestId:value.requestId}:{}),...(value.explicitDirectories?{explicitDirectories:value.explicitDirectories}:{})};}
  async start(value){const {report,existing}=this.create(await this.input(value));if(existing)return this.public(report);this.run(report,signal=>this.check(report,signal));return this.public(report);}
  async inspect(value){const {report,existing}=this.create(await this.input(value));if(existing)return this.public(report);await this.run(report,signal=>this.check(report,signal));return this.public(report);}
  run(report,operation,networkBudget) {
    if(this.active.has(report.id))return this.active.get(report.id).promise;
    const previous=report.totalUsage||{rounds:report.budget.round||((report.budget.hashBytes||report.budget.requests)?1:0),requests:report.budget.requests||0,cacheHits:report.budget.cacheHits||0,hashBytes:report.budget.hashBytes||0,hashElapsedMs:report.budget.hashElapsedMs||0};
    report.budget={round:previous.rounds+1,requests:0,cacheHits:0,hashBytes:0,hashElapsedMs:0,uniqueDependencies:0,limits:clone(this.limits)};
    for(const dependency of report.dependencies)dependency.local.hashAttempts=0;
    const controller=new AbortController();const job={controller,promise:null};this.active.set(report.id,job);
    job.promise=Promise.resolve().then(()=>operation(controller.signal)).catch(error=>{report.status=controller.signal.aborted?'cancelled':'failed';report.error=controller.signal.aborted?'检查已取消，已得到的结果保留。':error.message;report.partial=true;}).finally(()=>{if(networkBudget)Object.assign(report.budget,{requests:networkBudget.requests,cacheHits:networkBudget.cacheHits});report.totalUsage={rounds:previous.rounds+1,...Object.fromEntries(['requests','cacheHits','hashBytes','hashElapsedMs'].map(key=>[key,(previous[key]||0)+(report.budget[key]||0)]))};report.updatedAt=now();this.active.delete(report.id);try{this.persist();}catch{report.status='failed';report.error='无法保存补全记录，请检查工作台资料目录。';}});
    return job.promise;
  }
  async check(report,signal) {
    report.status='running';report.error=null;this.persist();const config=this.drawing.config();let info=null;
    if(this.drawing.currentConnection?.()) {
      try{info=await this.drawing.request(config.serviceUrl,'/object_info');if(!info||typeof info!=='object'||Array.isArray(info)||!Object.keys(info).length)info=null;}catch(error){report.warnings.push(`当前服务节点定义未核实：${error.message}`);}
    }
    signal.throwIfAborted();this.assertCurrent(report);
    const roots=await discoverModelRoots(config.comfyPath,report.explicitDirectories,signal);
    const indexed=await indexModelNames(roots.roots,{signal});report.modelRoots=roots.roots;report.warnings.push(...roots.warnings,...indexed.warnings);report.partial=indexed.partial;
    const budget={bytes:0,maxBytes:this.limits.hashBytes,maxMs:this.limits.hashMs,elapsedMs:0,active:0};
    for(const dependency of report.dependencies) {
      signal.throwIfAborted();
      if(dependency.kind==='node')dependency.service={status:info?Object.hasOwn(info,dependency.classType)?'exists':'missing':'unverified'};
      else {
        const enumerations=dependency.references.map(reference=>{const schema=info?.[reference.classType];return {...schema?.input?.required,...schema?.input?.optional}?.[reference.input]?.[0];}).filter(Array.isArray);
        dependency.service={status:info&&enumerations.length?enumerations.every(values=>values.some(value=>typeof value==='string'&&visibleName(value)===visibleName(dependency.filename)))?'exists':'missing':'unverified'};
        dependency.local=await inspectBudgetedModels(dependency,indexed.files,{cache:this.hashCache,budget,signal,usage:report.budget});
        if(dependency.local.status==='missing'&&(!isComfyDirectory(config.comfyPath||'')||roots.warnings.length||indexed.warnings.length||indexed.partial))dependency.local.status='unverified';
        if(dependency.local.partial)report.partial=true;
        this.localBudgetWarnings(report,dependency);
        dependency.destination=config.comfyPath?join(config.comfyPath,'models',dependency.category,basename(dependency.filename.replaceAll('\\','/'))):null;
      }
      dependency.status=dependency.service.status==='exists'?'exists':dependency.service.status==='missing'?'missing':dependency.local.status==='exists'?'candidate':'unverified';
    }
    report.budget.hashBytes=budget.bytes;report.budget.hashElapsedMs=budget.elapsedMs;report.serviceCheckedAt=info?now():null;report.serviceUrl=config.serviceUrl;
    report.status=report.partial?'partial':'completed';
    if(report.scope==='remote')report.warnings.push('当前连接为远程 ComfyUI；本机目录与下载不能证明远程服务依赖已补齐。');
    if(!info)report.warnings.push('当前服务未连接；模型在磁盘存在与服务已加载是两项独立检查。');
  }
  localBudgetWarnings(report,dependency) {
    for(const file of dependency.local.files)if(file.verification==='file-exceeds-budget'){
      const warning=`单文件 ${file.path} 超过本轮哈希新读上限；请通过独立下载流校验或手动指定文件处理，不会自动扩大预算。`;
      if(!report.warnings.includes(warning))report.warnings.push(warning);
    }
  }
  async search(id,value={}) {
    fields(value,['dependencyIds']);const report=this.record(id);this.assertCurrent(report);if(this.active.has(id))throw conflict('此报告仍在检查，请等待或取消。');
    if(value.dependencyIds!==undefined&&(!Array.isArray(value.dependencyIds)||value.dependencyIds.some(item=>typeof item!=='string')))throw new WorkbenchError(400,'请选择报告中的依赖。');
    const requested=value.dependencyIds?report.dependencies.filter(item=>value.dependencyIds.includes(item.id)):report.dependencies.filter(item=>item.service.status!=='exists'&&(!item.searched||item.local.continuable));
    const selected=requested.slice(0,this.limits.dependencies);const budget={requests:0,cacheHits:0,maxRequests:this.limits.requests,exhausted:false};
    await this.run(report,async signal=>{
      report.status='searching';report.error=null;this.persist();
      const roots=await discoverModelRoots(report.comfyPath,report.explicitDirectories,signal);
      const indexed=await indexModelNames(roots.roots,{signal});report.modelRoots=roots.roots;report.warnings.push(...roots.warnings,...indexed.warnings);
      const localBudget={bytes:0,maxBytes:this.limits.hashBytes,maxMs:this.limits.hashMs,elapsedMs:0,active:0};
      // 每次只检查两个依赖，来源客户端另有全局两个 HTTP 请求的信号量。
      for(let index=0;index<selected.length;index+=2)await Promise.all(selected.slice(index,index+2).map(async dependency=>{
        signal.throwIfAborted();const result=await this.sources[dependency.kind==='model'?'models':'nodes'](dependency,{signal,budget});
        dependency.candidates=result.candidates;dependency.issues=result.issues;dependency.searched=!result.issues.some(issue=>issue.status==='budget-exhausted');
        if(dependency.kind==='model') {
          dependency.local=await inspectBudgetedModels(dependency,indexed.files,{cache:this.hashCache,budget:localBudget,signal,usage:report.budget});
          if(dependency.local.status==='missing'&&(!isComfyDirectory(report.comfyPath||'')||roots.warnings.length||indexed.warnings.length||indexed.partial))dependency.local.status='unverified';
          if(dependency.local.partial||indexed.partial)report.partial=true;
          this.localBudgetWarnings(report,dependency);
        }
        for(const candidate of dependency.candidates)if(dependency.kind==='model') {
          const verifiedLocal=candidate.sha256&&dependency.local.files.find(file=>file.sha256===candidate.sha256&&file.verification==='sha256');
          candidate.reuse=verifiedLocal?clone(verifiedLocal):null;
          candidate.storage={downloadBytes:verifiedLocal?0:candidate.sizeBytes,incrementalBytes:verifiedLocal?0:candidate.sizeBytes,temporaryPeakBytes:verifiedLocal?0:candidate.sizeBytes==null?null:candidate.sizeBytes*2,destination:verifiedLocal?verifiedLocal.path:report.comfyPath?join(report.comfyPath,'models',dependency.category,candidate.filename):null,temporaryDirectory:this.manager.downloads.directory||null,estimate:'conservative-cross-volume',diskAvailableBytes:null};
        }
        for(const file of dependency.local.files)if(file.sha256&&result.candidates.some(candidate=>candidate.sha256===file.sha256)){file.verification='sha256';dependency.local.identity='verified';}
        if(dependency.candidates.length&&dependency.status!=='exists')dependency.status='candidate';this.persist();
      }));
      report.budget.requests=budget.requests;report.budget.cacheHits=budget.cacheHits;report.budget.uniqueDependencies=selected.length;
      report.partial=indexed.partial||report.dependencies.some(dependency=>dependency.local.partial)||requested.length>selected.length||budget.exhausted;
      report.canContinue=report.dependencies.some(dependency=>dependency.local.continuable||!dependency.searched&&dependency.service.status!=='exists');
      report.status=report.partial?'partial':'completed';
      if(requested.length>selected.length||budget.exhausted)report.warnings.push('本轮预算已用完，剩余依赖尚未校验，可点击“继续检查”。');
    },budget);return this.public(report);
  }
  async cancel(id){const report=this.record(id);const job=this.active.get(id);job?.controller.abort();if(job)await job.promise;return this.public(report);}
  async download(id,value) {
    fields(value,['requestId','selections']);identifier(value.requestId,'下载请求标识');const report=this.record(id);this.assertCurrent(report);
    if(report.scope!=='local')throw conflict('当前为远程或未核实的服务；请在目标机器准备依赖，不能通过本机下载宣称补齐。');
    if(!Array.isArray(value.selections)||!value.selections.length||value.selections.length>20)throw new WorkbenchError(400,'请勾选 1–20 项模型候选。');
    const root=await checkedLocalPath(this.drawing.config().comfyPath);if(!isComfyDirectory(root))throw conflict('请选择有效的本地 ComfyUI 本体目录。');
    const tasks=[],prepared=[];
    for(const selection of value.selections) {
      const dependency=report.dependencies.find(item=>item.id===selection.dependencyId&&item.kind==='model');const candidate=dependency?.candidates.find(item=>item.id===selection.candidateId);
      if(!candidate?.url&&!candidate?.reuse)throw new WorkbenchError(400,'所选候选没有可核实的文件下载地址。');
      if(!candidate.sha256&&!selection.acceptUnverifiedHash)throw conflict('此候选没有可信来源 SHA256，需明确接受未验证来源哈希后下载。');
      if(candidate.requiresAuth&&!candidate.reuse)throw conflict('此候选需要来源鉴权或许可；请通过高级直链方式准备有效地址。');
      const requestId=dependencyId([value.requestId,dependency.id,candidate.id]);
      prepared.push({dependency,candidate,requestId});
    }
    for(const {dependency,candidate,requestId} of prepared) {
      if(candidate.reuse) {
        const checked=await inspectLocalModels({...dependency,candidates:[candidate]},[candidate.reuse],{cache:this.hashCache,budget:{bytes:0,maxBytes:0,deadline:0}});
        const reusable=checked.files.find(file=>file.sha256===candidate.sha256&&file.verification==='sha256');
        if(!reusable){tasks.push({dependencyId:dependency.id,status:'not-started',error:'本地复用文件已变化，请重新检查后选择。'});continue;}
        tasks.push({id:requestId,dependencyId:dependency.id,status:'reused',target:reusable.path,reference:reusable.reference,actualSha256:reusable.sha256,verification:'sha256'});continue;
      }
      // 复用原下载服务的目标约束、并发上限、持久任务、续传、独立全文件 SHA256 和禁止覆盖逻辑。
      try{tasks.push(await this.manager.downloads.start({requestId,url:candidate.url,category:dependency.category,filename:fileName(candidate.filename),sha256:candidate.sha256||''},{queue:true}));}
      catch(error){tasks.push({dependencyId:dependency.id,status:'not-started',error:error.message});}
    }
    report.downloads=[...report.downloads,...tasks.filter(task=>task.id&&!report.downloads.some(item=>item.id===task.id))];this.persist();return {reportId:id,tasks};
  }
  async planNode(id,value) {
    fields(value,['dependencyId','candidateId']);const report=this.record(id);this.assertCurrent(report);
    const dependency=report.dependencies.find(item=>item.id===value.dependencyId&&item.kind==='node');const candidate=dependency?.candidates.find(item=>item.id===value.candidateId);
    if(!candidate?.repository||!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?\/?$/i.test(candidate.repository))throw new WorkbenchError(400,'Registry 没有可核实的 Git 仓库，请使用高级 Git 安装方式。');
    // 只预览，实际安装继续经过原有退出进程、快照和应用计划边界。
    return this.manager.plan({operation:'install-plugin',url:candidate.repository,name:String(candidate.registryId).replace(/[^A-Za-z0-9_.-]/g,'_')});
  }
  async copy(id,value) {
    fields(value,['replacements']);const report=this.record(id);
    if(!Array.isArray(value.replacements)||value.replacements.length>100)throw new WorkbenchError(400,'替换引用列表无效。');
    const document=replaceWorkflowReferences(report.document,report.dependencies,value.replacements);
    await mkdir(this.directory,{recursive:true});const path=await insideDirectory(this.directory,`${randomUUID()}.json`);await writeFile(path,JSON.stringify(document,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    return {document,path,name:report.name+'-补全副本',originalPreserved:true};
  }
  async close(){this.closed=true;for(const job of this.active.values())job.controller.abort();await Promise.allSettled([...this.active.values()].map(job=>job.promise));}
}
