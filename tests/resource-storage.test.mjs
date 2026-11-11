import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const modulePromise=import('../framework/resource-storage.mjs').catch(()=>({}));
async function fixture(t){
  const api=await modulePromise;assert.equal(typeof api.ResourceStorage,'function','应提供资源存储计划与执行控制器');
  const dataDir=await mkdtemp(join(tmpdir(),'resource-storage-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  const settings=new Map(),store={getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  return {...api,dataDir,store};
}

test('storage reads existing bindings without owning or initializing QQ',async t=>{
  const f=await fixture(t),external=join(f.dataDir,'external');await mkdir(external);await writeFile(join(external,'model'),'user');
  f.store.setSetting('voice.resources',{directory:join(f.dataDir,'voice'),config:{generatorPath:external}});
  let calls=0;const storage=new f.ResourceStorage({...f,qqRuntime:()=>{calls++;return null;}});t.after(()=>storage.close());
  const state=await storage.state(),resource=state.resources.find(item=>item.path===external);
  assert.equal(resource.managed,false);assert.equal(resource.origin,'existing');assert.equal(calls,1);
  await assert.rejects(storage.plan({id:resource.id,action:'uninstall'}),/归属|已有|受管/);
  assert.equal(await readFile(join(external,'model'),'utf8'),'user');
});

test('an empty profile does not present missing default visual paths as reused resources',async t=>{
  const f=await fixture(t),{VisionExtension}=await import('../framework/vision-extension.mjs');
  const vision=new VisionExtension(f);t.after(()=>vision.close());await vision.initialized;
  const storage=new f.ResourceStorage({...f,visionExtension:vision});t.after(()=>storage.close());
  assert.deepEqual((await storage.state()).resources,[]);
});

test('owned resource uninstall requires confirmation and preserves personal data',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'models'),voice=join(f.dataDir,'shared-voice','studio','library');await mkdir(voice,{recursive:true});await writeFile(join(voice,'reference.wav'),'personal');
  const ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'weights.bin'),'weights');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'声音生成模型',family:'voice'});
  const storage=new f.ResourceStorage(f);t.after(()=>storage.close());const state=await storage.state();assert.equal(state.resources[0].managed,true);assert.equal(state.resources[0].bytes,7);
  const plan=await storage.plan({id:'voice-generator',action:'uninstall'});assert.ok(plan.planId);assert.match(plan.consequence,/删除/);
  await assert.rejects(storage.execute({planId:plan.planId}),/确认/);
  const result=await storage.execute({planId:plan.planId,confirmed:true});assert.equal(result.bytes,7);
  await assert.rejects(readFile(join(root,'weights.bin')),{code:'ENOENT'});assert.equal(await readFile(join(voice,'reference.wav'),'utf8'),'personal');
});

test('changed plans and unknown files block deletion',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'models'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'weights.bin'),'weights');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  const storage=new f.ResourceStorage(f);t.after(()=>storage.close());const plan=await storage.plan({id:'voice-generator',action:'uninstall'});
  await writeFile(join(root,'weights.bin'),'changed');await assert.rejects(storage.execute({planId:plan.planId,confirmed:true}),/改变|失效|校验/);
  await writeFile(join(root,'weights.bin'),'weights');await writeFile(join(root,'personal.txt'),'keep');
  await assert.rejects(storage.plan({id:'voice-generator',action:'uninstall'}),/未知|改变|归属/);assert.equal(await readFile(join(root,'personal.txt'),'utf8'),'keep');
});

test('active tasks block resources and cache cleanup; independent controllers share deletion lock',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'cache'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'uv-cache.bin'),'cache');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-uv-cache',name:'UV 缓存',family:'voice',kind:'cache'});
  const voiceResources={state:()=>({task:{status:'running'},config:{}})},storage=new f.ResourceStorage({...f,voiceResources});t.after(()=>storage.close());
  assert.equal((await storage.state()).caches[0].active,true);await assert.rejects(storage.plan({id:'voice-uv-cache',action:'cleanup'}),/运行|使用|任务/);
  voiceResources.state=()=>({config:{}});const plan=await storage.plan({id:'voice-uv-cache',action:'cleanup'});
  const another=new f.ResourceStorage(f);t.after(()=>another.close());
  const lease=f.acquireResourceStorageLease(f.dataDir,'voice');
  try{await assert.rejects(storage.execute({planId:plan.planId,confirmed:true}),/使用|维护/);}finally{lease();}
  await storage.execute({planId:plan.planId,confirmed:true});
  assert.equal((await storage.state()).caches.length,0);
});

test('voice models installed in two directories retain distinct receipts and independent uninstall',async t=>{
  const f=await fixture(t),{VoiceResources}=await import('../framework/voice-resources.mjs'),{createHash}=await import('node:crypto');
  const content=Buffer.from('model'),file={filename:'model.safetensors',url:'https://example.com/model',bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')};
  const voiceResources=new VoiceResources({...f,directory:join(f.dataDir,'voice'),packageSpec:{models:Object.fromEntries(['generator','clone','codec'].map(id=>[id,{directory:id,name:'声音模型',files:[file],downloadBytes:content.length}])),runtime:{}},platform:'win32',arch:'x64',candidates:{},searchRoots:[],fetchImpl:async()=>new Response(content)});t.after(()=>voiceResources.close());
  voiceResources.install({component:'generator'});await voiceResources.job?.promise;
  assert.equal(voiceResources.state().task.status,'completed');const storage=new f.ResourceStorage({...f,voiceResources});t.after(()=>storage.close());
  const first=(await storage.state()).resources.find(item=>item.managed&&item.bytes===5);assert.ok(first);
  await voiceResources.configure({directory:join(f.dataDir,'voice-second'),generatorPath:''});voiceResources.install({component:'generator'});await voiceResources.job?.promise;
  assert.equal(voiceResources.state().task.status,'completed');voiceResources.install({component:'generator'});await voiceResources.job?.promise;
  const state=await storage.state(),models=state.resources.filter(item=>item.managed);assert.equal(models.length,2);assert.equal(new Set(models.map(item=>item.id)).size,2);
  const second=models.find(item=>item.path!==first.path);assert.ok(second);
  for(const model of [first,second]){const plan=await storage.plan({id:model.id,action:'uninstall'});await storage.execute({planId:plan.planId,confirmed:true});await assert.rejects(readFile(join(model.path,file.filename)));if(model===first){assert.equal(await readFile(join(second.path,file.filename),'utf8'),'model');assert.equal(voiceResources.state().config.generatorPath,second.path);}}
  assert.equal((await storage.state()).resources.length,0);
});

test('links and root ownership from a different profile cannot be adopted',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'models'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'weights.bin'),'weights');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  const other=join(f.dataDir,'other');await mkdir(other);assert.equal(await f.beginManagedRoot({dataDir:other,root}),null);
  const target=join(f.dataDir,'external');await mkdir(target);await writeFile(join(target,'personal'),'keep');
  await symlink(target,join(root,'linked'),process.platform==='win32'?'junction':'dir');
  const storage=new f.ResourceStorage(f);t.after(()=>storage.close());await assert.rejects(storage.plan({id:'voice-generator',action:'uninstall'}),/链接|联接|未知/);
  assert.equal(await readFile(join(target,'personal'),'utf8'),'keep');
});

test('cross-process worker leases prevent destructive plans and release on process exit',async t=>{
  const f=await fixture(t),{spawn}=await import('node:child_process'),{once}=await import('node:events');
  const root=join(f.dataDir,'models'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'weights.bin'),'weights');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  const moduleUrl=new URL('../framework/resource-storage.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireResourceStorageLease} from ${JSON.stringify(moduleUrl)};acquireResourceStorageLease(${JSON.stringify(f.dataDir)},'voice');process.stdout.write('ready\\n');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','ignore'],windowsHide:true});
  t.after(()=>child.kill());await once(child.stdout,'data');const storage=new f.ResourceStorage(f);t.after(()=>storage.close());
  await assert.rejects(storage.plan({id:'voice-generator',action:'uninstall'}),/使用|维护/);
  child.kill();await once(child,'exit');assert.ok((await storage.plan({id:'voice-generator',action:'uninstall'})).planId);
});

test('a family reader lease blocks destructive plans even without a live controller',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'vision'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'runtime.exe'),'runtime');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'vision-runtime',name:'视觉运行器',family:'vision'});
  const storage=new f.ResourceStorage(f);t.after(()=>storage.close());const release=f.acquireResourceStorageLease(f.dataDir,'vision');
  try{await assert.rejects(storage.plan({id:'vision-runtime',action:'uninstall'}),/使用|维护/);}finally{release();}
});

test('VoiceStudio holds a shared storage lease while queued work executes',async t=>{
  const f=await fixture(t),{VoiceStudio}=await import('../framework/voice-studio.mjs');let entered,finish;
  const started=new Promise(done=>{entered=done;}),gate=new Promise(done=>{finish=done;});
  const studio=new VoiceStudio({dataDir:f.dataDir,resources:{state:()=>({config:{}})}});t.after(()=>studio.close());
  const task=studio.exclusive(async()=>{entered();await gate;},new AbortController().signal);await started;
  try{assert.throws(()=>f.acquireResourceStorageLease(f.dataDir,'voice',{exclusive:true}),/使用|维护/);}finally{finish();await task;}
});

test('new QQ install ownership supports uninstall without touching account directories',async t=>{
  const f=await fixture(t),{QQRuntime}=await import('../framework/qq-runtime.mjs'),{createHash}=await import('node:crypto'),content=Buffer.from('zip');
  const runtime=new QQRuntime({...f,dataDir:join(f.dataDir,'instances','instance-one'),storageDataDir:f.dataDir,packageSpec:{version:'test',url:'https://example.com/qq.zip',sha256:createHash('sha256').update(content).digest('hex'),downloadBytes:content.length},processHost:{recover:async()=>null,close:async()=>{}},fetchImpl:async()=>new Response(content),extractImpl:async(_archive,destination)=>{await mkdir(join(destination,'napcat'));for(const path of ['node.exe','index.js','wrapper.node','QQNT.dll','napcat/napcat.mjs'])await writeFile(join(destination,path),'code');}});t.after(()=>runtime.close());
  await runtime.install({directory:join(f.dataDir,'qq-install')});const storage=new f.ResourceStorage({...f,qqRuntime:()=>runtime});t.after(()=>storage.close());
  const resource=(await storage.state()).resources.find(item=>item.family==='qq');assert.equal(resource.managed,true);
  const personal=join(runtime.slot,'personal.json');await writeFile(personal,'account');
  const plan=await storage.plan({id:resource.id,action:'uninstall'});await storage.execute({planId:plan.planId,confirmed:true});
  assert.equal(await readFile(personal,'utf8'),'account');await runtime.install({directory:join(f.dataDir,'qq-install')});
  assert.equal(runtime.state().installation.status,'ready');
});

test('all live QQ instances and detached instance records block shared resource deletion',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'qq-install'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'runtime.exe'),'runtime');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'qq-runtime',name:'QQ',family:'qq'});
  let running=true;const storage=new f.ResourceStorage({...f,qqRuntime:()=>[{state:()=>({running:false})},{state:()=>({running})}]});t.after(()=>storage.close());
  assert.equal((await storage.state()).resources[0].active,true);
  await assert.rejects(storage.plan({id:'qq-runtime',action:'uninstall'}),/运行|使用|任务/);
  running=false;const slot=join(f.dataDir,'instances','instance-one','qq','accounts','account-one');await mkdir(slot,{recursive:true});
  await writeFile(join(slot,'process.json'),JSON.stringify({pid:process.pid}));
  await assert.rejects(storage.plan({id:'qq-runtime',action:'uninstall'}),/运行|使用|任务/);
  await writeFile(join(slot,'process.json'),'{}');
  await assert.rejects(storage.plan({id:'qq-runtime',action:'uninstall'}),/运行|使用|任务/);
});

test('a same-size user modification is not silently adopted by a later installation',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'models'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'weights.bin'),'weights');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  await writeFile(join(root,'weights.bin'),'changed');
  assert.equal(await f.beginManagedRoot({dataDir:f.dataDir,root}),null);
});

test('cleaning model download fragments preserves the installed model binding',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'model'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});
  await writeFile(join(root,'model.bin'),'model');await writeFile(join(root,'model.bin.part'),'part');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice',select:path=>path==='model.bin'});
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator-parts',name:'下载分片',family:'voice',kind:'cache',select:path=>path==='model.bin.part'});
  const voiceResources={record:{config:{generatorPath:root},bindings:{generatorPath:{status:'available'}}},installed:{generator:true},persist(){},state(){return this.record;}};
  const storage=new f.ResourceStorage({...f,voiceResources});t.after(()=>storage.close());
  const plan=await storage.plan({id:'voice-generator-parts',action:'cleanup'});await storage.execute({planId:plan.planId,confirmed:true});
  assert.equal(voiceResources.record.config.generatorPath,root);assert.equal(voiceResources.installed.generator,true);
  assert.equal(await readFile(join(root,'model.bin'),'utf8'),'model');
});

test('an instance QQ launch holds the root storage lease before the daemon record exists',async t=>{
  const f=await fixture(t),{QQRuntime}=await import('../framework/qq-runtime.mjs');
  const runtime=new QQRuntime({dataDir:join(f.dataDir,'instances','launching'),storageDataDir:f.dataDir,processHost:{recover:async()=>null,close:async()=>{}}});t.after(()=>runtime.close());
  let enter,finish;const entered=new Promise(done=>{enter=done;}),gate=new Promise(done=>{finish=done;});
  runtime.launch=async()=>{enter();await gate;};const started=runtime.startLogin();await entered;
  try{assert.throws(()=>f.acquireResourceStorageLease(f.dataDir,'qq',{exclusive:true}),/使用|维护/);}finally{finish();await started;}
  f.acquireResourceStorageLease(f.dataDir,'qq',{exclusive:true})();
});

test('visual components and caches in two directories remain separately reclaimable and retry is idempotent',async t=>{
  const f=await fixture(t),{VisionExtension}=await import('../framework/vision-extension.mjs'),{createHash}=await import('node:crypto'),content=Buffer.from('fixture');
  const files=['model','projector','runtime'].map(id=>({id,filename:id==='runtime'?'runtime.zip':id+'.gguf',url:'https://example.com/'+id,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')}));
  const packageSpec={id:'vision-fixture',name:'视觉',files,runtime:{directory:'runtime',executable:'llama-server.exe',requiredFiles:['llama-server.exe'],unpackedBytes:8},requirements:[],links:[],downloadBytes:21,installedBytes:29,peakDiskBytes:29};
  const vision=new VisionExtension({...f,packageSpec,platform:'win32',arch:'x64',fetchImpl:async()=>new Response(content),extractImpl:async({destination})=>{await mkdir(destination);await writeFile(join(destination,'llama-server.exe'),'runtime');}});t.after(()=>vision.close());
  vision.install({});await vision.waitForIdle();assert.equal(vision.state().task.status,'completed',vision.state().task.error);
  const storage=new f.ResourceStorage({...f,visionExtension:vision});t.after(()=>storage.close());const state=await storage.state();
  assert.ok(state.resources.some(item=>item.id.startsWith('vision-runtime')&&item.managed));assert.ok(state.caches.some(item=>item.family==='vision'&&item.bytes===7));
  const firstRoot=state.resources[0].path;vision.choose=async()=>join(f.dataDir,'visual-second');await vision.chooseDirectory({});
  for(let attempt=0;attempt<2;attempt++){vision.install({});await vision.waitForIdle();assert.equal(vision.state().task.status,'completed',vision.state().task.error);}
  const both=await storage.state();assert.equal(both.resources.length,6);assert.equal(both.caches.length,2);assert.equal(new Set([...both.resources,...both.caches].map(item=>item.id)).size,8);
  const secondRoot=both.resources.find(item=>item.path!==firstRoot).path;
  for(const root of [firstRoot,secondRoot]){for(const item of [...both.caches,...both.resources].filter(item=>item.path===root)){assert.equal(item.managed,true);const plan=await storage.plan({id:item.id,action:item.kind==='cache'?'cleanup':'uninstall'});await storage.execute({planId:plan.planId,confirmed:true});}await assert.rejects(readFile(join(root,'model.gguf')));if(root===firstRoot)assert.deepEqual(await readFile(join(secondRoot,'model.gguf')),content);}
  assert.deepEqual(await storage.state(),{resources:[],caches:[]});
});

test('managed UV caches in two installation directories retain both Python environments and external tools',async t=>{
  const f=await fixture(t),{VoiceResources}=await import('../framework/voice-resources.mjs');
  const uv=join(f.dataDir,'external-uv.exe');await writeFile(uv,'tool');
  const packageSpec={models:Object.fromEntries(['generator','clone','codec'].map(id=>[id,{name:id}])),runtime:{directory:'runtime',name:'Python',pythonVersion:'3.12.13',uv:{version:'0.10.12'},torchPackages:[],packages:[]}};
  const resources=new VoiceResources({...f,packageSpec,platform:'win32',arch:'x64',candidates:{uvPath:[uv]},searchRoots:[],runtimeProbeImpl:async()=>true,runCommandImpl:async(_executable,args,options)=>{
    if(args[0]==='--version')return {stdout:'uv 0.10.12'};
    if(args[0]==='python'&&args[1]==='find')return {stdout:join(f.dataDir,'base-python.exe')};
    if(args[0]==='venv'){await mkdir(join(args.at(-1),'Scripts'),{recursive:true});await writeFile(join(args.at(-1),'Scripts','python.exe'),'python');}
    if(args[0]==='pip'){await mkdir(options.env.UV_CACHE_DIR,{recursive:true});await writeFile(join(options.env.UV_CACHE_DIR,'wheel.bin'),'cache');}
    return {stdout:args.includes('-c')?'{"pythonReady":true}':''};
  }});t.after(()=>resources.close());resources.install({component:'runtime'});await resources.job?.promise;assert.equal(resources.state().task.status,'completed',resources.state().task.error);
  const storage=new f.ResourceStorage({...f,voiceResources:resources});t.after(()=>storage.close());
  const firstPython=resources.state().config.pythonPath;await resources.configure({directory:join(f.dataDir,'voice-second'),pythonPath:''});resources.install({component:'runtime'});await resources.job?.promise;assert.equal(resources.state().task.status,'completed',resources.state().task.error);
  const secondPython=resources.state().config.pythonPath,caches=(await storage.state()).caches.filter(item=>item.id.startsWith('voice-runtime-cache'));assert.equal(caches.length,2);assert.equal(new Set(caches.map(item=>item.id)).size,2);
  for(const cache of caches){assert.equal(cache.managed,true);const plan=await storage.plan({id:cache.id,action:'cleanup'});await storage.execute({planId:plan.planId,confirmed:true});}
  for(const python of [firstPython,secondPython])assert.equal(await readFile(python,'utf8'),'python');assert.equal(await readFile(uv,'utf8'),'tool');assert.equal((await storage.state()).caches.length,0);
});

test('close waits for an executing removal before callers may close its store',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'model'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'model.bin'),'model');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  let enter,finish,persisted=false,closed=false;const entered=new Promise(done=>{enter=done;}),gate=new Promise(done=>{finish=done;});
  const voiceResources={record:{config:{generatorPath:root},bindings:{}},installed:{generator:true},state(){return this.record;},persist(){assert.equal(closed,false);persisted=true;},async acquireLock(){enter();await gate;return ()=>{};}};
  const storage=new f.ResourceStorage({...f,voiceResources}),plan=await storage.plan({id:'voice-generator',action:'uninstall'});
  const execution=storage.execute({planId:plan.planId,confirmed:true});await entered;
  const closing=Promise.resolve(storage.close()).then(()=>{closed=true;});await new Promise(done=>setImmediate(done));
  try{assert.equal(closed,false,'close 应等待删除及其持久化完成');await assert.rejects(storage.plan({id:'voice-generator',action:'uninstall'}),/关闭/);}finally{finish();await execution;await closing;}
  assert.equal(persisted,true);assert.equal(closed,true);await storage.close();
});

test('close waits for a pending plan and clears plans created during shutdown',async t=>{
  const f=await fixture(t),root=join(f.dataDir,'model'),ownership=await f.beginManagedRoot({dataDir:f.dataDir,root});await writeFile(join(root,'model.bin'),'model');
  await f.recordManagedTree({dataDir:f.dataDir,ownership,id:'voice-generator',name:'模型',family:'voice'});
  const storage=new f.ResourceStorage(f),original=storage.checked.bind(storage);let enter,finish,closed=false;
  const entered=new Promise(done=>{enter=done;}),gate=new Promise(done=>{finish=done;});storage.checked=async(...args)=>{enter();await gate;return original(...args);};
  const planning=storage.plan({id:'voice-generator',action:'uninstall'});await entered;const closing=Promise.resolve(storage.close()).then(()=>{closed=true;});await new Promise(done=>setImmediate(done));
  try{assert.equal(closed,false);}finally{finish();await planning;await closing;}
  assert.equal(storage.plans.size,0);assert.equal(await readFile(join(root,'model.bin'),'utf8'),'model');
});
