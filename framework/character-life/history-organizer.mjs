import {createHash} from 'node:crypto';
import {memoryScope,layeredMemorySchema,layeredMemoryGuidance} from './memory-layers.mjs';
import {validExtractionEnvelope} from './extraction-envelope.mjs';

const coveredId=source=>createHash('sha256').update(source.scope+'\0'+source.sourceId+(source.partOffset===undefined?'':'\0part:'+source.partOffset)).digest('hex');
const parse=value=>{try{return JSON.parse(String(typeof value==='string'?value:value?.text??'').replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));}catch{return null;}};

// 只接收宿主注册的只读历史提供者，不接收 HTTP 请求里的消息、路径或文件。
export class MemoryHistoryOrganizer {
  constructor(life){this.life=life;this.providers=new Map();this.queue=new Map();this.waiting=new Map();this.inflight=new Set();this.active=null;this.timer=null;this.waiters=[];}
  register(moduleId,provider){this.providers.set(moduleId,provider);return ()=>{this.cancel({moduleId});if(this.providers.get(moduleId)===provider)this.providers.delete(moduleId);};}
  enabled(id){const settings=this.life.config(id);return !this.life.closed&&this.life.capabilities().lite&&settings.enabled&&settings.memory.enabled&&settings.memory.autoExtract;}
  covered(id,source){return !!(this.life.data.get(id,'memory-covered',coveredId(source))||source.partOffset!==undefined&&this.life.data.get(id,'memory-covered',coveredId({...source,partOffset:undefined})));}
  cover(id,sources){for(const source of sources)this.life.data.put(id,'memory-covered',{id:coveredId(source),scope:source.scope,sourceId:source.sourceId});}
  observing(id,source){return this.inflight.has(id+'\0'+coveredId({...source,partOffset:undefined}));}
  begin(id,source){this.inflight.add(id+'\0'+coveredId(source));}
  end(id,source){
    this.inflight.delete(id+'\0'+coveredId(source));
    for(const [key,job] of this.waiting)if(job.id===id&&!this.observing(id,job.waitSource)){
      this.waiting.delete(key);if(!this.life.closed)this.queue.set(key,job);
    }
    this.schedule();this.resolveIdle();
  }
  organize(id,route={}){
    if(!this.enabled(id))return {queued:0};
    const modules=route.moduleId?[route.moduleId]:[...this.providers.keys()];let queued=0;
    for(const moduleId of modules){
      const provider=this.providers.get(moduleId);if(!provider)continue;
      for(const session of provider.sessions(id,route)??[]){
        const args={moduleId,...session.args},scope=memoryScope(args),key=id+'\0'+scope;
        if(session.valid&&!session.valid()||this.queue.has(key)||this.waiting.has(key)||this.active?.key===key&&!this.active.controller.signal.aborted)continue;
        const previous=this.life.data.get(id,'memory-job',scope);
        if(previous?.status==='failed'&&!route.retry&&Date.parse(previous.nextRetryAt)>this.life.clock())continue;
        const sources=session.read(),cursor=previous?.cursor??0;
        if(!sources.some(s=>s.sequence>cursor))continue;
        this.life.data.put(id,'memory-job',{...previous,id:scope,scope,moduleId,status:'queued',cursor,processed:previous?.processed??0,total:sources.length,error:''});
        this.queue.set(key,{id,key,args,scope,session});queued++;
      }
    }
    this.schedule();return {queued};
  }
  schedule(){if(this.timer||this.active||!this.queue.size||this.life.closed)return;this.timer=setTimeout(()=>{this.timer=null;this.runNext();},0);}
  update(job,patch){const previous=this.life.data.get(job.id,'memory-job',job.scope);return this.life.data.put(job.id,'memory-job',{...previous,id:job.scope,scope:job.scope,...patch});}
  current(job){return this.enabled(job.id)&&!job.controller.signal.aborted&&this.life.configRevision(job.id)===job.revision&&(!job.session.valid||job.session.valid());}
  runNext(){
    if(this.active||this.life.closed)return;
    const entry=this.queue.entries().next().value;if(!entry){this.resolveIdle();return;}
    const [key,job]=entry;this.queue.delete(key);this.active=job;job.controller=new AbortController();job.revision=this.life.configRevision(job.id);
    const task=this.run(job);job.task=task;this.life.pending.add(task);
    task.finally(()=>{this.life.pending.delete(task);if(this.active===job)this.active=null;this.schedule();this.resolveIdle();});
  }
  async run(job){
    try{
      if(!this.current(job)){this.update(job,{status:'paused'});return;}
      const record=this.life.data.get(job.id,'memory-job',job.scope),available=job.session.read().filter(s=>s.sequence>(record?.cursor??0));
      const inflightIndex=available.findIndex(source=>this.observing(job.id,source)),sources=inflightIndex<0?available:available.slice(0,inflightIndex);
      if(!sources.length&&inflightIndex===0){this.update(job,{status:'queued'});job.waitSource=available[0];this.waiting.set(job.key,job);return;}
      let chars=0;const batch=[];
      for(const source of sources){
        if(batch.length&&source.input.length>12000)break;
        const offset=batch.length?0:record?.sourceOffset??0,input=String(source.input).slice(offset,offset+12000),reply=String(source.reply).slice(0,6000),size=input.length+reply.length;
        // 长用户消息按片段续接，原始 sourceId 不变，片段成功后才推进偏移。
        if(batch.length&&(batch.length>=12||chars+size>18000))break;
        batch.push({...source,input,reply,scope:job.scope,...(source.input.length>12000?{partOffset:offset,partEnd:offset+input.length,fullLength:source.input.length}:{})});chars+=size;
        if(source.input.length>12000)break;
      }
      if(!batch.length){this.update(job,{status:'idle'});return;}
      this.update(job,{status:'running',error:''});
      const uncovered=batch.filter(s=>!this.covered(job.id,s));
      if(uncovered.length){
        const snapshot=this.life.memoryLayers.snapshot(job.id,job.args),payload=this.life.memoryLayers.payload(job.id,job.args,uncovered);
        const response=await this.life.ai.complete([{role:'system',content:`整理宿主提供的已确认历史批次。只返回 JSON：{${layeredMemorySchema}}。${layeredMemoryGuidance}摘要只属于当前会话；保留 priorSummary 中尚相关的内容，不补写未发生的事。不要输出角色状态、变量或日记。`},{role:'user',content:JSON.stringify(payload)}],{moduleId:job.args.moduleId??'companion',signal:job.controller.signal,policy:'chat-only'});
        if(!this.current(job)){this.update(job,{status:'paused'});return;}
        const extracted=parse(response);if(!validExtractionEnvelope(extracted))throw new Error('历史整理未返回有效的记忆或摘要字段，成功水位未推进。');
        this.life.data.transaction(()=>{this.life.memoryLayers.apply(job.id,job.args,extracted,uncovered,snapshot);this.cover(job.id,uncovered);});
      }
      if(!this.current(job)){this.update(job,{status:'paused'});return;}
      const last=batch.at(-1),partial=last.partEnd<last.fullLength,cursor=partial?(record?.cursor??0):last.sequence,remaining=partial||job.session.read().some(s=>s.sequence>cursor);
      this.update(job,{status:remaining?'queued':'idle',cursor,sourceOffset:partial?last.partEnd:0,processed:(record?.processed??0)+batch.length-(partial?1:0),error:'',nextRetryAt:null});
      if(remaining)this.queue.set(job.key,job);
    }catch(error){
      if(!this.life.closed)this.update(job,this.current(job)?{status:'failed',error:String(error.message??error).slice(0,500),nextRetryAt:new Date(this.life.clock()+300000).toISOString()}:{status:'paused',error:''});
    }
  }
  cancel({id,moduleId}={}){
    const matches=job=>(!id||job.id===id)&&(!moduleId||job.args.moduleId===moduleId);
    for(const [key,job] of this.queue)if(matches(job)){this.queue.delete(key);this.update(job,{status:'paused'});}
    for(const [key,job] of this.waiting)if(matches(job)){this.waiting.delete(key);this.update(job,{status:'paused'});}
    if(this.active&&matches(this.active)){this.active.controller.abort();this.update(this.active,{status:'paused'});}
    if(!this.queue.size&&this.timer){clearTimeout(this.timer);this.timer=null;}
    this.resolveIdle();
  }
  idle(){if(!this.active&&!this.queue.size&&!this.waiting.size&&!this.timer)return Promise.resolve();return new Promise(resolve=>this.waiters.push(resolve));}
  resolveIdle(){if(this.active||this.queue.size||this.waiting.size||this.timer)return;for(const resolve of this.waiters.splice(0))resolve();}
}
