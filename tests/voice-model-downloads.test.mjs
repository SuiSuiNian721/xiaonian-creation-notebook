import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import fsPromises,{mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VoiceResources} from '../framework/voice-resources.mjs';
import {ResourceStorage} from '../framework/resource-storage.mjs';

const revision='a'.repeat(40),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function repositoryFixture(kind='base'){
  const files=new Map([
    ['config.json',Buffer.from(JSON.stringify({model_type:'qwen3_tts',architectures:['Qwen3TTSForConditionalGeneration'],tts_model_type:{base:'base','custom-voice':'custom_voice','voice-design':'voice_design'}[kind]}))],
    ['generation_config.json',Buffer.from('{}')],['tokenizer_config.json',Buffer.from('{}')],['vocab.json',Buffer.from('{}')],['merges.txt',Buffer.from('#version: 0.2\na b\n')],
    ['model.safetensors',Buffer.alloc(128,42)],['speech_tokenizer/config.json',Buffer.from('{"model_type":"qwen3_tts_tokenizer"}')],['speech_tokenizer/model.safetensors',Buffer.alloc(96,41)],
  ]);
  const metadata={sha:revision,siblings:[...files].map(([rfilename,bytes])=>({rfilename,size:bytes.length,blobId:gitBlob(bytes),...(rfilename.endsWith('.safetensors')?{lfs:{sha256:sha(bytes),size:bytes.length}}:{})})).concat([{rfilename:'README.md',size:999,blobId:'b'.repeat(40)},{rfilename:'examples/voice.wav',size:1000000,lfs:{sha256:'b'.repeat(64),size:1000000}}])};
  return {files,metadata};
}
async function fixture(t,{kind='base',changeMetadata,serveFile}={}){
  const directory=await mkdtemp(join(tmpdir(),'voice-model-download-')),settings=new Map(),requests=[],repo=repositoryFixture(kind);
  changeMetadata?.(repo.metadata);
  const fetchImpl=async(input,options={})=>{
    const url=String(input);requests.push({url,options});
    assert.equal(options.headers?.Authorization,undefined,'模型下载不能复用HTTP TTS密钥');
    if(url.includes('/api/models/'))return new Response(JSON.stringify(repo.metadata),{headers:{'content-type':'application/json'}});
    assert.ok(url.includes('/resolve/'+revision+'/'),'每个文件必须固定到commit');
    const filename=decodeURIComponent(url.split('/resolve/'+revision+'/')[1]),bytes=repo.files.get(filename);assert.ok(bytes,'禁止下载demo/示例文件：'+filename);
    if(serveFile){const value=await serveFile({filename,bytes,options});if(value)return value;}
    return new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':filename.endsWith('.json')?'application/json':'application/octet-stream'}});
  };
  const store={getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))},options={store,dataDir:directory,directory:join(directory,'resources'),searchRoots:[],candidates:{},fetchImpl,platform:'win32',arch:'x64'};
  const resources=new VoiceResources(options);await resources.initialized;t.after(async()=>{await resources.close();await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
  return {directory,resources,requests,repo,options,settings};
}
async function settled(resources){await resources.job?.promise;assert.notEqual(resources.state().task?.status,'running');return resources.state();}
function prepare(resources,modelKind='base',size='0.6B'){return resources.install({action:'plan-model',provider:'qwen3-tts',modelKind,size});}

test('启动/本地检索/状态不联网，显式计划才查询官方固定版本和小配置',async t=>{
  const {resources,requests,repo}=await fixture(t);resources.state();await resources.detect();assert.equal(requests.length,0);
  prepare(resources);const state=await settled(resources),plan=state.modelPlan;
  assert.equal(plan.status,'prepared');assert.equal(plan.repository,'Qwen/Qwen3-TTS-12Hz-0.6B-Base');assert.equal(plan.revision,revision);
  assert.equal(requests.filter(item=>item.url.endsWith('.safetensors')).length,0,'计划阶段不能下载权重');
  assert.equal(plan.files.length,repo.files.size);assert.equal(plan.downloadBytes,[...repo.files.values()].reduce((sum,bytes)=>sum+bytes.length,0));
  assert.ok(plan.files.every(file=>!Object.hasOwn(file,'content')&&!Object.hasOwn(file,'base64')),'公开状态只返回清单，不回传小文件内容');
  assert.equal(plan.diskPeakBytes,plan.downloadBytes,'原地发布，不复制第二份权重');
  const config=plan.files.find(item=>item.filename==='config.json');assert.equal(config.hashSource,'git-blob');assert.equal(config.sha256,sha(repo.files.get('config.json')));assert.notEqual(config.sha256,config.gitBlobId);
  assert.equal(plan.files.find(item=>item.filename==='model.safetensors').hashSource,'lfs.sha256');
});

test('准备计划拒绝伪SHA、Gitblob不匹配、用途不符和不支持规格',async t=>{
  for(const changeMetadata of [metadata=>{delete metadata.siblings.find(item=>item.rfilename==='model.safetensors').lfs;},metadata=>{metadata.siblings.find(item=>item.rfilename==='config.json').blobId='f'.repeat(40);}]){
    const {resources}=await fixture(t,{changeMetadata});prepare(resources);const state=await settled(resources);assert.equal(state.task.status,'failed');assert.match(state.task.error,/SHA256|Git|校验/);assert.notEqual(state.modelPlan?.status,'prepared');
  }
  const {resources}=await fixture(t,{kind:'custom-voice'});prepare(resources);assert.equal((await settled(resources)).task.status,'failed');
  assert.throws(()=>prepare(resources,'voice-design','0.6B'),/规格|1.7B/);
});

test('计划跨重启保留稳定ID，下载流校验后可单独绑定且不覆盖手工路径',async t=>{
  const {resources,directory,requests,options}=await fixture(t),manual=join(directory,'manual-model');await mkdir(manual);await resources.configure({qwenBasePath:manual,httpApiKey:'tts-secret'});
  prepare(resources);const planned=await settled(resources),id=planned.modelPlan.id;const before=requests.length;
  const reopened=new VoiceResources(options);t.after(()=>reopened.close());await reopened.initialized;assert.equal(requests.length,before);assert.equal(reopened.state().modelPlan.id,id);
  reopened.install({planId:id});reopened.install({planId:id});const done=await settled(reopened);assert.equal(done.task.status,'completed');assert.equal(done.modelPlan.status,'completed');assert.equal(done.modelPlan.id,id);
  assert.equal(done.config.qwenBasePath,manual);assert.deepEqual(await readFile(join(done.modelPlan.directory,'model.safetensors')),Buffer.alloc(128,42));
  await reopened.configure({qwenBasePath:done.modelPlan.directory});assert.equal(reopened.state().bindings.qwenBasePath.status,'available');
  const count=requests.length;reopened.install({planId:id});assert.equal(requests.length,count,'完成后重复提交同一ID不重新下载');
});

test('下载收尾释放锁之前保持运行状态，显示完成后即可绑定',async t=>{
  const {resources}=await fixture(t);prepare(resources);const plan=(await settled(resources)).modelPlan;
  let reached,release;
  const finalizing=new Promise(done=>{reached=done;}),gate=new Promise(done=>{release=done;});
  const acquire=resources.acquireLock.bind(resources);
  resources.acquireLock=async signal=>{const unlock=await acquire(signal);return async()=>{reached();await gate;await unlock();};};
  resources.install({planId:plan.id});
  try{
    await finalizing;
    assert.equal(resources.state().modelPlan.status,'running','文件登记和释放锁完成前不能显示可绑定');
    assert.equal(resources.state().task.status,'running');
  }finally{release();await resources.job?.promise;}
  assert.equal(resources.state().modelPlan.status,'completed');
  await resources.configure({qwenBasePath:plan.directory});
  assert.equal(resources.state().bindings.qwenBasePath.status,'available');
});

test('取消保留已验证计划与部分文件，同ID续传且错误SHA不能发布',async t=>{
  let entered,first=true;const started=new Promise(resolve=>{entered=resolve;});
  const {resources,requests}=await fixture(t,{serveFile:async({filename,bytes,options})=>{
    if(filename!=='model.safetensors')return;
    if(first){first=false;return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,5));entered();},pull(){return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),{headers:{'content-length':String(bytes.length)}});}
    const offset=Number(options.headers?.Range?.match(/bytes=(\d+)-/)?.[1]||0);return new Response(bytes.subarray(offset),{status:offset?206:200,headers:{'content-length':String(bytes.length-offset),...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})}});
  }});
  prepare(resources);const planned=await settled(resources),id=planned.modelPlan.id;resources.install({planId:id});await started;
  const partial=join(planned.modelPlan.directory,'model.safetensors.part'),deadline=Date.now()+3000;
  while((await readFile(partial).catch(()=>Buffer.alloc(0))).length!==5){if(Date.now()>deadline)assert.fail('下载的5字节未落盘');await new Promise(resolve=>setImmediate(resolve));}
  await resources.cancel();assert.equal(resources.state().modelPlan.status,'cancelled');
  resources.install({planId:id});const done=await settled(resources);assert.equal(done.task.status,'completed');assert.ok(requests.some(item=>item.options.headers?.Range==='bytes=5-'));
  const bad=await fixture(t,{serveFile:async({filename,bytes})=>filename==='model.safetensors'?new Response(Buffer.alloc(bytes.length,99)):undefined});prepare(bad.resources);const badPlan=(await settled(bad.resources)).modelPlan;bad.resources.install({planId:badPlan.id});const failed=await settled(bad.resources);assert.equal(failed.task.status,'failed');assert.match(failed.task.error,/SHA256/);await assert.rejects(access(join(badPlan.directory,'model.safetensors')));
});

test('更改下载目录使原计划失效，元数据超预算/取消不会启动权重下载',async t=>{
  const {resources,directory,requests}=await fixture(t);prepare(resources);const plan=(await settled(resources)).modelPlan;
  await resources.configure({directory:join(directory,'different-resources')});assert.equal(resources.state().modelPlan.stale,true);const count=requests.length;
  assert.throws(()=>resources.install({planId:plan.id}),/目录已改变|重新查询/);assert.equal(requests.length,count);
  const budget=await fixture(t,{changeMetadata:metadata=>{metadata.siblings.find(file=>file.rfilename==='config.json').size=9*1024*1024;}});prepare(budget.resources);assert.match((await settled(budget.resources)).task.error,/预算/);
  const cancelled=await fixture(t);cancelled.resources.fetch=async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));prepare(cancelled.resources);await new Promise(resolve=>setImmediate(resolve));await cancelled.resources.cancel();assert.equal(cancelled.resources.state().task.status,'cancelled');assert.equal(cancelled.resources.state().modelPlan.status,'cancelled');
});

test('目标目录已含未知文件时拒绝覆盖，重复准备相同清单保持计划ID',async t=>{
  const {resources,requests}=await fixture(t);prepare(resources);const first=(await settled(resources)).modelPlan;prepare(resources);const second=(await settled(resources)).modelPlan;assert.equal(first.id,second.id);
  await mkdir(second.directory,{recursive:true});await writeFile(join(second.directory,'keep.txt'),'original');const count=requests.length;
  resources.install({planId:second.id});const state=await settled(resources);assert.equal(state.task.status,'failed');assert.match(state.task.error,/已有其他文件/);assert.equal(requests.length,count);assert.equal(await readFile(join(second.directory,'keep.txt'),'utf8'),'original');
});

test('完整partial恢复校验期间新出现的用户同名文件不能被覆盖',async t=>{
  const {resources,repo}=await fixture(t);prepare(resources);const plan=(await settled(resources)).modelPlan;
  await mkdir(plan.directory,{recursive:true});await writeFile(join(plan.directory,'.workbench-qwen-model.json'),JSON.stringify({owner:'AI-Future-Workbench/qwen-model',planId:plan.id}));
  const target=join(plan.directory,'model.safetensors'),partial=target+'.part';await writeFile(partial,repo.files.get('model.safetensors'));
  const original=fs.createReadStream;let inserted=false;
  fs.createReadStream=(path,options)=>String(path)===partial?(async function*(){for await(const chunk of original(path,options)){if(!inserted){inserted=true;await writeFile(target,'user-original',{flag:'wx'});}yield chunk;}})():original(path,options);syncBuiltinESMExports();
  t.after(()=>{fs.createReadStream=original;syncBuiltinESMExports();});
  resources.install({planId:plan.id});const done=await settled(resources);
  assert.equal(inserted,true);assert.equal(await readFile(target,'utf8'),'user-original');assert.equal(done.task.status,'failed');assert.deepEqual(await readFile(partial),repo.files.get('model.safetensors'));
});

test('正常下载发布边界出现用户同名文件时原子拒绝并保留已校验partial',async t=>{
  const {resources,repo}=await fixture(t);prepare(resources);const plan=(await settled(resources)).modelPlan,target=join(plan.directory,'model.safetensors'),partial=target+'.part';
  const originalRename=fsPromises.rename,originalLink=fsPromises.link;let inserted=false;
  const race=original=>async(source,destination,...args)=>{if(String(source)===partial&&String(destination)===target&&!inserted){inserted=true;await writeFile(target,'user-original',{flag:'wx'});}return original(source,destination,...args);};
  fsPromises.rename=race(originalRename);fsPromises.link=race(originalLink);syncBuiltinESMExports();t.after(()=>{fsPromises.rename=originalRename;fsPromises.link=originalLink;syncBuiltinESMExports();});
  resources.install({planId:plan.id});const done=await settled(resources);
  assert.equal(inserted,true);assert.equal(await readFile(target,'utf8'),'user-original');assert.equal(done.task.status,'failed');assert.deepEqual(await readFile(partial),repo.files.get('model.safetensors'));
  const storage=new ResourceStorage({dataDir:resources.dataDir,voiceResources:resources});t.after(()=>storage.close());
  const state=await storage.state();assert.ok(state.resources.length);assert.ok(state.resources.every(item=>!item.managed),'竞争出现的用户文件不能被登记为可删除的安装文件');
});

test('新下载的三类 Qwen 模型可卸载并用原计划重装，Python 与个人资料保留',async t=>{
  for(const [kind,field]of [['base','qwenBasePath'],['custom-voice','qwenCustomVoicePath'],['voice-design','qwenDesignPath']]){
    const {resources,directory}=await fixture(t,{kind});prepare(resources,kind,kind==='voice-design'?'1.7B':'0.6B');const plan=(await settled(resources)).modelPlan;
    resources.install({planId:plan.id});assert.equal((await settled(resources)).task.status,'completed');await resources.configure({[field]:plan.directory});
    const personal=join(directory,'personal.wav'),python=join(directory,'python.exe');await writeFile(personal,'audio');await writeFile(python,'python');
    const storage=new ResourceStorage({dataDir:directory,voiceResources:resources});t.after(()=>storage.close());
    const resource=(await storage.state()).resources.find(item=>item.path===plan.directory);assert.equal(resource?.managed,true);
    const removal=await storage.plan({id:resource.id,action:'uninstall'});await storage.execute({planId:removal.planId,confirmed:true});
    await assert.rejects(access(join(plan.directory,'model.safetensors')));assert.equal(resources.state().config[field],'');assert.equal(resources.state().modelPlan.status,'prepared');
    assert.equal(await readFile(personal,'utf8'),'audio');assert.equal(await readFile(python,'utf8'),'python');
    resources.install({planId:plan.id});assert.equal((await settled(resources)).task.status,'completed');await storage.close();
  }
});

test('失败 Qwen 下载的分片可单独回收，已校验文件保留且原计划仍可重试',async t=>{
  let short=true;const {resources,directory}=await fixture(t,{serveFile:({filename,bytes})=>filename==='model.safetensors'&&short?new Response(bytes.subarray(0,5),{headers:{'content-length':String(bytes.length)}}):undefined});
  prepare(resources);const plan=(await settled(resources)).modelPlan;resources.install({planId:plan.id});assert.equal((await settled(resources)).task.status,'failed');
  const storage=new ResourceStorage({dataDir:directory,voiceResources:resources});t.after(()=>storage.close());
  const cache=(await storage.state()).caches.find(item=>item.path===plan.directory);assert.equal(cache?.managed,true);assert.equal(cache.bytes,5);
  const removal=await storage.plan({id:cache.id,action:'cleanup'});await storage.execute({planId:removal.planId,confirmed:true});
  await assert.rejects(access(join(plan.directory,'model.safetensors.part')));await access(join(plan.directory,'config.json'));
  short=false;resources.install({planId:plan.id});assert.equal((await settled(resources)).task.status,'completed');
});

test('已有 Qwen 下载标记不足以证明存储所有权，旧目录仍只读复用',async t=>{
  const {resources,directory}=await fixture(t);prepare(resources);const plan=(await settled(resources)).modelPlan;
  await mkdir(plan.directory,{recursive:true});await writeFile(join(plan.directory,'.workbench-qwen-model.json'),JSON.stringify({owner:'AI-Future-Workbench/qwen-model',planId:plan.id}));await writeFile(join(plan.directory,'personal.txt'),'keep');
  resources.install({planId:plan.id});assert.equal((await settled(resources)).task.status,'completed');await resources.configure({qwenBasePath:plan.directory});
  const storage=new ResourceStorage({dataDir:directory,voiceResources:resources});t.after(()=>storage.close());
  const resource=(await storage.state()).resources.find(item=>item.path===plan.directory);assert.equal(resource.managed,false);await assert.rejects(storage.plan({id:resource.id,action:'uninstall'}),/归属|受管/);
  await assert.rejects(access(join(plan.directory,'.workbench-storage-owner.json')));assert.equal(await readFile(join(plan.directory,'personal.txt'),'utf8'),'keep');
});
