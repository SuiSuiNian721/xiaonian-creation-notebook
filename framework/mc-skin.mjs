import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, copyFile, stat, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';
import { WorkbenchError, fields, identifier, text } from './contracts.mjs';
import { SkinRuntime, localSkinDirectory, skinSkillRoot, skillInstructions } from './mc-skin-runtime.mjs';

const ACTIVE=new Set(['queued','designing','rendering']);
const FILES=new Map([['skin.png','image/png'],['layers.png','image/png'],['manifest.json','application/json; charset=utf-8'],['preview.html','text/html; charset=utf-8']]);
const isUuid=value=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');

export class MinecraftSkin {
  constructor({store,dataDir,sharedAI,complete=sharedAI.complete.bind(sharedAI),pythonPath=''}){
    this.store=store;this.db=store.db;this.directory=join(dataDir,'mc-skin');this.complete=complete;this.active=new Map();this.closed=false;
    this.runtime=new SkinRuntime({directory:dataDir,pythonPath,getPythonPath:()=>store.module('mc-skin').config.pythonPath||''});
    this.db.exec('CREATE TABLE IF NOT EXISTS mc_skin_uploads(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS mc_skin_jobs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL);');
    for(const job of this.jobs())if(ACTIVE.has(job.status)){job.status='interrupted';job.error='工作台已重启，上次制作未完成。请核对后重新制作。';this.save(job);}
  }
  row(table,id){const row=this.db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(identifier(id));return row?JSON.parse(row.payload):null;}
  ensureOpen(){if(this.closed)throw new WorkbenchError(409,'工作台正在关闭，不能开始新的皮肤操作。');}
  jobs(){return this.db.prepare('SELECT payload FROM mc_skin_jobs ORDER BY rowid DESC').all().map(row=>JSON.parse(row.payload));}
  job(id){const job=this.row('mc_skin_jobs',id);if(!job)throw new WorkbenchError(404,'找不到这份皮肤作品。');return job;}
  uploadRecord(id){const item=this.row('mc_skin_uploads',id);if(!item)throw new WorkbenchError(404,'找不到这份参考图或原皮肤。');return item;}
  save(job){this.db.prepare('UPDATE mc_skin_jobs SET payload=? WHERE id=?').run(JSON.stringify(job),job.id);}
  event(kind,message,job,level='info'){this.store.event({moduleId:'mc-skin',characterId:job?.characterId||null,kind:'skin.'+kind,message,level});}
  async state(){this.ensureOpen();const runtime=await this.runtime.check();this.ensureOpen();const {command,uv,templates=[],...visible}=runtime;return{runtime:visible,templates,jobs:this.jobs().slice(0,100)};}
  async check(){await this.runtime.check(true);return this.state();}
  async upload(value){
    this.ensureOpen();
    fields(value,['fileName','base64','kind','model']);
    const name=text(value.fileName,'文件名称',180);if(!['reference','skin'].includes(value.kind))throw new WorkbenchError(400,'请选择角色参考图或原皮肤。');
    if(!/\.(png|jpe?g|webp)$/i.test(name))throw new WorkbenchError(400,'请上传 PNG、JPEG 或 WEBP 图像。');
    if(typeof value.base64!=='string'||!value.base64||value.base64.length>12*1024*1024||value.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))throw new WorkbenchError(400,'图像数据无效或超过 8 MiB。');
    const bytes=Buffer.from(value.base64,'base64');if(bytes.length>8*1024*1024)throw new WorkbenchError(400,'图像不能超过 8 MiB。');
    const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'.png':bytes[0]===255&&bytes[1]===216?'.jpg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'.webp':null;
    if(!ext)throw new WorkbenchError(400,'文件内容不是支持的图像。');
    if(value.kind==='skin'&&(!['slim','classic'].includes(value.model)||ext!=='.png'))throw new WorkbenchError(400,'原皮肤需要 PNG 文件和明确的 Slim / Classic 模型。');
    await localSkinDirectory(join(this.directory,'uploads'),{create:true});
    this.ensureOpen();
    const id=randomUUID(),filename=id+ext,path=join(this.directory,'uploads',filename);await writeFile(path,bytes,{flag:'wx'});
    try{
      this.ensureOpen();
      const probe=await this.runtime.run(['probe','--source',path]);let validation;
      if(value.kind==='skin'){
        if(probe.width!==64||probe.height!==64)throw new WorkbenchError(400,'原皮肤必须是原生 64×64 PNG，不能自动缩小角色插画。');
        const inspected=await this.runtime.run(['inspect','--source',path,'--model',value.model]);validation=inspected.validation;
        if(!validation?.passed)throw new WorkbenchError(400,'原皮肤的基础层、Alpha 或 UV 检查未通过，请先修正原文件。');
      }
      const item={id,name:basename(name),kind:value.kind,filename,mime:probe.mime||({'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[ext]),width:probe.width,height:probe.height,model:value.model||null,sha256:digest(bytes),url:'/api/modules/mc-skin/uploads/'+id,...(validation?{validation}:{})};
      this.ensureOpen();
      this.db.prepare('INSERT INTO mc_skin_uploads VALUES(?,?)').run(id,JSON.stringify(item));return item;
    }catch(error){await unlink(path).catch(()=>{});throw error instanceof WorkbenchError?error:new WorkbenchError(400,error.message);}
  }
  async uploadedImage(id){const item=this.uploadRecord(id);return{...item,bytes:await readFile(join(this.directory,'uploads',item.filename))};}
  async importConfigured(value){
    this.ensureOpen();
    fields(value,['model']);const path=this.store.module('mc-skin').config.skinPath;
    if(!path||!isAbsolute(path))throw new WorkbenchError(400,'请先保存当前皮肤文件的绝对路径。');
    await localSkinDirectory(dirname(path));const entry=await lstat(path).catch(()=>null);
    if(!entry?.isFile()||entry.isSymbolicLink()||entry.size>8*1024*1024)throw new WorkbenchError(400,'原皮肤需要普通本地 PNG 文件，且不能超过 8 MiB。');
    return this.upload({fileName:basename(path),kind:'skin',model:value.model,base64:(await readFile(path)).toString('base64')});
  }
  async submit(value){
    this.ensureOpen();
    fields(value,['requestId','name','instruction','model','eyeTemplate','referenceIds','sourceId','parentId','characterId']);
    if(!isUuid(value.requestId))throw new WorkbenchError(400,'制作请求缺少有效的唯一标识。');
    const normalized={requestId:value.requestId,name:value.name,instruction:value.instruction,model:value.model,eyeTemplate:value.eyeTemplate,referenceIds:value.referenceIds||[],sourceId:value.sourceId||null,parentId:value.parentId||null,characterId:value.characterId||null};
    const fingerprint=digest(JSON.stringify(normalized));const existing=this.db.prepare('SELECT payload FROM mc_skin_jobs WHERE request_id=?').get(value.requestId);
    if(existing){const job=JSON.parse(existing.payload);if(job.fingerprint!==fingerprint)throw new WorkbenchError(409,'这个请求已用于另一份制作要求，请重新提交。');return job;}
    const name=text(value.name,'作品名称',100),instruction=text(value.instruction,'制作要求',12000);
    if(!['slim','classic'].includes(value.model))throw new WorkbenchError(400,'请选择 Slim 或 Classic 模型。');
    if(!['eye_A','eye_B',null].includes(value.eyeTemplate))throw new WorkbenchError(400,'请选择第一种或第二种角色眼睛。');
    if(!Array.isArray(normalized.referenceIds)||normalized.referenceIds.length>3||new Set(normalized.referenceIds).size!==normalized.referenceIds.length)throw new WorkbenchError(400,'最多添加三张不同的角色参考图。');
    const references=normalized.referenceIds.map(id=>this.uploadRecord(id));if(references.some(item=>item.kind!=='reference'))throw new WorkbenchError(400,'参考图列表只能包含角色参考图。');
    const source=normalized.sourceId?this.uploadRecord(normalized.sourceId):null;
    if(source&&(source.kind!=='skin'||source.model!==value.model))throw new WorkbenchError(400,'原皮肤的模型与本次选型不一致。');
    const parent=normalized.parentId?this.job(normalized.parentId):null;
    if(source&&parent)throw new WorkbenchError(400,'原皮肤与继续修改版本只能选择一个。');
    if(parent&&(parent.status!=='completed'||parent.model!==value.model))throw new WorkbenchError(400,'只能继续修改已完成且模型一致的皮肤版本。');
    if(!source&&!parent&&value.eyeTemplate===null)throw new WorkbenchError(400,'新皮肤需要选择一种眼型。');
    if(this.active.size)throw new WorkbenchError(409,'已有一份皮肤正在制作，请等待完成或先取消。');
    const runtime=await this.runtime.check();this.ensureOpen();if(!runtime.available)throw new WorkbenchError(409,runtime.error);
    const character=normalized.characterId?this.store.requireCharacter(normalized.characterId):null;
    const characterSnapshot=character?{id:character.id,name:character.name,description:character.description,revision:character.revision,updatedAt:character.updatedAt}:null;
    const outputPath=this.store.module('mc-skin').config.workspacePath;
    if(outputPath)await localSkinDirectory(resolve(outputPath),{create:false});
    this.ensureOpen();
    const concurrent=this.db.prepare('SELECT payload FROM mc_skin_jobs WHERE request_id=?').get(value.requestId);
    if(concurrent){const job=JSON.parse(concurrent.payload);if(job.fingerprint!==fingerprint)throw new WorkbenchError(409,'这个请求已用于另一份制作要求，请重新提交。');return job;}
    if(this.active.size)throw new WorkbenchError(409,'已有一份皮肤正在制作，请等待完成或先取消。');
    const id=randomUUID();const job={id,requestId:value.requestId,fingerprint,name,instruction,model:value.model,eyeTemplate:value.eyeTemplate,referenceIds:normalized.referenceIds,sourceId:source?.id||null,parentId:parent?.id||null,projectId:parent?.projectId||id,version:parent?parent.version+1:1,characterId:character?.id||null,characterName:character?.name||'',characterSnapshot,status:'queued',createdAt:new Date().toISOString(),files:{},validation:null,approved:false,outputPath:outputPath||''};
    this.db.prepare('INSERT INTO mc_skin_jobs VALUES(?,?,?)').run(id,job.requestId,JSON.stringify(job));
    const controller=new AbortController();const entry={controller,promise:null};this.active.set(id,entry);
    entry.promise=Promise.resolve().then(()=>this.make(job,{runtime,references,source,parent,signal:controller.signal})).finally(()=>this.active.delete(id));
    this.event('submitted','已提交皮肤制作，原始参考和已有版本保留。',job);return job;
  }
  async make(job,{runtime,references,source,parent,signal}){
    try{
      await localSkinDirectory(join(this.directory,'jobs',job.id),{create:true});
      if(signal.aborted)throw new Error('皮肤制作已取消。');
      const sourcePath=source?join(this.directory,'uploads',source.filename):parent?join(this.directory,'jobs',parent.id,'output','skin.png'):null;
      const inspected=sourcePath?await this.runtime.run(['inspect','--source',sourcePath,'--model',job.model],{signal}):null;
      const template=runtime.templates.find(item=>item.id===job.eyeTemplate);
      const instructions=await skillInstructions();
      const system=`你正在明确调用 minecraft-pixel-skin。遵循以下 skill，并只返回一个 JSON 像素方案；宿主执行实际脚本。不要生成程序、命令或文件路径。\n${instructions}\n本次制作模型为 ${job.model}，眼型为 ${job.eyeTemplate||'保持原皮肤眼型'}。\n输出格式：{"palette":{"S":[255,239,229,255]},"surfaces":[{"face":"head.front","base":["SSSSSSSS",...],"outer":["--------",...]}],"eyePalette":{"S":[...],...},"eyePreserve":[],"eyeOcclusions":[]}。palette 键为单个ASCII字符，颜色为RGBA，Alpha仅0或255。每个面的矩阵尺寸必须严格匹配提供的UV尺寸，句点保留原像素，减号仅清空外层。新作提供全部36个面的完整基础层；修改只提供需要修改的面和像素，其余保留。请使用分层色彩、衣装正背面与接缝，而非单色块。不要添加第三种眼睛模板。eyePalette必须按颜色用途绑定所选模板全部键；配色依据角色参考。eyePreserve仅在明确的参考发丝与眼型冲突时给出head.front局部xy和具体依据；eyeOcclusions仅为明确遮眼参考提供局部xy与依据。不要随意放行所有眼部。所有产物是待审阅候选。`;
      const user={instruction:job.instruction,name:job.name,model:job.model,uv:runtime.uv?.[job.model],eyeTemplate:template||null,source:inspected,character:job.characterSnapshot,referenceNames:references.map(item=>item.name)};
      const images=[...references.map(item=>({path:join(this.directory,'uploads',item.filename),mime:item.mime})),...(sourcePath?[{path:sourcePath,mime:'image/png'}]:[])];
      if(signal.aborted)throw new Error('皮肤制作已取消。');
      job.status='designing';this.save(job);
      const result=await this.complete([{role:'system',content:system},{role:'user',content:JSON.stringify(user)}],{moduleId:'mc-skin',images,skill:{name:'minecraft-pixel-skin',path:join(skinSkillRoot,'SKILL.md')},timeoutMs:300000,signal});
      if(signal.aborted)throw new Error('皮肤制作已取消。');
      let plan;try{plan=JSON.parse(result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));}catch{throw new Error('AI 没有返回有效的像素方案，请调整要求后重试。');}
      if(!plan||typeof plan!=='object'||Array.isArray(plan)||JSON.stringify(plan).length>250000)throw new Error('像素方案格式无效或过大。');
      job.status='rendering';this.save(job);
      const directory=join(this.directory,'jobs',job.id);const requestPath=join(directory,'request.json');
      await writeFile(requestPath,JSON.stringify({model:job.model,eyeTemplate:job.eyeTemplate,...(sourcePath?{source:sourcePath}:{}),plan,provenance:{name:job.name,userInstruction:job.instruction,requestId:job.requestId,referenceHashes:references.map(item=>({name:item.name,sha256:item.sha256})),characterId:job.characterId,characterSnapshot:job.characterSnapshot}}),{flag:'wx',encoding:'utf8'});
      await this.runtime.run(['render','--request',requestPath,'--output',join(directory,'output')],{signal});
      if(signal.aborted)throw new Error('皮肤制作已取消。');
      const manifest=JSON.parse(await readFile(join(directory,'output','manifest.json'),'utf8'));
      const png=await readFile(join(directory,'output','skin.png'));
      if(!manifest.validation?.passed||manifest.png_readback_verified!==true||manifest.output_sha256!==digest(png))throw new Error('皮肤输出未通过校验，已保留制作记录供检查。');
      for(const file of FILES.keys()){const info=await stat(join(directory,'output',file));if(!info.isFile()||info.size>15*1024*1024)throw new Error('皮肤产物缺失或大小异常。');}
      if(job.outputPath){
        try{const archive=await localSkinDirectory(join(job.outputPath,'AI未来皮肤',job.id),{create:true});for(const file of FILES.keys())await copyFile(join(directory,'output',file),join(archive,file),1);job.archived=archive;}
        catch{job.warning='皮肤已保存到工作台，但额外作品目录归档失败。可下载 PNG 和分层图，另存到作品目录。';}
      }
      if(signal.aborted)throw new Error('皮肤制作已取消。');
      job.files=Object.fromEntries([...FILES.keys()].map(file=>[file,`/api/modules/mc-skin/files/${job.id}/${file}`]));job.validation=manifest.validation;job.status='completed';job.finishedAt=new Date().toISOString();job.summary=plan.summary||'';job.usage=result.usage||null;this.save(job);
      if(job.characterId)this.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?)').run(job.id,'skin',job.name,'mc-skin',job.characterId,`mc-skin/jobs/${job.id}/output/skin.png`);
      this.event('completed','皮肤候选已生成，PNG 与像素检查通过，可预览和下载。',job);
    }catch(error){
      if(!this.closed){job.status=signal.aborted?'cancelled':'failed';job.error=String(error.message).replace(/(?:[A-Za-z]:[\\/])[^\r\n"']+/g,'[本地文件]').slice(-1200);job.finishedAt=new Date().toISOString();job.files={};this.save(job);this.event(job.status,job.status==='cancelled'?'皮肤制作已取消。':'皮肤制作失败，请检查要求或运行环境。',job,job.status==='failed'?'error':'info');}
    }
  }
  cancel(id){const job=this.job(id);if(!ACTIVE.has(job.status))return job;this.active.get(id)?.controller.abort();job.status='cancelled';job.finishedAt=new Date().toISOString();this.save(job);return job;}
  approve(id){const job=this.job(id);if(job.status!=='completed')throw new WorkbenchError(409,'请先完成皮肤制作。');job.approved=true;job.approvedAt=new Date().toISOString();this.save(job);this.event('approved','已确认这份皮肤作品版本。',job);return job;}
  async file(id,filename){const job=this.job(id);if(job.status!=='completed'||!FILES.has(filename))throw new WorkbenchError(404,'找不到这个皮肤产物。');return{mime:FILES.get(filename),filename,bytes:await readFile(join(this.directory,'jobs',job.id,'output',filename))};}
  async close(){this.closed=true;for(const [id,entry]of this.active){entry.controller.abort();const job=this.job(id);if(ACTIVE.has(job.status)){job.status='interrupted';job.error='工作台已关闭，制作未完成。';this.save(job);}}this.runtime.close();await Promise.allSettled([...this.active.values()].map(entry=>entry.promise));}
}
