import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,openSync,closeSync,writeFileSync,readFileSync,unlinkSync} from 'node:fs';
import {request} from 'node:http';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkbenchStore} from './store.mjs';
import {migrateLegacy} from './instance-migration.mjs';
import {InstanceCoordination} from './instance-coordination.mjs';
import {parseCharacterFile} from './character-runtime/index.mjs';
import {WorkbenchError,fields,knownModule,importedCharacter,text} from './contracts.mjs';
import {QQRuntime} from './qq-runtime.mjs';
import {moduleDefinitions,moduleDefinition} from './registry.mjs';

const now=()=>new Date().toISOString();
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const conflict=message=>new WorkbenchError(409,message);
const blockedCopyKey=/^(?:api[-_]?key|localVisionKey|(?:access|refresh|external|onebot|web)?[-_]?token|password|secrets?|credentials?|authorization|headers|balance|currentState|runtimeState|currentVariables|stat_data|messages|memories|history|logs)$/i;
const contentKeys=new Set(['raw','document','description','content','text','messages','prompt','workflow']);
const portableKinds=['settings','profile','tool'];
const environmentPath=value=>{if(!value)return '';const path=resolve(value);return process.platform==='win32'?path.toLowerCase():path;};
const environmentService=value=>{try{const url=new URL(value);if(['localhost','127.0.0.1','[::1]'].includes(url.hostname))url.hostname='localhost';return url.href.replace(/\/$/,'');}catch{return String(value||'');}};
const sameDrawingEnvironment=(a,b)=>environmentPath(a.comfyPath)===environmentPath(b.comfyPath)&&environmentService(a.serviceUrl)===environmentService(b.serviceUrl);
function alignVariant(store,record,sourceId){
  const definition=moduleDefinition(record.moduleId);
  if(definition?.familyId){
    for(const item of moduleDefinitions.filter(item=>item.familyId===definition.familyId))store.setEnabled(item.id,item.id===record.moduleId);
    if(sourceId&&sourceId!==record.moduleId){
      const connection=store.getSetting('ai.module.'+sourceId);
      if(connection)store.setSetting('ai.module.'+record.moduleId,connection);
      else if(store.getSetting('ai.module.'+record.moduleId))store.setSetting('ai.module.'+record.moduleId,{mode:'global'});
      if(definition.familyId==='character-full')store.setSetting('instance.pendingRoleMode',definition.variant);
    }
  }
  store.setSetting('instance.identity',{...store.getSetting('instance.identity'),id:record.id,moduleId:record.moduleId});
}
export function scopeInstanceLinks(value,prefix,key=''){
  if(contentKeys.has(key))return value;
  if(typeof value==='string')return /^\/(?:api|internal|card-studio)(?:\/|$)/.test(value)?prefix+value:value;
  if(Array.isArray(value))return value.map(item=>scopeInstanceLinks(item,prefix));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,scopeInstanceLinks(item,prefix,name)]));
  return value;
}
export function cleanPersona(value) {
  if(Array.isArray(value))return value.map(cleanPersona);
  if(typeof value==='string'&&/^https?:\/\//.test(value)){try{const url=new URL(value);let changed=!!url.username||!!url.password;url.username='';url.password='';for(const key of [...url.searchParams.keys()])if(blockedCopyKey.test(key)){url.searchParams.delete(key);changed=true;}if(changed)return url.href;}catch{}}
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!blockedCopyKey.test(key)).map(([key,item])=>[key,cleanPersona(item)]));
}

/** Each runtime owns its stores, pending work, processes and secrets. The registry never changes request scope. */
export class ModuleInstances {
  constructor({dataDir,store,createRuntime,optionsFactory,baseUrl,beforeRemove,beforeVariantChange}) {
    this.dataDir=dataDir;this.store=store;this.createRuntime=createRuntime;this.optionsFactory=optionsFactory;this.baseUrl=baseUrl;this.beforeRemove=beforeRemove;this.beforeVariantChange=beforeVariantChange;
    this.runtimes=new Map();this.operations=new Map();this.resourceLocks=new Map();this.closed=false;
    this.coordination=new InstanceCoordination(this.runtimes);
    mkdirSync(join(dataDir,'instances'),{recursive:true});
    this.db=new DatabaseSync(join(dataDir,'instances.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,module_id TEXT NOT NULL,name TEXT NOT NULL,tab_open INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  record(id,includeDeleted=false) {
    if(!uuid.test(id))throw new WorkbenchError(400,'实例标识无效。');
    const row=this.db.prepare('SELECT * FROM instances WHERE id=?').get(id);
    if(!row||row.deleted_at&&!includeDeleted)throw new WorkbenchError(404,'找不到这个模块实例。');
    let personaId=this.runtimes.get(id)?.context.store.getSetting('selectedCharacterId');
    if(personaId===undefined&&existsSync(join(this.directory(id),'workbench.sqlite'))){const db=new DatabaseSync(join(this.directory(id),'workbench.sqlite'),{readOnly:true});try{personaId=JSON.parse(db.prepare("SELECT value FROM settings WHERE name='selectedCharacterId'").get()?.value??'null');}finally{db.close();}}
    return {id:row.id,moduleId:row.module_id,name:row.name,tabOpen:!!row.tab_open,createdAt:row.created_at,updatedAt:row.updated_at,
      status:this.runtimes.has(id)?'running':'stopped',personaId:personaId??null,deletedAt:row.deleted_at};
  }
  list(){return this.db.prepare('SELECT id FROM instances WHERE deleted_at IS NULL ORDER BY created_at,rowid').all().map(row=>this.record(row.id));}
  acquireLock(){
    const file=join(this.dataDir,'instances.lock');
    for(let attempt=0;attempt<2;attempt++){
      let descriptor;
      try{descriptor=openSync(file,'wx',0o600);this.lock={file,token:randomUUID()};writeFileSync(descriptor,JSON.stringify({pid:process.pid,token:this.lock.token}),{encoding:'utf8'});return;}
      catch(error){if(error.code!=='EEXIST')throw error;let saved;try{saved=JSON.parse(readFileSync(file,'utf8'));if(!Number.isInteger(saved.pid)||saved.pid<1)throw conflict('实例资料锁无效，请检查后重试。');process.kill(saved.pid,0);}catch(check){if(check.code==='ESRCH'){unlinkSync(file);continue;}if(check instanceof WorkbenchError)throw check;}throw conflict('这个资料目录已由另一个工作台使用，不能同时迁移或写入。');}
      finally{if(descriptor!==undefined)closeSync(descriptor);}
    }
    throw conflict('无法取得实例资料锁。');
  }
  releaseLock(){if(!this.lock)return;try{if(JSON.parse(readFileSync(this.lock.file,'utf8')).token===this.lock.token)unlinkSync(this.lock.file);}finally{this.lock=null;}}
  migrate(options){return migrateLegacy(this,{...options,sanitize:cleanPersona});}
  collectCharacterLibrary(){
    if(!this.libraryLife)throw conflict('角色资料暂时不可用。');
    const imported=[];
    for(const record of this.list().filter(item=>moduleDefinition(item.moduleId)?.librarySection==='characters')){
      const context=this.readContext(record.id);
      try{
        for(const source of context.store.state().characters){
          const key='character-library:'+record.id+':'+source.id;
          const previous=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
          if(previous&&JSON.parse(previous.value).complete)continue;
          const characterId=previous?JSON.parse(previous.value).characterId:randomUUID();
          this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({characterId,complete:false}));
          if(!this.store.character(characterId)){
            const character={...source,id:characterId,assets:source.assets.map(asset=>({...asset,id:randomUUID(),characterId}))};
            character.raw={...character.raw,workbenchProvenance:{sourceInstanceId:record.id,sourceCharacterId:source.id,collectedAt:now()}};
            this.store.saveCharacter(character,true);
          }
          const lifeFile=join(this.directory(record.id),'character-life','life.sqlite');
          if(existsSync(lifeFile)){
            const db=new DatabaseSync(lifeFile,{readOnly:true});
            try{
              const rows=db.prepare('SELECT kind,data FROM records WHERE character_id=?').all(source.id);
              this.libraryLife.data.transaction(()=>{for(const row of rows)this.libraryLife.data.put(characterId,row.kind,JSON.parse(row.data));});
            }finally{db.close();}
          }
          this.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({characterId,complete:true}),key);
          imported.push({instanceId:record.id,characterId,name:source.name});
        }
      }finally{context.release();}
    }
    this.store.setSetting('character.library.initialized',true);
    return {imported,originalsPreserved:true};
  }
  directory(id){if(!uuid.test(id))throw new WorkbenchError(400,'实例标识无效。');return join(this.dataDir,'instances',id);}
  serial(id,action){
    const pending=(this.operations.get(id)||Promise.resolve()).catch(()=>{}).then(()=>{if(this.closed)throw conflict('工作台正在关闭。');return action();});
    this.operations.set(id,pending);pending.finally(()=>{if(this.operations.get(id)===pending)this.operations.delete(id);}).catch(()=>{});return pending;
  }
  async create(value,{start=true,drawingConfiguration}={}) {
    fields(value,['moduleId','name']);const definition=knownModule(value.moduleId);
    const id=randomUUID(),at=now(),name=value.name===undefined?definition.name:text(value.name,'实例名称',120);
    const local=new WorkbenchStore(this.directory(id));
    try {
      local.setEnabled(definition.id,true);local.setSetting('instance.identity',{id,moduleId:definition.id});
      if(drawingConfiguration)local.saveDrawingConfiguration(drawingConfiguration.config,drawingConfiguration.runtime);
    }finally{local.close();}
    this.db.prepare('INSERT INTO instances VALUES(?,?,?,?,?,?,NULL)').run(id,definition.id,name,1,at,at);
    if(start)await this.start(id);
    return this.record(id);
  }
  related(id,value){
    fields(value,['moduleId']);
    const source=this.record(id);
    if(!['drawing','comfyui'].includes(source.moduleId)||value.moduleId!==(source.moduleId==='drawing'?'comfyui':'drawing'))throw new WorkbenchError(400,'只支持角色绘图与 ComfyUI 启动器的同环境关联。');
    return this.serial(id,()=>this.serial('drawing-environment-links',async()=>{
      this.record(id);
      const context=this.readContext(id);let configuration;
      try{configuration={config:context.store.module('drawing').config,runtime:context.store.getSetting('drawing.runtime')||{}};}finally{context.release();}
      const key=(sourceId,moduleId)=>'environment.related.'+sourceId+'.'+moduleId;
      const saved=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key(id,value.moduleId));
      const preferred=saved?JSON.parse(saved.value):null;
      const candidates=this.list().filter(item=>item.moduleId===value.moduleId).sort((a,b)=>Number(b.id===preferred)-Number(a.id===preferred));
      let instance;
      for(const candidate of candidates){
        const target=this.readContext(candidate.id);
        try{if(sameDrawingEnvironment(configuration.config,target.store.module('drawing').config)){instance=candidate;break;}}finally{target.release();}
      }
      const created=!instance;
      if(!instance)instance=await this.create({moduleId:value.moduleId},{start:false,drawingConfiguration:configuration});
      const save=this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      save.run(key(id,value.moduleId),JSON.stringify(instance.id));save.run(key(instance.id,source.moduleId),JSON.stringify(id));
      return {instance,created};
    }));
  }
  update(id,value){fields(value,['name','tabOpen']);this.record(id);if(value.tabOpen!==undefined&&typeof value.tabOpen!=='boolean')throw new WorkbenchError(400,'标签状态必须是布尔值。');
    const current=this.record(id);this.db.prepare('UPDATE instances SET name=?,tab_open=?,updated_at=? WHERE id=?').run(value.name===undefined?current.name:text(value.name,'实例名称',120),Number(value.tabOpen??current.tabOpen),now(),id);return this.record(id);}
  variant(id,value){
    fields(value,['variant']);
    if(!['lite','full'].includes(value.variant))throw new WorkbenchError(400,'请选择精简版或完整版。');
    return this.serial(id,async()=>{
      const current=this.record(id),definition=moduleDefinition(current.moduleId);
      const target=definition?.familyId&&moduleDefinitions.find(item=>item.familyId===definition.familyId&&item.variant===value.variant);
      if(!target)throw new WorkbenchError(400,'这个模块不提供精简和完整模式。');
      if(target.id===current.moduleId)return current;
      await this.beforeVariantChange?.({record:current,runtime:this.runtimes.get(id)});
      await this.stopRuntime(id);
      const local=new WorkbenchStore(this.directory(id));let published=false;
      try{
        local.db.exec('BEGIN IMMEDIATE');
        alignVariant(local,{...current,moduleId:target.id},current.moduleId);
        this.db.prepare('UPDATE instances SET module_id=?,updated_at=? WHERE id=?').run(target.id,now(),id);published=true;
        local.db.exec('COMMIT');
      }catch(error){
        try{local.db.exec('ROLLBACK');}catch{}
        if(published)this.db.prepare('UPDATE instances SET module_id=?,updated_at=? WHERE id=?').run(current.moduleId,current.updatedAt,id);
        throw error;
      }finally{local.close();}
      return this.record(id);
    });
  }
  start(id){return this.serial(id,async()=>{const record=this.record(id);if(this.runtimes.has(id))return this.record(id);
    const local=new WorkbenchStore(this.directory(id));
    try{
      const identity=local.getSetting('instance.identity');
      // The registry is authoritative if an interrupted mode change left local metadata behind.
      if(identity?.moduleId!==record.moduleId){local.db.exec('BEGIN IMMEDIATE');try{alignVariant(local,record,identity?.moduleId);local.db.exec('COMMIT');}catch(error){local.db.exec('ROLLBACK');throw error;}}
    }finally{local.close();}
    const options=await this.optionsFactory?.({instanceId:id,moduleId:record.moduleId,dataDir:this.directory(id)})||{};
    const runtime=await this.createRuntime({id,record,dataDir:this.directory(id),options,publicBaseUrl:this.baseUrl()+'/instances/'+id,coordination:this.coordination.forInstance(id)});
    try{
      const pendingMode=runtime.context.store.getSetting('instance.pendingRoleMode'),characterId=runtime.context.store.getSetting('selectedCharacterId');
      if(pendingMode&&characterId){runtime.context.life.configure(characterId,{mode:pendingMode});runtime.context.store.setSetting('instance.pendingRoleMode',null);}
    }catch(error){await runtime.close();throw error;}
    this.runtimes.set(id,runtime);return this.record(id);
  });}
  async stopRuntime(id,{stopQQ=false}={}){const runtime=this.runtimes.get(id);if(runtime){await runtime.close({stopQQ});this.runtimes.delete(id);this.coordination.releaseQQ(id);}else if(stopQQ&&this.record(id).moduleId==='qq'){
    const qq=new QQRuntime({dataDir:this.directory(id)});try{await qq.stop();}finally{await qq.close();}
  } }
  stop(id){return this.serial(id,async()=>{this.record(id);await this.stopRuntime(id,{stopQQ:true});return this.record(id);});}
  remove(id){return this.serial(id,async()=>{const record=this.record(id),release=await this.beforeRemove?.({record,runtime:this.runtimes.get(id)});try{await this.stopRuntime(id,{stopQQ:true});this.db.prepare('UPDATE instances SET deleted_at=?,updated_at=? WHERE id=?').run(now(),now(),id);return {archived:true,id};}finally{await release?.();}});}
  context(id){this.record(id);const runtime=this.runtimes.get(id);if(!runtime)throw conflict('这个实例已停止，请先启动。');return runtime.context;}
  readContext(id){this.record(id);if(this.runtimes.has(id))return {...this.context(id),release(){}};
    const store=Object.create(WorkbenchStore.prototype);store.db=new DatabaseSync(join(this.directory(id),'workbench.sqlite'),{readOnly:true});
    const lifeFile=join(this.directory(id),'character-life','life.sqlite'),db=existsSync(lifeFile)?new DatabaseSync(lifeFile,{readOnly:true}):null;
    return {store,life:{data:{list:(characterId,kind)=>db?db.prepare('SELECT data FROM records WHERE character_id=? AND kind=?').all(characterId,kind).map(row=>JSON.parse(row.data)):[]}},release(){db?.close();store.close();}};
  }
  async persona(id,value){
    fields(value,['source','characterId','sourceInstanceId','bundle','name','base64']);
    return this.serial(id,async()=>{
      this.record(id);const target=this.context(id);let source,life,sourceContext,records=[];
      if(value.source==='library'){source=this.store.requireCharacter(value.characterId);life=this.libraryLife;}
      else if(value.source==='instance'){sourceContext=this.readContext(value.sourceInstanceId);try{source=sourceContext.store.requireCharacter(value.characterId??sourceContext.store.getSetting('selectedCharacterId'));for(const kind of portableKinds)for(const item of sourceContext.life.data.list(source.id,kind))records.push({kind,item});}finally{sourceContext.release();}}
      else if(value.source==='import')source=importedCharacter({document:value.bundle});
      else if(value.source==='file')source=importedCharacter({document:await parseCharacterFile({name:value.name,base64:value.base64})});
      else throw new WorkbenchError(400,'请选择资料库、其他实例或导入文件。');
      const freshId=randomUUID(),character=cleanPersona({...source,id:freshId,assets:(source.assets||[]).map(asset=>({...asset,id:randomUUID(),characterId:freshId}))});
      character.raw={...character.raw,workbenchProvenance:{sourceCharacterId:source.id,sourceInstanceId:value.source==='instance'?value.sourceInstanceId:null,copiedAt:now(),previous:source.raw?.workbenchProvenance??null}};
      target.store.saveCharacter(character,true);
      // Only declarative settings/profile are portable. Runtime records are deliberately absent.
      if(life)for(const kind of portableKinds)for(const item of life.data.list(source.id,kind))records.push({kind,item});
      for(const {kind,item} of records)target.life.data.put(freshId,kind,cleanPersona(item));
      target.store.selectCharacter(freshId);await target.companion.syncCharacter();
      if(this.record(id).moduleId==='qq')await target.ensureQQ().bind({characterId:freshId,acceptLimited:true});
      return {character:target.store.requireCharacter(freshId),instance:this.record(id)};
    });
  }
  exportPersona(id,value){fields(value,['characterId']);const context=this.readContext(id);try{const source=context.store.requireCharacter(value.characterId??context.store.getSetting('selectedCharacterId'));
    const freshId=randomUUID(),character=cleanPersona({...source,id:freshId,assets:(source.assets||[]).map(asset=>({...asset,id:randomUUID(),characterId:freshId}))});
    character.raw={...character.raw,workbenchProvenance:{sourceInstanceId:id,sourceCharacterId:source.id,copiedAt:now()}};
    this.store.saveCharacter(character,true);if(this.libraryLife)for(const kind of portableKinds)for(const item of context.life.data.list(source.id,kind))this.libraryLife.data.put(freshId,kind,cleanPersona(item));
    return {character:this.store.requireCharacter(freshId)};
    }finally{context.release();}
  }
  async proxy(id,path,req,res) {
    const context=this.context(id),runtime=this.runtimes.get(id),record=this.record(id);
    const moduleRoute=/^\/api\/modules\/([^/]+)/.exec(path),moduleAI=/^\/api\/ai\/modules\/([^/]+)/.exec(path);
    const requested=moduleRoute?.[1]||moduleAI?.[1];
    if(requested&&requested!==record.moduleId&&!(record.moduleId==='comfyui'&&requested==='drawing'))throw conflict('这个接口不属于当前模块实例。');
    if(path.startsWith('/api/instances')||path.startsWith('/instances/'))throw new WorkbenchError(404,'实例不能管理其他实例。');
    // The selected module alone is enabled; internal APIs can never change another instance.
    const target=new URL(runtime.url),headers={...req.headers,host:target.host,...(req.headers.origin?{origin:req.headers.origin==='null'?'null':target.origin}:{}),'accept-encoding':'identity'};
    delete headers.connection;delete headers.cookie;
    await new Promise((resolveProxy,reject)=>{
      const outgoing=request(target.origin+path,{method:req.method,headers});let incoming,finished=false;
      const finish=error=>{if(finished)return;finished=true;req.off('aborted',abort);res.off('close',abort);if(error){outgoing.destroy();incoming?.destroy();reject(error);}else resolveProxy();};
      const abort=()=>finish(conflict('实例请求已中断。'));req.once('aborted',abort);res.once('close',abort);
      outgoing.on('error',()=>finish(new WorkbenchError(503,'实例已停止或暂时不可用。')));
      outgoing.on('response',response=>{incoming=response;const responseHeaders={...response.headers};delete responseHeaders.connection;delete responseHeaders['transfer-encoding'];
        response.on('error',()=>finish(new WorkbenchError(502,'实例响应中断。')));
        res.removeHeader('x-frame-options');res.removeHeader('content-security-policy');
        if(responseHeaders['content-type']?.startsWith('application/json')){
          const chunks=[];let size=0;
          response.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024)return finish(new WorkbenchError(502,'实例响应过大。'));chunks.push(chunk);});
          response.once('end',()=>{if(finished)return;let bytes=Buffer.concat(chunks);try{bytes=Buffer.from(JSON.stringify(scopeInstanceLinks(JSON.parse(bytes.toString('utf8')),'/instances/'+id)));}catch{}responseHeaders['content-length']=bytes.length;res.writeHead(response.statusCode,responseHeaders);res.end(bytes);finish();});
        }else{res.writeHead(response.statusCode,responseHeaders);response.pipe(res);response.once('end',()=>finish());}
      });req.pipe(outgoing);
    });
  }
  async close(){if(this.closing)return this.closing;this.closed=true;this.closing=(async()=>{await Promise.allSettled(this.operations.values());await Promise.all([...this.runtimes.keys()].map(id=>this.stopRuntime(id)));this.db.close();this.releaseLock();})();return this.closing;}
}
