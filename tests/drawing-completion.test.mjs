import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const load = () => import('../framework/drawing-completion.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const workflow = {'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'folder/base.safetensors'}},'2':{class_type:'LoraLoader',inputs:{lora_name:'person.safetensors'}},'3':{class_type:'RareNode',inputs:{clip_name1:'text.safetensors',vae_name:'decoder.safetensors',unet_name:'diff.safetensors'}}};
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(),'completion-')); const comfyPath = join(root,'ComfyUI');
  await mkdir(join(comfyPath,'comfy'),{recursive:true});
  for (const name of ['main.py','nodes.py','server.py']) await writeFile(join(comfyPath,name),'# fixture');
  const settings = new Map(); const store={getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  const config={comfyPath,serviceUrl:'http://127.0.0.1:8188'};
  const drawing={config:()=>config,currentConnection:()=>false};
  const manager={downloads:{start:async value=>({id:'download-fixture',...value})},plan:async value=>value};
  const {DrawingCompletion}=await load(); const completion=new DrawingCompletion({drawing,manager,store,dataDir:root,...options});
  t.after(async()=>{await completion.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  return {root,comfyPath,settings,store,config,drawing,manager,completion};
}

test('离线提取五类模型和节点，重复依赖合并且不要求在线节点定义',async()=>{
  const {extractWorkflowDependencies}=await load();const result=extractWorkflowDependencies({...workflow,'4':workflow['2']});
  assert.deepEqual(result.dependencies.filter(item=>item.kind==='model').map(item=>item.category).sort(),['checkpoints','clip','loras','unet','vae']);
  assert.equal(result.dependencies.find(item=>item.filename==='person.safetensors').references.length,2);
  assert.ok(result.dependencies.some(item=>item.classType==='RareNode'));
});

test('普通工作流已知加载器控件可离线提取，未知位置只标记未验证',async()=>{
  const {extractWorkflowDependencies}=await load();const result=extractWorkflowDependencies({nodes:[{id:1,type:'UNETLoader',widgets_values:['diff.safetensors','default']},{id:2,type:'MysteryLoader',widgets_values:['mystery.safetensors']}]});
  assert.equal(result.dependencies.find(item=>item.filename==='diff.safetensors').category,'unet');
  assert.ok(result.warnings.some(item=>/MysteryLoader/.test(item)));
});

test('本地额外模型目录与服务可见性分开报告，SHA缓存在内容身份变化后失效',async t=>{
  const f=await fixture(t);const external=join(f.root,'external');await mkdir(external);await writeFile(join(external,'base.safetensors'),'original');
  await writeFile(join(f.comfyPath,'extra_model_paths.yaml'),`shared:\n  base_path: ${f.root.replaceAll('\\','/')}\n  checkpoints: external\n`);
  const first=await f.completion.inspect({document:workflow});const dep=first.dependencies.find(item=>item.filename==='folder/base.safetensors');
  assert.equal(dep.local.files[0].sha256,hash('original'));assert.equal(dep.service.status,'unverified');assert.equal(dep.local.identity,'unverified');
  await writeFile(join(external,'base.safetensors'),'changed-content');const second=await f.completion.inspect({document:workflow});
  assert.equal(second.dependencies.find(item=>item.id===dep.id).local.files[0].sha256,hash('changed-content'));
});

test('网络候选采用平台证据，HF blobId 不会冒充 SHA256，搜索复用24小时缓存',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async url=>{calls++;const target=new URL(url);if(target.hostname==='civitai.com')return Response.json({items:[{id:1,name:'base',modelVersions:[{id:2,name:'v2',files:[{name:'base.safetensors',sizeKB:2,hashes:{SHA256:'a'.repeat(64)},downloadUrl:'https://civitai.com/api/download/models/2'}]}]}]});if(target.pathname==='/api/models')return Response.json([{id:'author/model'}]);return Response.json({id:'author/model',sha:'b'.repeat(40),siblings:[{rfilename:'base.safetensors',size:64,blobId:'c'.repeat(40)}]});}});
  const report=await f.completion.inspect({document:{'1':workflow['1']}});const dependency=report.dependencies.find(item=>item.kind==='model');
  const searched=await f.completion.search(report.id,{dependencyIds:[dependency.id]});const candidates=searched.dependencies.find(item=>item.id===dependency.id).candidates;
  assert.equal(candidates.find(item=>item.platform==='civitai').sizeBytes,2048);
  assert.equal(candidates.find(item=>item.platform==='huggingface').sha256,null);
  assert.equal(candidates.find(item=>item.platform==='huggingface').verification,'untrusted-hash');
  const previous=calls;await f.completion.search(report.id,{dependencyIds:[dependency.id]});assert.equal(calls,previous);
});

test('哈希新读预算耗尽返回部分结果；远程服务下载不得当作补齐',async t=>{
  const f=await fixture(t,{limits:{hashBytes:1}});await mkdir(join(f.comfyPath,'models/checkpoints'),{recursive:true});await writeFile(join(f.comfyPath,'models/checkpoints/base.safetensors'),'large');
  f.config.serviceUrl='https://remote.invalid:8188';const report=await f.completion.inspect({document:{'1':workflow['1']}});
  assert.equal(report.partial,true);assert.equal(report.scope,'remote');
  await assert.rejects(f.completion.download(report.id,{requestId:'request-one',selections:[]}),/远程/);
});

test('采纳替换只导出副本且仅修改被明确选择的引用',async t=>{
  const f=await fixture(t);const source=structuredClone(workflow);const report=await f.completion.inspect({document:source});const dep=report.dependencies.find(item=>item.filename==='person.safetensors');
  const result=await f.completion.copy(report.id,{replacements:[{dependencyId:dep.id,value:'new/person.safetensors'}]});
  assert.equal(result.document['2'].inputs.lora_name,'new/person.safetensors');assert.deepEqual(source,workflow);
  assert.equal(JSON.parse(await readFile(result.path,'utf8'))['2'].inputs.lora_name,'new/person.safetensors');
});

test('模型候选报告下载增量与临时峰值；下载勾选先完整验证再交给旧队列',async t=>{
  let started=0;const f=await fixture(t,{fetchImpl:async url=>new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,name:'base',modelVersions:[{id:2,files:[{name:'base.safetensors',sizeKB:2,hashes:{SHA256:'a'.repeat(64)},downloadUrl:'https://civitai.com/api/download/models/2'}]}]}]}):Response.json([])});
  f.manager.downloads.start=async input=>{started++;return {id:'download-one',...input};};
  const report=await f.completion.inspect({document:{'1':workflow['1']}});const dep=report.dependencies.find(item=>item.kind==='model');const searched=await f.completion.search(report.id,{dependencyIds:[dep.id]});const item=searched.dependencies.find(item=>item.id===dep.id).candidates[0];
  assert.equal(item.storage.downloadBytes,2048);assert.equal(item.storage.incrementalBytes,2048);assert.equal(item.storage.temporaryPeakBytes,4096);assert.equal(typeof item.storage.destination,'string');
  await assert.rejects(f.completion.download(report.id,{requestId:'batch-one',selections:[{dependencyId:dep.id,candidateId:item.id},{dependencyId:'invalid',candidateId:'invalid'}]}));assert.equal(started,0);
});

test('稳定请求重复检查只建一项，当前服务可选文件与本地磁盘分开',async t=>{
  const f=await fixture(t);f.drawing.currentConnection=()=>true;f.drawing.request=async()=>({CheckpointLoaderSimple:{input:{required:{ckpt_name:[['folder/base.safetensors']]}}}});
  const input={document:{'1':workflow['1']},requestId:'check-one'};const a=await f.completion.inspect(input);const b=await f.completion.start(input);assert.equal(a.id,b.id);assert.equal(f.completion.list().length,1);
  const dep=a.dependencies.find(item=>item.kind==='model');assert.equal(dep.service.status,'exists');assert.equal(dep.local.status,'missing');
});

test('服务明确返回空模型枚举时报告缺失，未知节点仍不猜测模型列表',async t=>{
  const f=await fixture(t);f.drawing.currentConnection=()=>true;f.drawing.request=async()=>({CheckpointLoaderSimple:{input:{required:{ckpt_name:[[]]}}}});
  const report=await f.completion.inspect({document:{'1':workflow['1'],'2':workflow['2']}});
  assert.equal(report.dependencies.find(item=>item.filename==='folder/base.safetensors').service.status,'missing');
  assert.equal(report.dependencies.find(item=>item.filename==='person.safetensors').service.status,'unverified');
});

test('离线检查不访问模型平台，空object_info和未选择本地目录均标未验证',async t=>{
  const f=await fixture(t,{fetchImpl:async()=>{throw new Error('离线检查不应访问来源平台');}});f.config.comfyPath='';f.drawing.currentConnection=()=>true;f.drawing.request=async()=>({});
  const report=await f.completion.inspect({document:{'1':workflow['1']}});const dependency=report.dependencies.find(item=>item.kind==='model');assert.equal(dependency.service.status,'unverified');assert.equal(dependency.local.status,'unverified');
});

test('补全网络请求有全局并发2与单轮请求上限，取消后不继续查询',async t=>{
  let active=0,peak=0,calls=0;const f=await fixture(t,{limits:{requests:4},fetchImpl:async(url,{signal})=>{calls++;active++;peak=Math.max(peak,active);try{await new Promise((done,reject)=>{const timer=setTimeout(done,5);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('cancelled'));},{once:true});});return Response.json([]);}finally{active--;}}});
  const report=await f.completion.inspect({document:workflow});const result=await f.completion.search(report.id);assert.ok(calls<=4);assert.ok(peak<=2);assert.equal(result.partial,true);
});

test('取消正在等待来源API的报告会中止请求并保存已得到的结果',async t=>{
  let calls=0;const f=await fixture(t,{fetchImpl:async(_url,{signal})=>{calls++;return new Promise((_done,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}});
  const report=await f.completion.inspect({document:workflow});const search=f.completion.search(report.id);
  while(!calls)await new Promise(done=>setTimeout(done,1));const cancelled=await f.completion.cancel(report.id);await search;
  assert.equal(cancelled.status,'cancelled');assert.ok(calls<=2);assert.ok(f.store.getSetting('drawing.completion.reports').some(item=>item.id===report.id&&item.status==='cancelled'));
});

test('只在显式选择时读取模型链接根，不自动跟随任意子链接',async t=>{
  const f=await fixture(t);const external=join(f.root,'external'),linked=join(f.root,'linked');await mkdir(external);await writeFile(join(external,'person.safetensors'),'fixture');
  await symlink(external,linked,process.platform==='win32'?'junction':'dir');
  const report=await f.completion.inspect({document:{'1':workflow['2']},explicitDirectories:[{path:linked,category:'loras'}]});
  const dependency=report.dependencies.find(item=>item.kind==='model');assert.equal(dependency.local.files.length,1);assert.equal(dependency.local.files[0].source,'explicit-link');
  await assert.rejects(f.completion.inspect({document:workflow,explicitDirectories:[{path:'relative/path',category:'loras'}]}),/绝对路径/);
});

test('平台文件名不同于原引用时按候选别名核对本地SHA，复用而不重复下载',async t=>{
  const content='already-local';let downloads=0;const f=await fixture(t,{fetchImpl:async url=>new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,modelVersions:[{id:2,files:[{name:'new.safetensors',sizeKB:1,hashes:{SHA256:hash(content)},downloadUrl:'https://civitai.com/api/download/models/2'}]}]}]}):Response.json([])});
  const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});const path=join(directory,'new.safetensors');await writeFile(path,content);
  f.manager.downloads.start=async()=>{downloads++;return {id:'unexpected'};};
  const report=await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}});const dep=report.dependencies.find(item=>item.kind==='model');
  const searched=await f.completion.search(report.id,{dependencyIds:[dep.id]});const candidate=searched.dependencies.find(item=>item.id===dep.id).candidates[0];
  assert.equal(candidate.reuse.path,path);assert.equal(candidate.reuse.reference,'new.safetensors');assert.equal(candidate.storage.downloadBytes,0);
  const result=await f.completion.download(report.id,{requestId:'reuse-new',selections:[{dependencyId:dep.id,candidateId:candidate.id}]});assert.equal(result.tasks[0].status,'reused');assert.equal(downloads,0);
  const copy=await f.completion.copy(report.id,{replacements:[{dependencyId:dep.id,value:candidate.reuse.reference}]});assert.equal(copy.document['1'].inputs.ckpt_name,'new.safetensors');
});

test('不同文件名的有效SHA缓存可复用同一来源文件，缓存失效时不按旧SHA复用或全盘哈希',async t=>{
  const content='cached-and-renamed';const f=await fixture(t,{fetchImpl:async url=>new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,modelVersions:[{id:2,files:[{name:'new.safetensors',sizeKB:1,hashes:{SHA256:hash(content)},downloadUrl:'https://civitai.com/api/download/models/2'}]}]}]}):Response.json([])});
  const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});const path=join(directory,'renamed.safetensors');await writeFile(path,content);await writeFile(join(directory,'unrelated.safetensors'),'do-not-hash');
  await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'renamed.safetensors'}}}});
  f.completion.limits.hashBytes=0;
  const inspect=()=>f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}});
  const report=await inspect();const dep=report.dependencies.find(item=>item.kind==='model');const searched=await f.completion.search(report.id,{dependencyIds:[dep.id]});const candidate=searched.dependencies.find(item=>item.id===dep.id).candidates[0];
  assert.equal(candidate.reuse.path,path);assert.equal(candidate.reuse.reference,'renamed.safetensors');assert.equal(searched.budget.hashBytes,0);
  await writeFile(path,'changed-after-cache');const second=await inspect();const next=await f.completion.search(second.id,{dependencyIds:[dep.id]});assert.equal(next.dependencies.find(item=>item.id===dep.id).candidates[0].reuse,null);assert.equal(next.budget.hashBytes,0);
});

test('显式搜索单独启用一轮受限哈希预算，总用量另外累计且保留缓存',async t=>{
  const candidates=Array.from({length:4},(_,index)=>({name:`alias-${index}.safetensors`,sizeKB:1,hashes:{SHA256:hash('same')},downloadUrl:`https://civitai.com/api/download/models/${index+1}`}));
  const f=await fixture(t,{limits:{hashBytes:12},fetchImpl:async url=>new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,modelVersions:[{id:2,files:candidates}]}]}):Response.json([])});
  const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});await writeFile(join(directory,'old.safetensors'),'same');for(const candidate of candidates)await writeFile(join(directory,candidate.name),'same');
  const report=await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}});const dep=report.dependencies.find(item=>item.kind==='model');assert.equal(report.budget.hashBytes,4);
  const searched=await f.completion.search(report.id,{dependencyIds:[dep.id]});const local=searched.dependencies.find(item=>item.id===dep.id).local;
  assert.equal(local.hashAttempts,3);assert.equal(searched.budget.hashBytes,12);assert.equal(searched.totalUsage.hashBytes,16);assert.equal(searched.budget.round,2);assert.equal(searched.partial,true);assert.equal(local.files.filter(item=>item.sha256).length,4);
});

test('显式继续开启新一轮可处理上轮未校验文件，GET不续检也不扩额',async t=>{
  const candidates=Array.from({length:4},(_,index)=>({name:`alias-${index}.safetensors`,sizeKB:1,hashes:{SHA256:hash(String(index).repeat(4))},downloadUrl:`https://civitai.com/api/download/models/${index+1}`}));
  const f=await fixture(t,{limits:{hashBytes:8},fetchImpl:async url=>new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,modelVersions:[{id:2,files:candidates}]}]}):Response.json([])});
  const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});for(const [index,candidate] of candidates.entries())await writeFile(join(directory,candidate.name),String(index).repeat(4));
  const report=await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}});const dep=report.dependencies.find(item=>item.kind==='model');
  const first=await f.completion.search(report.id,{dependencyIds:[dep.id]});assert.equal(first.budget.hashBytes,8);assert.equal(first.totalUsage.hashBytes,8);assert.equal(first.partial,true);
  assert.equal(f.completion.get(report.id).budget.round,first.budget.round);assert.equal(f.completion.get(report.id).budget.hashBytes,8);
  const second=await f.completion.search(report.id);const local=second.dependencies.find(item=>item.id===dep.id).local;
  assert.equal(second.budget.hashBytes,8);assert.equal(second.totalUsage.hashBytes,16);assert.equal(second.budget.round,3);assert.equal(local.files.filter(item=>item.sha256).length,4);assert.equal(local.partial,false);assert.equal(second.partial,false);assert.equal(second.canContinue,false);
});

test('超过单轮哈希上限的单文件明确需手动处理，不通过继续静默扩额',async t=>{
  const f=await fixture(t,{limits:{hashBytes:2},fetchImpl:async()=>Response.json([])});const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});await writeFile(join(directory,'large.safetensors'),'large');
  const report=await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'large.safetensors'}}}});assert.equal(report.dependencies.find(item=>item.kind==='model').local.files[0].verification,'file-exceeds-budget');assert.ok(report.warnings.some(value=>/单文件.*手动/.test(value)));
  const second=await f.completion.search(report.id);assert.equal(second.budget.hashBytes,0);assert.equal(second.budget.limits.hashBytes,2);assert.equal(second.canContinue,false);
});

test('来源API等待不消耗新一轮本地哈希时间预算',async t=>{
  const f=await fixture(t,{limits:{hashMs:100},fetchImpl:async url=>{await new Promise(done=>setTimeout(done,150));return new URL(url).hostname==='civitai.com'?Response.json({items:[{id:1,modelVersions:[{id:2,files:[{name:'new.safetensors',sizeKB:1,hashes:{SHA256:hash('ready')},downloadUrl:'https://civitai.com/api/download/models/2'}]}]}]}):Response.json([]);}});
  const directory=join(f.comfyPath,'models/checkpoints');await mkdir(directory,{recursive:true});await writeFile(join(directory,'new.safetensors'),'ready');
  const report=await f.completion.inspect({document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'old.safetensors'}}}});const dep=report.dependencies.find(item=>item.kind==='model');
  const result=await f.completion.search(report.id,{dependencyIds:[dep.id]});assert.equal(result.dependencies.find(item=>item.id===dep.id).candidates[0].reuse.sha256,hash('ready'));assert.equal(result.budget.hashBytes,5);
});
