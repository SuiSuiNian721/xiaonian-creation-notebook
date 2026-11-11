import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsPromises, { mkdtemp, mkdir, open, readFile, readdir, writeFile, rm, access } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { VoiceResources } from '../framework/voice-resources.mjs';
import { VOICE_PACKAGE } from '../framework/voice-package.mjs';

const content = Buffer.from('voice-model-fixture');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const file = { filename:'model.safetensors',url:'https://huggingface.co/OpenMOSS-Team/test/resolve/'+'a'.repeat(40)+'/model.safetensors',bytes:content.length,sha256:sha256(content) };
const packageSpec = {
  models:Object.fromEntries(['generator','clone','codec'].map(id => [id,{id,name:id,directory:id,files:[file],downloadBytes:file.bytes}])),
  runtime:{name:'Python 3.12 + MOSS',pythonVersion:'3.12.13',directory:'runtime',downloadBytes:null,
    uv:{version:'0.10.12',filename:'uv.zip',url:'https://github.com/astral-sh/uv/releases/download/0.10.12/uv.zip',bytes:content.length,sha256:sha256(content),unpackedBytes:40,executable:'uv.exe',
      executableFile:{filename:'uv.exe',bytes:4,sha256:sha256('tool')}},
    packages:['soundfile==0.14.0'],torchPackages:['torch==2.9.1+cu128','torchaudio==2.9.1+cu128']},
};

async function setup(t, extra={}) {
  assert.equal(typeof VoiceResources,'function','声音组件控制器应提供 VoiceResources');
  const directory=await mkdtemp(join(tmpdir(),'voice-resources-'));
  const settings=new Map();
  const store={getSetting:key=>structuredClone(settings.get(key)),setSetting:(key,value)=>settings.set(key,structuredClone(value))};
  const controller=new VoiceResources({store,dataDir:directory,directory:join(directory,'shared'),packageSpec,
    platform:'win32',arch:'x64',searchRoots:[],candidates:{pythonPath:[],generatorPath:[],clonePath:[],codecPath:[],uvPath:[]},...extra});
  t.after(async()=>{await controller.close();await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
  await controller.initialized;
  return {controller,directory,settings,store};
}

async function settled(controller) {
  for(let i=0;i<200&&controller.state().task?.status==='running';i++)await delay(5);
  assert.notEqual(controller.state().task?.status,'running','后台安装应结束');
  await controller.job?.promise;
  return controller.state();
}

async function externalMossModel(path,kind,bytes=Buffer.from('external-revision')) {
  const config=kind==='codec'?{model_type:'moss-audio-tokenizer',architectures:['MossAudioTokenizerModel']}:
    {model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],n_vq:16,
      ...(kind==='generator'?{gen_token_id:151656,audio_ch0_vocab_size:1024}:{local_hidden_size:1024,local_num_layers:8})};
  await mkdir(path,{recursive:true});await writeFile(join(path,'config.json'),JSON.stringify(config));await writeFile(join(path,file.filename),bytes);return path;
}

async function externalMossEnvironment(root) {
  const python=join(root,'Scripts','python.exe');await mkdir(join(root,'Scripts'),{recursive:true});await writeFile(python,'external-python');
  for(const [name,version] of Object.entries({transformers:'5.1.0',torch:'2.10.0',torchaudio:'2.10.0',soundfile:'0.14.0',scipy:'1.16.2'})){
    const path=join(root,'Lib','site-packages',`${name}-${version}.dist-info`);await mkdir(path,{recursive:true});await writeFile(join(path,'METADATA'),`Name: ${name}\nVersion: ${version}\n`);
  }
  return python;
}

test('component sources expose fixed official repositories without querying the network',async t=>{
  const {controller}=await setup(t,{packageSpec:VOICE_PACKAGE,fetchImpl:async()=>assert.fail('state must remain offline')});
  for(const id of ['generator','clone','codec']){
    const component=controller.state().components.find(item=>item.id===id),model=VOICE_PACKAGE.models[id];
    assert.equal(component.repository,model.repository);assert.equal(component.revision,model.revision);
    assert.equal(component.sourceUrl,`https://huggingface.co/${model.repository}/tree/${model.revision}`);
  }
  const runtime=controller.state().components.find(item=>item.id==='runtime');
  assert.equal(runtime.repository,null);assert.equal(runtime.revision,null);
  assert.equal(runtime.sourceUrl,`https://github.com/astral-sh/uv/releases/tag/${VOICE_PACKAGE.runtime.uv.version}`);
});

for(const kind of ['clone','generator']){
  test(`${kind} required bundle preserves valid external bindings from another revision`,async t=>{
    const {controller,directory}=await setup(t,{fetchImpl:async()=>assert.fail('bound external resources must be reused'),runCommandImpl:async()=>assert.fail('reuse must not execute Python')});
    const config={pythonPath:await externalMossEnvironment(join(directory,'external-env')),
      codecPath:await externalMossModel(join(directory,'external-codec'),'codec'),
      [kind+'Path']:await externalMossModel(join(directory,'external-'+kind),kind)};
    await controller.configure(config);const initial=controller.install({component:kind+'-required'});assert.equal(initial.task.totalBytes,null);
    const done=await settled(controller);assert.equal(done.task.status,'completed');assert.equal(done.task.component,kind+'-required');
    for(const [key,path] of Object.entries(config))assert.equal(done.config[key],path);
    assert.ok(done.components.filter(item=>['runtime','codec',kind].includes(item.id)).every(item=>item.ready));
    await assert.rejects(access(join(done.directory,'components',kind)));
  });

  test(`${kind} required bundle downloads only its missing model and keeps the other feature binding`,async t=>{
    const downloaded=[];let controller;
    const fixture=await setup(t,{fetchImpl:async()=>{downloaded.push(controller.state().task.component);return new Response(content);},runCommandImpl:async()=>assert.fail('the existing environment must be reused')});
    controller=fixture.controller;const directory=fixture.directory,other=kind==='clone'?'generator':'clone';
    const config={pythonPath:await externalMossEnvironment(join(directory,'external-env')),codecPath:await externalMossModel(join(directory,'external-codec'),'codec'),
      [other+'Path']:await externalMossModel(join(directory,'external-'+other),other)};
    await controller.configure(config);controller.install({component:kind+'-required'});
    const done=await settled(controller);assert.equal(done.task.status,'completed');assert.deepEqual(downloaded,[kind]);
    for(const [key,path] of Object.entries(config))assert.equal(done.config[key],path);
    assert.deepEqual(await readFile(join(done.config[kind+'Path'],file.filename)),content);
    await assert.rejects(access(join(done.directory,'components',other)));
    assert.throws(()=>controller.install({component:kind+'-required',components:['runtime',kind]}),/字段|不支持/);
  });
}

test('required bundles keep full hash verification for managed models, including previous roots',async t=>{
  for(const previousRoot of [false,true]){
    let fetched=0;const {controller,directory}=await setup(t,{fetchImpl:async()=>{fetched++;return new Response(content);}});
    const target=previousRoot?join(directory,'previous-managed-model'):join(controller.state().directory,'components','clone');
    await externalMossModel(target,'clone',Buffer.alloc(content.length,99));
    if(previousRoot)await writeFile(join(target,'.workbench-storage-owner.json'),'{}');
    await controller.configure({pythonPath:await externalMossEnvironment(join(directory,'external-env')),codecPath:await externalMossModel(join(directory,'external-codec'),'codec'),clonePath:target});
    controller.install({component:'clone-required'});const done=await settled(controller);
    assert.equal(done.task.status,previousRoot?'completed':'failed');assert.equal(fetched,previousRoot?1:0);
    if(previousRoot)assert.notEqual(done.config.clonePath,target);
    else {
      const component=done.components.find(item=>item.id==='clone');
      assert.equal(component.installed,false);assert.equal(component.ready,false);
      assert.equal(done.bindings.clonePath.status,'available','retain the previous binding metadata without treating it as ready');
      assert.equal(done.config.clonePath,target);
    }
    assert.deepEqual(await readFile(join(target,file.filename)),Buffer.alloc(content.length,99));
  }
});

test('required bundles do not metadata-reuse a managed environment from a previous root',async t=>{
  const probes=[];let runtimeDownload=false;
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{probes.push(path);return false;},
    fetchImpl:async()=>{runtimeDownload=true;throw new Error('test stops before installing a replacement environment');}});
  const root=join(directory,'previous-environment'),python=await externalMossEnvironment(root);
  await writeFile(join(root,'voice-venv-owner.json'),'{}');await controller.configure({pythonPath:python});
  controller.install({component:'clone-required'});const done=await settled(controller);
  assert.ok(probes.includes(python));assert.equal(runtimeDownload,true);assert.equal(done.task.status,'failed');
  assert.equal(done.components.find(item=>item.id==='runtime').installed,false);assert.equal(done.config.pythonPath,python);
  assert.equal(await readFile(python,'utf8'),'external-python');
});

for(const interruption of ['cancelled','interrupted'])test(`required bundle ${interruption} retains the model partial and resumes only the missing bytes`,async t=>{
  let started;const downloading=new Promise(resolve=>{started=resolve;});let calls=0;
  const fetchImpl=async(_url,options)=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({
      start(stream){stream.enqueue(content.subarray(0,5));},
      pull(){started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));},
    }),{headers:{'content-length':String(content.length)}});
    assert.equal(options.headers.Range,'bytes=5-');
    return new Response(content.subarray(5),{status:206,headers:{'content-length':String(content.length-5),'content-range':`bytes 5-${content.length-1}/${content.length}`}});
  };
  const fixture=await setup(t,{fetchImpl}),{directory,store}=fixture;let controller=fixture.controller;
  const target=join(controller.state().directory,'components','clone');
  await controller.configure({pythonPath:await externalMossEnvironment(join(directory,'external-env')),codecPath:await externalMossModel(join(directory,'external-codec'),'codec'),
    clonePath:await externalMossModel(target,'clone',content)});
  assert.equal(controller.state().components.find(item=>item.id==='clone').ready,true);
  await rm(join(target,file.filename));
  controller.install({component:'clone-required'});await downloading;
  for(let i=0;i<50&&controller.state().task.completedBytes<file.bytes+5;i++)await delay(1);
  assert.equal(controller.state().components.find(item=>item.id==='clone').ready,false);
  if(interruption==='cancelled')await controller.cancel();else await controller.close();
  const cancelled=controller.state();assert.equal(cancelled.task.status,interruption);
  assert.equal(cancelled.components.find(item=>item.id==='clone').installed,false);
  assert.equal(cancelled.components.find(item=>item.id==='clone').ready,false);
  assert.equal(cancelled.bindings.clonePath.status,'available');assert.equal(cancelled.config.clonePath,target);
  assert.equal((await readFile(join(cancelled.directory,'components','clone',file.filename+'.part'))).length,5);
  if(interruption==='interrupted'){
    controller=new VoiceResources({store,dataDir:directory,directory:cancelled.directory,packageSpec,platform:'win32',arch:'x64',searchRoots:[],candidates:{},fetchImpl});
    const reopened=controller;t.after(()=>reopened.close());await reopened.initialized;
    assert.equal(controller.state().components.find(item=>item.id==='clone').ready,false);
  }
  controller.install({component:'clone-required'});const done=await settled(controller);
  assert.equal(done.task.status,'completed');assert.equal(done.task.component,'clone-required');assert.equal(calls,2);
  assert.equal(done.components.find(item=>item.id==='clone').ready,true);
  assert.equal(done.config.generatorPath,'');
});

test('empty resources have independent components and reject URL or unknown configuration',async t=>{
  const {controller}=await setup(t);
  const state=controller.state();
  assert.equal(state.task,null);
  assert.deepEqual(state.components.map(item=>item.id),['runtime','generator','clone','codec']);
  assert.ok(state.components.every(item=>!item.installed));
  await assert.rejects(controller.configure({generatorPath:'https://example.com/model'}),/绝对路径|本地/);
  await assert.rejects(controller.configure({url:'https://example.com/model'}),/不支持|字段/);
  assert.throws(()=>controller.install({component:'generator',url:'https://example.com'}),/字段|不支持/);
  assert.throws(()=>controller.install({component:'arbitrary'}),/组件/);
});

test('install returns immediately, verifies bytes and configures only the installed component',async t=>{
  let calls=0;
  const {controller}=await setup(t,{fetchImpl:async url=>{calls++;assert.equal(url,file.url);await delay(10);return new Response(content,{headers:{'content-length':String(content.length)}});}});
  const state=controller.install({component:'generator'});
  assert.equal(state.task.status,'running');
  assert.equal(state.components.find(item=>item.id==='generator').installed,false);
  const done=await settled(controller);
  assert.equal(done.task.status,'completed');
  assert.equal(done.task.completedBytes,content.length);
  assert.equal(done.task.totalBytes,content.length);
  assert.equal(done.config.clonePath,'');
  assert.deepEqual(await readFile(join(done.config.generatorPath,file.filename)),content);
  controller.install({component:'generator'});await settled(controller);
  assert.equal(calls,1);
});

test('bad SHA256 does not configure the model and keeps existing user files',async t=>{
  const {controller}=await setup(t,{fetchImpl:async()=>new Response(Buffer.alloc(content.length),{headers:{'content-length':String(content.length)}})});
  controller.install({component:'clone'});
  const done=await settled(controller);
  assert.equal(done.task.status,'failed');assert.match(done.task.error,/SHA256/);
  assert.equal(done.config.clonePath,'');
  const target=join(done.directory,'components','clone',file.filename);
  await writeFile(target,'original-user-file');
  controller.install({component:'clone'});const failed=await settled(controller);
  assert.equal(failed.task.status,'failed');
  assert.equal(await readFile(target,'utf8'),'original-user-file');
});

test('discovery caches candidates and only manual binding changes configured paths',async t=>{
  const {controller,directory,settings}=await setup(t);
  const existing=join(directory,'external');await mkdir(existing);
  await writeFile(join(existing,file.filename),'incomplete');
  controller.candidates.generatorPath=[existing];
  await controller.detect();assert.equal(controller.state().config.generatorPath,'');
  await writeFile(join(existing,file.filename),content);await writeFile(join(existing,'config.json'),JSON.stringify({model_type:'moss_tts_delay',architectures:['MossTTSDelayModel'],gen_token_id:151656,audio_ch0_vocab_size:1024,n_vq:16}));
  await controller.detect({refresh:true});assert.equal(controller.state().config.generatorPath,'');
  await controller.configure({generatorPath:existing});
  assert.equal(controller.state().config.generatorPath,existing);
  assert.equal(settings.get('voice.resources').config.generatorPath,existing);
  await rm(join(existing,file.filename));
  assert.equal(controller.state().components.find(item=>item.id==='generator').installed,true);
  await controller.detect({refresh:true});
  assert.equal(controller.state().components.find(item=>item.id==='generator').installed,false);
});

test('configure validates the complete component before changing any saved field',async t=>{
  const {controller,directory}=await setup(t);
  const existing=join(directory,'external');await mkdir(existing);await writeFile(join(existing,file.filename),content);
  await controller.configure({generatorPath:existing});
  await assert.rejects(controller.configure({generatorPath:existing,clonePath:join(directory,'missing')}),/不完整|校验|不存在/);
  assert.equal(controller.state().config.clonePath,'');
  await controller.configure({generatorPath:''});assert.equal(controller.state().config.generatorPath,'');
});

test('cancel preserves partial files and retry sends a range request',async t=>{
  let downloading;
  const started=new Promise(resolve=>{downloading=resolve;});let calls=0;
  const {controller}=await setup(t,{fetchImpl:async(_url,options)=>{
    calls++;
    if(calls===1)return new Response(new ReadableStream({
      start(stream){stream.enqueue(content.subarray(0,5));},
      pull(){downloading();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));},
    }),{headers:{'content-length':String(content.length)}});
    assert.equal(options.headers.Range,'bytes=5-');
    return new Response(content.subarray(5),{status:206,headers:{'content-length':String(content.length-5),'content-range':`bytes 5-${content.length-1}/${content.length}`}});
  }});
  controller.install({component:'codec'});await started;
  for(let i=0;i<50&&controller.state().task.completedBytes<5;i++)await delay(1);
  const cancelled=await controller.cancel();assert.equal(cancelled.task.status,'cancelled');
  const partial=join(cancelled.directory,'components','codec',file.filename+'.part');
  assert.equal((await readFile(partial)).length,5);
  controller.install({component:'codec'});const done=await settled(controller);
  assert.equal(done.task.status,'completed');assert.equal(calls,2);
});

test('runtime installation uses managed Python, pinned dependencies and no model service',async t=>{
  const commands=[];
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    runCommandImpl:async(executable,args,options)=>{
      commands.push({executable,args,env:options.env});
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){
        const root=args.at(-1);await mkdir(join(root,'Scripts'),{recursive:true});await writeFile(join(root,'Scripts','python.exe'),'fixture');
      }
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});const done=await settled(controller);
  assert.equal(done.task.status,'completed');
  assert.equal(done.task.totalBytes,null);
  assert.equal(done.components.find(item=>item.id==='runtime').installed,true);
  assert.ok(commands.some(item=>item.args.slice(0,3).join(' ')==='python install 3.12.13'));
  const pythonInstall=commands.find(item=>item.args[0]==='python'&&item.args[1]==='install');
  assert.ok(pythonInstall.args.includes('--no-bin'));
  assert.ok(pythonInstall.args.includes('--no-registry'),'私有 Python 不能登记 Windows 全局发现状态');
  const installers=commands.filter(item=>item.args[0]==='pip');
  assert.equal(installers.length,2);
  assert.ok(installers.every(item=>item.args.includes('--no-deps')));
  assert.ok(installers.some(item=>item.args.includes('torch==2.9.1+cu128')));
  assert.ok(installers.some(item=>item.args.includes('soundfile==0.14.0')));
  assert.ok(commands.every(item=>!item.args.some(arg=>/serve|launch|moss-tts/.test(arg))));
});

test('close cancels owned work and never executes a global process termination',async t=>{
  let started;const ready=new Promise(resolve=>{started=resolve;});const commands=[];
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async()=>false,runCommandImpl:async(executable,args,{signal})=>{
    commands.push({executable,args});if(args[0]==='--version')return {stdout:'uv 0.10.12'};
    started();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});await ready;await controller.close();
  assert.equal(controller.state().task.status,'interrupted');
  assert.ok(commands.every(item=>!['taskkill','Stop-Process'].includes(item.executable)));
  assert.throws(()=>controller.install({component:'runtime'}),/关闭/);
});

test('the complete fixed file list is checked, including same-length corrupt files',async t=>{
  const metadata=Buffer.from('{}');const configFile={...file,filename:'config.json',bytes:metadata.length,sha256:sha256(metadata)};
  const custom=structuredClone(packageSpec);custom.models.generator.files=[file,configFile];
  const {controller,directory}=await setup(t,{packageSpec:custom});
  const existing=join(directory,'existing');await mkdir(existing);await writeFile(join(existing,file.filename),content);
  const signal=new AbortController().signal;
  assert.equal(await controller.verifyModel('generator',existing,signal),false);
  await writeFile(join(existing,'config.json'),'[]');
  assert.equal(await controller.verifyModel('generator',existing,signal),false);
  await writeFile(join(existing,'config.json'),metadata);
  assert.equal(await controller.verifyModel('generator',existing,signal),true);
});

test('shared component directories serialize installations across workbench instances',async t=>{
  let releaseDownload;let entered;const started=new Promise(resolve=>{entered=resolve;});
  const {controller,directory}=await setup(t,{fetchImpl:async()=>{
    entered();await new Promise(resolve=>{releaseDownload=resolve;});return new Response(content);
  }});
  const peer=new VoiceResources({store:{getSetting:()=>undefined,setSetting:()=>{}},dataDir:directory,directory:controller.state().directory,
    packageSpec,platform:'win32',arch:'x64',candidates:{},fetchImpl:async()=>{throw new Error('peer must not download while locked');}});
  t.after(()=>peer.close());await peer.initialized;
  controller.install({component:'generator'});await started;
  peer.install({component:'generator'});const blocked=await settled(peer);
  assert.equal(blocked.task.status,'failed');assert.match(blocked.task.error,/另一个工作台/);
  releaseDownload();await settled(controller);
  peer.install({component:'generator'});const complete=await settled(peer);
  assert.equal(complete.task.status,'completed');assert.equal(complete.config.generatorPath,controller.state().config.generatorPath);
});

test('a missing uv tool is downloaded, verified and extracted within the owned runtime',async t=>{
  const commands=[];const extractions=[];
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    fetchImpl:async url=>{assert.equal(url,packageSpec.runtime.uv.url);return new Response(content);},
    extractImpl:async options=>{extractions.push(options);await mkdir(options.destination);await writeFile(join(options.destination,'uv.exe'),'tool');},
    runCommandImpl:async(executable,args)=>{
      commands.push({executable,args});
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){await mkdir(join(args.at(-1),'Scripts'),{recursive:true});await writeFile(join(args.at(-1),'Scripts','python.exe'),'python');}
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  controller.install({component:'runtime'});const done=await settled(controller);
  assert.equal(done.task.status,'completed');assert.equal(extractions.length,1);
  assert.equal(extractions[0].unpackedBytes,packageSpec.runtime.uv.unpackedBytes);
  assert.ok(extractions[0].destination.startsWith(join(done.directory,'components','runtime')));
  assert.ok(commands.every(command=>command.executable.startsWith(done.directory)));
});

test('an unknown runtime directory is preserved and never passed to uv',async t=>{
  const {controller}=await setup(t,{runCommandImpl:async()=>{assert.fail('must not execute uv');}});
  const root=join(controller.state().directory,'components','runtime');await mkdir(root,{recursive:true});await writeFile(join(root,'note.txt'),'keep');
  controller.install({component:'runtime'});const done=await settled(controller);
  assert.equal(done.task.status,'failed');assert.match(done.task.error,/已有其他文件/);
  assert.equal(await readFile(join(root,'note.txt'),'utf8'),'keep');
});

test('the extracted uv executable must match its own fixed hash',async t=>{
  const {controller}=await setup(t,{fetchImpl:async()=>new Response(content),
    extractImpl:async({destination})=>{await mkdir(destination);await writeFile(join(destination,'uv.exe'),'evil');},
    runCommandImpl:async()=>{assert.fail('unverified uv must not execute');}});
  controller.install({component:'runtime'});const done=await settled(controller);
  assert.equal(done.task.status,'failed');assert.match(done.task.error,/uv.*校验|校验.*uv/i);
});

test('cancelling a spawned installer terminates only the child started by this controller',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});const killed=[];const spawned=[];
  const {controller,directory}=await setup(t,{spawnImpl:(executable,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();spawned.push({executable,args,options});
    child.kill=signal=>{killed.push({child,signal});queueMicrotask(()=>child.emit('close',null));};
    if(args[0]==='--version')queueMicrotask(()=>{child.stdout.write('uv 0.10.12');child.emit('close',0);});else entered();
    return child;
  }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});await started;await controller.cancel();
  assert.equal(controller.state().task.status,'cancelled');assert.equal(killed.length,1);
  assert.ok(spawned.every(item=>item.executable===uv));assert.ok(spawned.every(item=>item.options.shell===false&&item.options.windowsHide));
  assert.ok(spawned.every(item=>!item.options.signal),'由控制器等到子进程 close 后结束任务，避免自动 abort 过早完成 Promise');
});

test('unsupported platforms cannot start installation',async t=>{
  const {controller}=await setup(t,{platform:'linux'});
  assert.equal(controller.state().supported,false);
  assert.throws(()=>controller.install({component:'all'}),/Windows x64/);
});

test('binding external Python uses metadata only; explicit fixed-package probes remain isolated',async t=>{
  const commands=[];
  const {controller,directory}=await setup(t,{runCommandImpl:async(executable,args,options)=>{
    commands.push({executable,args,options});return {stdout:'{"ready":true}'};
  }});
  const python=join(directory,'external-python.exe');await writeFile(python,'fixture');
  await controller.configure({pythonPath:python});
  assert.equal(commands.length,0);
  await controller.verifyRuntime(python,new AbortController().signal);
  assert.equal(commands.length,1);assert.ok(commands[0].args.includes('-I'));
  assert.ok(commands[0].args.includes('-B'),'检测外部 Python 时禁止写入 pyc');
  assert.equal(commands[0].options.env.CUDA_VISIBLE_DEVICES,'');
  assert.equal(commands[0].options.env.HF_HUB_OFFLINE,'1');
  assert.match(commands[0].args.at(-1),/import .*scipy|from scipy/);
  assert.equal(controller.state().config.pythonPath,python);
});

test('the runtime lock contains the inference dependency closure without standalone web services',()=>{
  const dependencies=[...VOICE_PACKAGE.runtime.packages,...VOICE_PACKAGE.runtime.torchPackages];
  assert.ok(dependencies.includes('scipy==1.16.2'));
  assert.ok(dependencies.includes('librosa==0.11.0'));
  assert.ok(dependencies.includes('soxr==1.1.0'));
  assert.ok(dependencies.includes('torchcodec==0.8.1'));
  assert.ok(dependencies.every(value=>!/^gradio(?:-client)?==|^hf-gradio==|^fastapi==|^starlette==|^uvicorn==/.test(value)));
  assert.ok(dependencies.every(value=>/^[a-z0-9-]+==[a-zA-Z0-9.+]+$/i.test(value)));
});

test('Windows cancellation targets the exact owned process tree by PID', {skip:process.platform!=='win32'},async t=>{
  const spawned=[];let owned;let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const {controller}=await setup(t,{spawnImpl:(executable,args,options)=>{
    spawned.push({executable,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{queueMicrotask(()=>child.emit('close',null));};
    if(executable==='taskkill.exe')queueMicrotask(()=>{owned.emit('close',null);child.emit('close',0);});
    else {child.pid=43210;owned=child;entered();}
    return child;
  }});
  const abort=new AbortController();const operation=controller.command('owned-python.exe',['-B','-c','pass'],{signal:abort.signal});
  await ready;abort.abort();await assert.rejects(operation);
  const killer=spawned.find(item=>item.executable==='taskkill.exe');
  assert.deepEqual(killer?.args,['/PID','43210','/T','/F']);
  assert.equal(killer.options.windowsHide,true);assert.equal(killer.options.shell,false);
});

test('a failed partial venv is cleaned and retry publishes a verified private environment',async t=>{
  let attempts=0;const targets=[];
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    runCommandImpl:async(_executable,args)=>{
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){
        const target=args.at(-1);targets.push(target);await mkdir(join(target,'Scripts'),{recursive:true});await writeFile(join(target,'pyvenv.cfg'),'partial');
        if(++attempts===1)throw new Error('interrupted after writing pyvenv.cfg');
        assert.ok(args.includes('--relocatable'));
        await writeFile(join(target,'Scripts','python.exe'),'python');
      }
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});let state=await settled(controller);assert.equal(state.task.status,'failed');
  controller.install({component:'runtime'});state=await settled(controller);
  assert.equal(state.task.status,'completed');assert.equal(attempts,2);
  assert.notEqual(targets[0],targets[1]);assert.notEqual(targets[1],join(state.directory,'components','runtime','moss-py312'));
  assert.equal(await readFile(state.config.pythonPath,'utf8'),'python');
  const root=join(state.directory,'components','runtime');assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('venv-')),[]);
});

test('a partial venv cancelled during creation can be retried without touching unknown directories',async t=>{
  let creating;const entered=new Promise(resolve=>{creating=resolve;});let attempts=0;
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    runCommandImpl:async(_executable,args,{signal})=>{
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){
        const target=args.at(-1);await mkdir(join(target,'Scripts'),{recursive:true});await writeFile(join(target,'pyvenv.cfg'),'partial');
        if(++attempts===1){creating();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
        await writeFile(join(target,'Scripts','python.exe'),'python');
      }
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  const root=join(controller.state().directory,'components','runtime');await controller.ownedRuntime(root,new AbortController().signal);
  const unknown=join(root,'venv-do-not-touch');await mkdir(unknown);await writeFile(join(unknown,'note.txt'),'keep');
  controller.install({component:'runtime'});await entered;await controller.cancel();
  controller.install({component:'runtime'});const state=await settled(controller);
  assert.equal(state.task.status,'completed');assert.equal(await readFile(join(unknown,'note.txt'),'utf8'),'keep');
  assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('venv-')),['venv-do-not-touch']);
});

test('retry after interrupted dependency installation reuses the published interpreter',async t=>{
  let venvs=0;let pipAttempts=0;let dependenciesReady=false;
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return dependenciesReady;}catch{return false;}},
    runCommandImpl:async(_executable,args)=>{
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){venvs++;await mkdir(join(args.at(-1),'Scripts'),{recursive:true});await writeFile(join(args.at(-1),'Scripts','python.exe'),'python');}
      if(args[0]==='pip'){
        if(++pipAttempts===1)throw new Error('interrupted dependency install');
        dependenciesReady=true;
      }
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});assert.equal((await settled(controller)).task.status,'failed');
  controller.install({component:'runtime'});assert.equal((await settled(controller)).task.status,'completed');
  assert.equal(venvs,1);assert.equal(pipAttempts,3);
});

test('an unknown venv inside an owned runtime remains untouched',async t=>{
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async()=>false,
    runCommandImpl:async(_executable,args)=>{
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      assert.notEqual(args[0],'venv');assert.notEqual(args[0],'pip');return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  const root=join(controller.state().directory,'components','runtime');await controller.ownedRuntime(root,new AbortController().signal);
  const unknown=join(root,'moss-py312');await mkdir(join(unknown,'Scripts'),{recursive:true});await writeFile(join(unknown,'Scripts','python.exe'),'unknown');
  await writeFile(join(unknown,'pyvenv.cfg'),'keep');
  controller.install({component:'runtime'});const state=await settled(controller);
  assert.equal(state.task.status,'failed');assert.match(state.task.error,/归属|已有|其他/);
  assert.equal(await readFile(join(unknown,'pyvenv.cfg'),'utf8'),'keep');
});

test('an older uv version falls back to the verified fixed tool',async t=>{
  let fetched=0;const commands=[];
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    fetchImpl:async()=>{fetched++;return new Response(content);},
    extractImpl:async({destination})=>{await mkdir(destination);await writeFile(join(destination,'uv.exe'),'tool');},
    runCommandImpl:async(executable,args)=>{
      commands.push({executable,args});if(args[0]==='--version')return {stdout:'uv 0.10.1'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){await mkdir(join(args.at(-1),'Scripts'),{recursive:true});await writeFile(join(args.at(-1),'Scripts','python.exe'),'python');}
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'old-uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});const state=await settled(controller);
  assert.equal(state.task.status,'completed');assert.equal(fetched,1);
  assert.ok(commands.filter(item=>item.args[0]!=='--version').every(item=>item.executable!==uv));
});

test('a failed exclusive lock write is cleaned so retry can acquire the lock',async t=>{
  let fail=true;let fetched=0;
  const {controller}=await setup(t,{fetchImpl:async()=>{fetched++;return new Response(content);},openFileImpl:async(path,flags)=>{
    const handle=await open(path,flags);
    if(fail&&path.endsWith('.install-lock.json')){fail=false;handle.writeFile=async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};}
    return handle;
  }});
  controller.install({component:'generator'});assert.equal((await settled(controller)).task.status,'failed');
  controller.install({component:'generator'});assert.equal((await settled(controller)).task.status,'completed');
  assert.equal(fetched,1);
});

test('a failed runtime ownership write is cleaned without claiming unknown files',async t=>{
  let fail=true;
  const {controller,directory}=await setup(t,{runtimeProbeImpl:async path=>{try{await access(path);return true;}catch{return false;}},
    openFileImpl:async(path,flags)=>{
      const handle=await open(path,flags);
      if(fail&&path.endsWith('voice-runtime-owner.json')){fail=false;handle.writeFile=async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};}
      return handle;
    },runCommandImpl:async(_executable,args)=>{
      if(args[0]==='--version')return {stdout:'uv 0.10.12'};
      if(args[0]==='python'&&args[1]==='find')return {stdout:join(directory,'managed','python.exe')};
      if(args[0]==='venv'){await mkdir(join(args.at(-1),'Scripts'),{recursive:true});await writeFile(join(args.at(-1),'Scripts','python.exe'),'python');}
      if(args.includes('-c'))return {stdout:'{"pythonReady":true}'};
      return {stdout:''};
    }});
  const uv=join(directory,'uv.exe');await writeFile(uv,'fixture');controller.candidates.uvPath=[uv];
  controller.install({component:'runtime'});assert.equal((await settled(controller)).task.status,'failed');
  controller.install({component:'runtime'});assert.equal((await settled(controller)).task.status,'completed');
});

test('a failed exclusive open never deletes an existing external lock',async t=>{
  const {controller}=await setup(t,{fetchImpl:async()=>{assert.fail('external lock must prevent downloads');}});
  const root=join(controller.state().directory,'components');await mkdir(root,{recursive:true});const path=join(root,'.install-lock.json');
  const record=JSON.stringify({owner:'AI-Future-Workbench/voice-resources',pid:process.pid,token:'external-lock'});await writeFile(path,record);
  controller.install({component:'generator'});assert.equal((await settled(controller)).task.status,'failed');
  assert.equal(await readFile(path,'utf8'),record);
});

test('two instances reclaiming a stale lock never enter the downloader together',async t=>{
  let fetched=0;let firstFetch;const entered=new Promise(resolve=>{firstFetch=resolve;});let releaseDownload;const downloadGate=new Promise(resolve=>{releaseDownload=resolve;});
  const options={fetchImpl:async()=>{fetched++;firstFetch();await downloadGate;return new Response(content);}};
  const {controller,directory}=await setup(t,options);
  const peer=new VoiceResources({store:{getSetting:()=>undefined,setSetting:()=>{}},dataDir:directory,directory:controller.state().directory,
    packageSpec,platform:'win32',arch:'x64',candidates:{},...options});await peer.initialized;
  t.after(()=>peer.close());
  const root=join(controller.state().directory,'components');await mkdir(root,{recursive:true});const lock=join(root,'.install-lock.json');
  await writeFile(lock,JSON.stringify({owner:'AI-Future-Workbench/voice-resources',pid:2147483647,token:'stale-generation'}));
  const original=fsPromises.rm;let removals=0;let secondRemoval;const bothReclaiming=new Promise(resolve=>{secondRemoval=resolve;});
  fsPromises.rm=async(path,options)=>{
    if(path===lock){
      removals++;
      if(removals===1)await Promise.race([bothReclaiming,delay(100)]);
      else if(removals===2){secondRemoval();await entered;}
    }
    return original(path,options);
  };
  syncBuiltinESMExports();
  try{
    controller.install({component:'generator'});peer.install({component:'generator'});await entered;await delay(30);
    assert.equal(fetched,1,'旧的 stale 判断不能删除对方新建的活动锁');
    assert.equal([controller,peer].filter(item=>item.state().task.status==='running').length,1);
  }finally{
    releaseDownload();await Promise.all([settled(controller),settled(peer)]);fsPromises.rm=original;syncBuiltinESMExports();
  }
  const retry=[controller,peer].find(item=>item.state().task.status==='failed');
  assert.ok(retry);retry.install({component:'generator'});assert.equal((await settled(retry)).task.status,'completed');
});
