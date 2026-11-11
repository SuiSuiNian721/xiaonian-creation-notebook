import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,mkdir,open,readdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {TrainingRuntime} from '../framework/training-runtime.mjs';
import {createWorkbench} from '../framework/server.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const exists=async path=>Boolean(await stat(path).catch(()=>null));
async function fixture(t,options={}){
  const directory=await mkdtemp(join(tmpdir(),'training-startup-lock-')),integrationDir=join(directory,'integration'),environmentRoot=join(directory,'environment');
  await mkdir(join(integrationDir,'source'),{recursive:true});await mkdir(environmentRoot);
  const source=Buffer.from('fixture');
  await writeFile(join(integrationDir,'source','VERSION'),source);
  await writeFile(join(integrationDir,'source-manifest.json'),JSON.stringify({format:1,version:'fixture',kernelRevision:'a'.repeat(64),source:{commit:'fixture'},files:[{path:'VERSION',size:source.length,sha256:hash(source)}]}));
  for(const name of ['runner.py','prepare_service.py','catalog.json','workbench_preprocess.py','workbench_vision.py','workbench_caption.py'])await writeFile(join(integrationDir,name),'{}');
  const config={trainerPath:environmentRoot,pythonPath:process.execPath},children=[],runtimes=[],closers=[];
  const make=extra=>{const runtime=new TrainingRuntime({dataDir:directory,integrationDir,store:{module:()=>({config})},startupTimeoutMs:1500,...options,...extra});runtimes.push(runtime);return runtime;};
  t.after(async()=>{for(const runtime of runtimes)await runtime.close();for(const closer of closers)await closer();for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {directory,integrationDir,config,children,closers,make,lockPath:join(directory,'training','startup.lock')};
}

test('state refresh automatically recovers a stale legacy startup lock without launching anything',async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:()=>assert.fail('刷新不能启动后台')});
  await mkdir(join(f.directory,'training'));
  // A PID which demonstrably no longer exists, rather than an arbitrary number.
  const child=spawn(process.execPath,['-e',''],{windowsHide:true});const exited=once(child,'exit');await exited;
  await writeFile(f.lockPath,JSON.stringify({launcherPid:child.pid,createdAt:new Date().toISOString()}));
  const state=await runtime.state();assert.equal(state.status,'stopped');assert.equal(await exists(f.lockPath),false);
});

test('a live legacy startup owner stays protected even with no training tasks',async t=>{
  const f=await fixture(t),runtime=f.make();await mkdir(join(f.directory,'training'));
  await writeFile(f.lockPath,JSON.stringify({launcherPid:process.pid,createdAt:new Date().toISOString()}));
  const state=await runtime.state();assert.equal(state.status,'starting');assert.equal(await exists(f.lockPath),true);
  await assert.rejects(runtime.start(),/启动/);assert.equal(await exists(f.lockPath),true);
});

test('concurrent status inspections do not mistake their own short SQLite probes for a startup owner',async t=>{
  const {TrainingStartupLock}=await import('../framework/training-startup-lock.mjs');const f=await fixture(t),guard=new TrainingStartupLock({directory:join(f.directory,'training')});
  const initial=await guard.acquire();await initial.release();
  const gate=guard.gate.bind(guard);let first=true;
  guard.gate=async()=>{const db=await gate();if(first&&db){first=false;await delay(50);}return db;};
  const states=await Promise.all([guard.inspect(),guard.inspect(),guard.inspect()]);
  assert.ok(states.every(state=>!state.locked));
});

test('queued startup inspections preserve each callers readiness options',async t=>{
  const {TrainingStartupLock}=await import('../framework/training-startup-lock.mjs');const f=await fixture(t),guard=new TrainingStartupLock({directory:join(f.directory,'training')});
  await mkdir(guard.directory,{recursive:true});await writeFile(f.lockPath,JSON.stringify({launcherPid:process.pid}));
  const [unready,ready]=await Promise.all([guard.inspect({workerPid:process.pid}),guard.inspect({workerPid:process.pid,ready:true})]);
  assert.equal(unready.locked,true);assert.equal(unready.processHeld,false);assert.equal(ready.locked,false);
});

test('a failed startup inspection does not block queued status checks',async t=>{
  const {TrainingStartupLock}=await import('../framework/training-startup-lock.mjs');const f=await fixture(t),guard=new TrainingStartupLock({directory:join(f.directory,'training')});
  const metadata=guard.metadata.bind(guard);let first=true;
  guard.metadata=async()=>{if(first){first=false;throw new Error('fixture metadata read failure');}return metadata();};
  const failed=assert.rejects(guard.inspect(),/fixture metadata read failure/),next=guard.inspect();
  await failed;assert.equal((await next).locked,false);
});

test('manual stop cancels pending materialization, releases the lock and never spawns Python',async t=>{
  let entered;const ready=new Promise(done=>entered=done),f=await fixture(t),runtime=f.make({
    materializeImpl:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},
    spawnImpl:()=>assert.fail('取消后不能启动进程'),
  });
  const starting=runtime.start();const result=starting.then(()=>null,error=>error);
  await ready;assert.equal((await runtime.state()).status,'starting');
  assert.equal((await runtime.stop()).stopped,true);assert.match((await result).message,/取消/);
  assert.equal(await exists(f.lockPath),false);assert.equal((await runtime.state()).status,'stopped');
});

test('startup preparation failure releases its own lock and permits a later retry',async t=>{
  const f=await fixture(t),runtime=f.make({materializeImpl:async()=>{throw new Error('fixture preparation failed');}});
  await assert.rejects(runtime.start(),/fixture preparation failed/);assert.equal(await exists(f.lockPath),false);
  await assert.rejects(runtime.start(),/fixture preparation failed/);assert.equal(await exists(f.lockPath),false);
});

test('process-held startup lock survives contention and is released by forced owner exit',async t=>{
  const {TrainingStartupLock}=await import('../framework/training-startup-lock.mjs');const f=await fixture(t);
  const source=`import {TrainingStartupLock} from ${JSON.stringify(new URL('../framework/training-startup-lock.mjs',import.meta.url).href)};const guard=new TrainingStartupLock({directory:process.argv[1]});await guard.acquire();process.stdout.write('LOCKED\\n');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,join(f.directory,'training')],{windowsHide:true,stdio:['ignore','pipe','pipe']});f.children.push(child);
  let output='';const ready=new Promise((done,reject)=>{child.stdout.on('data',part=>{output+=part;if(output.includes('LOCKED'))done();});child.once('exit',code=>reject(new Error('owner exited '+code)));});await ready;
  const guard=new TrainingStartupLock({directory:join(f.directory,'training')});assert.equal((await guard.inspect()).locked,true);await assert.rejects(guard.acquire(),/启动/);
  const ended=once(child,'exit');child.kill();await ended;
  assert.equal((await guard.inspect()).locked,false);assert.equal(await exists(f.lockPath),false);
  const first=await guard.acquire();await first.release();const second=await guard.acquire();
  const before=await readFile(f.lockPath,'utf8');await first.release();assert.equal(await readFile(f.lockPath,'utf8'),before,'旧释放不能删除后继锁');await second.release();
});

function spawnBackend(f,{ready=true}={}){
  return (_executable,args,options)=>{
    const source=`const fs=require('node:fs'),http=require('node:http');const b=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const identity={...b,token:undefined,pid:process.pid};const server=http.createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+b.token){res.writeHead(401);res.end();return;}let data={};if(req.url==='/__workbench/identity')data=identity;else if(req.url==='/api/tasks'){try{data={tasks:JSON.parse(fs.readFileSync(b.root+'/fixture-tasks.json','utf8'))};}catch{data={tasks:[]};}}else if(req.url==='/__workbench/shutdown')setTimeout(()=>server.close(()=>process.exit(0)),20);res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'success',data}));});server.listen(0,'127.0.0.1',()=>{identity.url='http://127.0.0.1:'+server.address().port;if(${ready})fs.writeFileSync(b.readyPath,JSON.stringify(identity));});`;
    const child=spawn(process.execPath,['-e',source,args.at(-1)],options);f.children.push(child);return child;
  };
}

test('ready backend releases its startup lock even while training tasks remain protected',async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:spawnBackend(f)}),state=await runtime.start();
  assert.equal(state.status,'running');assert.equal(await exists(f.lockPath),false);
  await writeFile(join(state.root,'fixture-tasks.json'),JSON.stringify([{id:'fixture-job',status:'RUNNING'}]));
  await assert.rejects(runtime.stop(),/任务/);assert.equal(await exists(f.lockPath),false);
  await writeFile(join(state.root,'fixture-tasks.json'),'[]');assert.equal((await runtime.stop()).stopped,true);
  assert.equal(await exists(f.lockPath),false);
});

test('manual child termination during startup releases the lock without waiting for timeout',async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:spawnBackend(f,{ready:false}),startupTimeoutMs:5000});
  const starting=runtime.start().then(()=>null,error=>error);while(!f.children.length)await delay(5);
  assert.equal((await runtime.state()).status,'starting','已创建但尚未就绪的子进程仍属于启动阶段');
  const child=f.children[0],ended=once(child,'exit');child.kill();await ended;
  assert.match((await starting).message,/进程退出/);assert.equal(await exists(f.lockPath),false);
});

test('startup timeout terminates its own unready child and releases its lock',async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:spawnBackend(f,{ready:false}),startupTimeoutMs:100});
  await assert.rejects(runtime.start(),/超时/);assert.equal(await exists(f.lockPath),false);
  const child=f.children[0];if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');
  assert.equal((await runtime.state()).status,'offline');
});

test('normal application close cancels an unfinished start and rejects future launches',async t=>{
  let entered;const ready=new Promise(done=>entered=done),f=await fixture(t),runtime=f.make({materializeImpl:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const starting=runtime.start().then(()=>null,error=>error);await ready;
  await runtime.close();assert.match((await starting).message,/取消/);assert.equal(await exists(f.lockPath),false);
  await assert.rejects(runtime.start(),/已关闭/);
});

test('a new start is rejected while a manual stop is still cancelling preparation',async t=>{
  let entered;const ready=new Promise(done=>entered=done),f=await fixture(t),runtime=f.make({materializeImpl:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>reject(signal.reason),25),{once:true}));}});
  const starting=runtime.start().then(()=>null,error=>error);await ready;
  const stopping=runtime.stop();
  await assert.rejects(runtime.start(),/停止/);await stopping;assert.match((await starting).message,/取消/);
  assert.equal(await exists(f.lockPath),false);
});

test('real HTTP stop reaches startup cancellation through the training service',async t=>{
  let entered;const ready=new Promise(done=>entered=done),f=await fixture(t),runtime=f.make({materializeImpl:async({signal})=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  const app=await createWorkbench({dataDir:join(f.directory,'web-profile'),instances:false,trainingOptions:{runtime,integrationDir:f.integrationDir}});f.closers.push(()=>app.close());
  const request=async(path,body,method='POST')=>{const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  await request('/api/modules/training/enable',{});await request('/api/modules/training/config',{values:f.config},'PUT');
  const pending=request('/api/training/start',{}).catch(error=>({error}));await ready;
  const stopped=await request('/api/training/stop',{});assert.equal(stopped.status,200,JSON.stringify(stopped.data));
  assert.equal((await pending).status,409);assert.equal(await exists(f.lockPath),false);
});

test('another instance cannot attach or submit while the startup owner is still verifying readiness',{timeout:15000},async t=>{
  const f=await fixture(t),owner=f.make({spawnImpl:spawnBackend(f),fetchImpl:async()=>{throw new Error('temporary owner probe failure');},startupTimeoutMs:5000});
  let launchError;const pending=owner.start().then(()=>null,error=>{launchError=error;return error;});while(!f.children.length){if(launchError)throw launchError;await delay(5,undefined,{signal:t.signal});}
  const record=JSON.parse(await readFile(owner.recordPath,'utf8'));while(!await exists(record.readyPath)){if(launchError)throw launchError;await delay(5,undefined,{signal:t.signal});}
  const peer=f.make({spawnImpl:()=>assert.fail('不能另起后台')});
  assert.equal((await peer.state()).status,'starting');await assert.rejects(peer.start(),/启动/);
  await assert.rejects(peer.request('GET','/api/tasks'),/启动|就绪/);
  await writeFile(join(record.root,'fixture-tasks.json'),JSON.stringify([{id:'legacy-client-job',status:'RUNNING'}]));
  await assert.rejects(owner.stop(),/进程|身份|核实/);assert.match((await pending).message,/取消/);
  assert.equal((await peer.state()).status,'running','身份探测失败时不误杀已发布的共享后台');
  await assert.rejects(peer.stop(),/任务/);
  await writeFile(join(record.root,'fixture-tasks.json'),'[]');await peer.stop();
});

test('runtime publication recovers from transient Windows file sharing conflicts',{timeout:15000},async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:spawnBackend(f)}),rename=fsPromises.rename,codes=['EPERM','EACCES','EBUSY'];let conflicts=0;
  fsPromises.rename=async(from,to)=>{
    if(to===runtime.recordPath&&await exists(to)&&conflicts<codes.length){
      assert.ok(JSON.parse(await readFile(to,'utf8')).launchId,'替换失败时旧记录仍可读取');
      throw Object.assign(new Error('fixture file sharing conflict'),{code:codes[conflicts++]});
    }
    return rename(from,to);
  };
  syncBuiltinESMExports();
  try{assert.equal((await runtime.start()).status,'running');assert.equal(conflicts,3);await runtime.stop();}
  finally{fsPromises.rename=rename;syncBuiltinESMExports();}
});

test('persistent runtime publication denial preserves the previous record and cleans its temporary file',{timeout:15000},async t=>{
  const f=await fixture(t),runtime=f.make({spawnImpl:()=>assert.fail('发布记录失败后不能启动后台')}),rename=fsPromises.rename;
  const previous={pid:0,launchId:'previous-stopped-runtime'};let attempts=0;
  await mkdir(runtime.directory,{recursive:true});await writeFile(runtime.recordPath,JSON.stringify(previous));
  fsPromises.rename=async(from,to)=>{
    if(to===runtime.recordPath){attempts++;throw Object.assign(new Error('fixture persistent write denial'),{code:'EACCES'});}
    return rename(from,to);
  };
  syncBuiltinESMExports();
  try{
    await assert.rejects(runtime.start(),/fixture persistent write denial/);assert.ok(attempts>1&&attempts<=6);
    assert.deepEqual(JSON.parse(await readFile(runtime.recordPath,'utf8')),previous);
    assert.deepEqual((await readdir(runtime.directory)).filter(name=>name.startsWith('runtime.json.')&&name.endsWith('.tmp')),[]);
    assert.equal(await exists(f.lockPath),false);
  }finally{fsPromises.rename=rename;syncBuiltinESMExports();}
});

test('new-protocol metadata cannot overwrite a legacy launcher winning exclusive creation',async t=>{
  const {TrainingStartupLock}=await import('../framework/training-startup-lock.mjs');const f=await fixture(t),guard=new TrainingStartupLock({directory:join(f.directory,'training')});
  const metadata=guard.metadata.bind(guard);let injected=false,legacy;
  guard.metadata=async()=>{const value=await metadata();if(!value&&!injected){injected=true;legacy=await open(f.lockPath,'wx');await legacy.writeFile(JSON.stringify({launcherPid:process.pid}),'utf8');await legacy.close();}return value;};
  try{await assert.rejects(guard.acquire(),/启动/);assert.equal(JSON.parse(await readFile(f.lockPath,'utf8')).launcherPid,process.pid);}
  finally{await guard.lease?.release();}
});

for(const different of [false,true])test(`lock owner rechecks a backend started between its initial probe and acquisition (${different?'different binding':'same binding'})`,async t=>{
  const f=await fixture(t),first=f.make({spawnImpl:()=>assert.fail('第二次核对不能重复启动后台')}),second=f.make({spawnImpl:spawnBackend(f)});
  const state=first.state.bind(first);let entered,release,count=0;const snapshotTaken=new Promise(done=>entered=done),resume=new Promise(done=>release=done);
  first.state=async(...args)=>{const value=await state(...args);if(++count===1){entered();await resume;}return value;};
  const config=different?{...f.config,trainerPath:join(f.directory,'another-environment')}:f.config;
  const pending=first.start(config).then(value=>({value}),error=>({error}));await snapshotTaken;
  const ready=await second.start();release();const result=await pending;
  if(different){assert.equal(result.error?.status,409);assert.match(result.error.message,/环境|配置/);}
  else{assert.ifError(result.error);assert.equal(result.value.pid,ready.pid);}
  assert.equal(f.children.length,1);assert.equal((await second.state()).status,'running');await second.stop();
});
