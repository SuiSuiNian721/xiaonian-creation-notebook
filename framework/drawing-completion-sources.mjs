import { dependencyId } from './drawing-dependencies.mjs';
import { WorkbenchError } from './contracts.mjs';

const DAY=24*60*60*1000;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;
const plainUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const name=value=>value.replaceAll('\\','/').split('/').at(-1);
const modelFile=value=>/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i.test(value);
const cleanQuery=value=>name(value).replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx)$/i,'').slice(0,160);
const candidate=value=>({id:dependencyId([value.platform,value.version,value.filename,value.url]),...value,verification:value.sha256?'source-sha256':'untrusted-hash',match:'candidate',license:value.license||'unverified'});

export class DrawingCompletionSources {
  constructor({store,fetchImpl=fetch}){this.store=store;this.fetch=fetchImpl;this.cache=store.getSetting('drawing.completion.http-cache')||{};this.inflight=new Map();this.active=0;this.waiters=[];}
  async slot(signal){
    signal?.throwIfAborted();
    if(this.active<2){this.active++;return;}
    await new Promise((resolve,reject)=>{const waiter={resolve:()=>{signal?.removeEventListener('abort',abort);resolve();},reject};const abort=()=>{this.waiters=this.waiters.filter(item=>item!==waiter);reject(signal.reason||new Error('已取消'));};this.waiters.push(waiter);signal?.addEventListener('abort',abort,{once:true});});
    // 被唤醒时已持有上一请求交出的令牌，不再增加 active。
    try{signal?.throwIfAborted();}catch(error){this.releaseSlot();throw error;}
  }
  releaseSlot(){const next=this.waiters.shift();if(next)next.resolve();else this.active--;}
  async get(url,{signal,budget,fixed=false}={}) {
    signal?.throwIfAborted();const existing=this.cache[url];
    if(existing&&Date.now()-existing.at<(fixed?7*DAY:DAY)){budget.cacheHits++;return structuredClone(existing.value);}
    const scope=signal||null;let group=this.inflight.get(url);
    if(group?.has(scope))return group.get(scope);
    if(budget.requests>=budget.maxRequests){budget.exhausted=true;throw new WorkbenchError(429,'已达到本轮 40 次请求预算，可手动继续。');}
    budget.requests++;
    const pending=(async()=>{
      await this.slot(signal);
      try {
        signal?.throwIfAborted();
        const response=await this.fetch(url,{signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]),headers:{accept:'application/json'}});
        if(!response.ok)throw new WorkbenchError(response.status===401||response.status===403?response.status:502,response.status===401||response.status===403?`来源需要鉴权或许可（HTTP ${response.status}）。`:`来源 API 返回 HTTP ${response.status}。`);
        const chunks=[];let length=0;
        for await(const chunk of response.body||[]){length+=chunk.byteLength;if(length>8*1024*1024)throw new WorkbenchError(413,'来源元数据超过 8 MiB，已停止读取。');chunks.push(chunk);}
        const value=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
        this.cache[url]={at:Date.now(),value};const keys=Object.keys(this.cache);for(const key of keys.slice(0,Math.max(0,keys.length-500)))delete this.cache[key];this.store.setSetting('drawing.completion.http-cache',this.cache);return value;
      } finally {this.releaseSlot();}
    })().finally(()=>{group.delete(scope);if(!group.size)this.inflight.delete(url);});
    // 报告间共享已完成缓存；运行中的请求只在同一取消域内去重。
    if(!group){group=new Map();this.inflight.set(url,group);}group.set(scope,pending);return pending;
  }
  async models(dependency,options) {
    const candidates=[],issues=[];const query=cleanQuery(dependency.filename);
    const requested=name(dependency.filename).toLowerCase();
    const exactFile=value=>typeof value==='string'&&name(value).toLowerCase()===requested;
    const exact=item=>exactFile(item.filename);
    // 同一来源保留 API 的相关性顺序，跨来源使用固定次序，避免网络完成先后影响展示。
    const order=(a,b)=>Number(exact(b))-Number(exact(a))||a.platform.localeCompare(b.platform,'en');
    const civitai=async()=>{
      const types={checkpoints:'Checkpoint',loras:'LORA',vae:'VAE',controlnet:'Controlnet'};
      const url=new URL('https://civitai.com/api/v1/models');url.searchParams.set('limit','5');url.searchParams.set('query',query);if(types[dependency.category])url.searchParams.set('types',types[dependency.category]);
      const data=await this.get(url.href,options),found=[];
      for(const model of data.items||[])for(const version of model.modelVersions||[])for(const file of version.files||[]){
        const downloadUrl=plainUrl(file.downloadUrl);if(!downloadUrl||typeof file.name!=='string'||!modelFile(file.name))continue;
        found.push(candidate({platform:'civitai',title:model.name||file.name,filename:name(file.name),version:String(version.id),versionName:version.name||'',source:`https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,url:downloadUrl,sizeBytes:Number.isFinite(file.sizeKB)?Math.ceil(file.sizeKB*1024):null,sha256:sha(file.hashes?.SHA256),evidence:{modelId:model.id,versionId:version.id,hashSource:'files.hashes.SHA256'},license:model.allowCommercialUse?'review-source':'unverified',requiresAuth:Boolean(model.mode==='Archived')}));
      }
      candidates.push(...found.sort(order).slice(0,5));
    };
    const huggingface=async()=>{
      const url=new URL('https://huggingface.co/api/models');url.searchParams.set('search',query);url.searchParams.set('limit','5');
      const repos=await this.get(url.href,options);let count=0;
      for(const repo of (Array.isArray(repos)?repos:[]).slice(0,5)){
        options.signal?.throwIfAborted();const id=repo.id||repo.modelId;if(typeof id!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(id))continue;
        const data=await this.get(`https://huggingface.co/api/models/${id}?blobs=true`,options);const revision=data.sha;
        for(const file of [...(data.siblings||[])].sort((a,b)=>Number(exactFile(b.rfilename))-Number(exactFile(a.rfilename)))){
          if(typeof file.rfilename!=='string'||!modelFile(file.rfilename)||!name(file.rfilename).toLowerCase().includes(query.toLowerCase()))continue;
          const immutable=typeof revision==='string'&&/^[a-f0-9]{40,64}$/i.test(revision);
          candidates.push(candidate({platform:'huggingface',title:id,filename:name(file.rfilename),version:revision||null,source:`https://huggingface.co/${id}/blob/${immutable?revision:'main'}/${file.rfilename.split('/').map(encodeURIComponent).join('/')}`,url:immutable?`https://huggingface.co/${id}/resolve/${revision}/${file.rfilename.split('/').map(encodeURIComponent).join('/')}`:null,sizeBytes:Number.isFinite(file.size)?file.size:Number.isFinite(file.lfs?.size)?file.lfs.size:null,sha256:sha(file.lfs?.sha256),evidence:{repository:id,revision:revision||null,path:file.rfilename,blobId:file.blobId||null,hashSource:file.lfs?.sha256?'siblings.lfs.sha256':null},license:data.cardData?.license||'unverified',requiresAuth:Boolean(data.gated)}));
          if(++count>=5)return;
        }
      }
    };
    await Promise.all([['civitai',civitai],['huggingface',huggingface]].map(async([platform,run])=>{try{await run();}catch(error){if(options.signal?.aborted)throw error;issues.push({platform,status:[401,403].includes(error.status)?'authentication-required':error.status===429?'budget-exhausted':'unverified',detail:error.message});}}));
    return {candidates:candidates.sort(order),issues};
  }
  async nodes(dependency,options) {
    try {
      const data=await this.get(`https://api.comfy.org/comfy-nodes/${encodeURIComponent(dependency.classType)}/node`,options);
      const node=data.node||data;const id=node.id||node.name;const repository=plainUrl(node.repository||node.repository_url||node.source_code_repo);
      const version=node.latest_version?.version||node.latest_version||null;
      return {candidates:id?[candidate({platform:'comfy-registry',title:node.name||id,filename:null,version:typeof version==='string'?version:null,registryId:id,source:`https://registry.comfy.org/nodes/${encodeURIComponent(id)}`,url:null,repository,sha256:null,sizeBytes:null,evidence:{classType:dependency.classType,registryId:id,repository},license:node.license||'unverified'})]:[],issues:id?[]:[{platform:'comfy-registry',status:'unverified',detail:'Registry 未返回可识别节点来源。'}]};
    }catch(error){if(options.signal?.aborted)throw error;return {candidates:[],issues:[{platform:'comfy-registry',status:[401,403].includes(error.status)?'authentication-required':error.status===429?'budget-exhausted':'unverified',detail:error.message}]};}
  }
  async nodeVersion(candidate,options){
    if(!candidate.registryId||!candidate.version)throw new WorkbenchError(400,'节点没有固定 Registry 版本，请使用高级 Git 方式并核对来源。');
    return this.get(`https://api.comfy.org/nodes/${encodeURIComponent(candidate.registryId)}/install?version=${encodeURIComponent(candidate.version)}`,{...options,fixed:true});
  }
}
