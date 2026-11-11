// One durable attempt per resource family. Reading this cache never inspects files.
const pendingByStore=new WeakMap();
export class CachedDiscovery {
  constructor({store,key}) {
    this.store=store;this.key='resource.discovery.'+key;
    let pending=pendingByStore.get(store);if(!pending)pendingByStore.set(store,pending=new Map());
    this.pending=pending;
  }
  read({fingerprint}={}) {
    const saved=this.store.getSetting(this.key);
    const record=saved&&typeof saved==='object'?structuredClone(saved):{attempted:false,result:null,error:'',status:'idle',attemptedAt:null,scannedAt:null,fingerprint:''};
    // A previous process may have stopped in the middle of an attempt.
    if(record.status==='running'&&!this.pending.has(this.key)){
      record.status='interrupted';record.error='上次检索中断，点击重新检索可继续。';
    }
    record.stale=Boolean(fingerprint!==undefined&&record.attempted&&record.fingerprint!==fingerprint);
    return record;
  }
  run(operation,{refresh=false,fingerprint=''}={}) {
    if(this.pending.has(this.key))return this.pending.get(this.key);
    const previous=this.read({fingerprint});
    if(previous.attempted&&!refresh)return Promise.resolve(previous);
    const record={...previous,attempted:true,status:'running',error:'',attemptedAt:new Date().toISOString(),fingerprint,stale:false};
    this.store.setSetting(this.key,record);
    const promise=Promise.resolve().then(operation).then(result=>{
      Object.assign(record,{result,status:result?.partial?'partial':'completed',scannedAt:new Date().toISOString()});
    },error=>{
      Object.assign(record,{status:error?.name==='AbortError'?'cancelled':'failed',error:String(error?.message||'检索未完成。').slice(0,2000)});
    }).then(()=>{
      this.store.setSetting(this.key,record);return structuredClone(record);
    }).finally(()=>{if(this.pending.get(this.key)===promise)this.pending.delete(this.key);});
    this.pending.set(this.key,promise);return promise;
  }
}
