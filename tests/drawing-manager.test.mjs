import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rmdir, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkbenchStore } from '../framework/store.mjs';
import { DrawingRuntime } from '../framework/drawing-runtime.mjs';
import { createWorkbench } from '../framework/server.mjs';

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, windowsHide:true })).stdout.trim();
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drawing-manager-'));
  const comfy = join(root, 'ComfyUI'); await mkdir(join(comfy, 'comfy'), {recursive:true});
  await mkdir(join(comfy, 'custom_nodes')); await mkdir(join(comfy, 'models', 'loras'), {recursive:true});
  for (const name of ['main.py','nodes.py','server.py']) await writeFile(join(comfy,name), '# fixture\n');
  const origin = join(root,'origin.git'); const author = join(root,'author');
  await mkdir(author); await git(author,'init','-b','main'); await writeFile(join(author,'.gitattributes'),'*.py text eol=lf\n'); await writeFile(join(author,'plugin.py'),'one\n');
  await writeFile(join(author,'requirements.txt'),'example==1.0\n'); await git(author,'add','.'); await git(author,'commit','-m','one');
  const first = await git(author,'rev-parse','HEAD'); await git(root,'clone','--bare',author,origin);
  await git(author,'remote','add','origin',origin);
  const data = join(root,'data'); const store = new WorkbenchStore(data);
  store.saveConfig('drawing',{comfyPath:comfy,serviceUrl:'http://127.0.0.1:8188'});
  const runtime = new DrawingRuntime({store,directory:join(data,'drawing')}); runtime.saveSettings({pythonPath:process.execPath});
  const drawing = {config:()=>store.module('drawing').config,runtime};
  let pythonCalls = [];
  const { DrawingManager, runManaged } = await import('../framework/drawing-manager.mjs');
  const runner = async (exe,args,opts) => { if(exe==='git') return runManaged(exe,args,opts); pythonCalls.push(args); return {code:0,stdout:args.includes('freeze')?'example==1.0\n':'Python fixture\n',stderr:''}; };
  const manager = new DrawingManager({drawing,store,dataDir:data,runner,isRunning:async()=>false,allowLocalRepositories:true,...options});
  const closers=[];
  t.after(async()=>{for(const close of closers)await close();await manager.close(); await runtime.close(); store.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep)); await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  return {root,comfy,origin,author,first,store,runtime,drawing,manager,pythonCalls,closers};
}
async function finish(manager,task) { for(let i=0;i<500;i++){const value=manager.state().tasks.find(x=>x.id===task.id); if(!['queued','running'].includes(value.status)) return value; await delay(20);} assert.fail('任务未结束'); }
async function install(f,name='Plugin') { return finish(f.manager,await f.manager.apply({planId:(await f.manager.plan({operation:'install-plugin',url:f.origin,name})).id})); }

test('状态只读，索引递归模型、普通插件、Git origin 脱敏并跳过链接',async t=>{
  let network=0; const f=await fixture(t,{fetchImpl:async()=>{network++;throw new Error('unexpected');}});
  assert.deepEqual(f.manager.state(),{inventory:null,downloads:[],snapshots:[],tasks:[]});
  await writeFile(join(f.comfy,'models','loras','真实.safetensors'),'model');
  await mkdir(join(f.comfy,'custom_nodes','plain')); await writeFile(join(f.comfy,'custom_nodes','single.py.disabled'),'# plugin');
  await git(f.comfy,'clone',f.origin,join('custom_nodes','git-plugin'));
  await git(join(f.comfy,'custom_nodes','git-plugin'),'remote','set-url','origin','https://user:secret@example.invalid/repo.git?token=private');
  await symlink(f.author,join(f.comfy,'models','external'),'junction');
  const result=await f.manager.inventory(); assert.equal(network,0); assert.equal(f.pythonCalls.length,0);
  assert.equal(result.models.length,1); assert.equal(result.models[0].category,'loras');
  assert.equal(result.repositories.find(x=>x.id==='plugin:plain').git,null);
  assert.equal(result.repositories.find(x=>x.id==='plugin:single.py').enabled,false);
  assert.equal(result.repositories.find(x=>x.id==='plugin:git-plugin').git.remote,'https://example.invalid/repo.git');
  assert.match(result.warnings.join('\n'),/链接|联接/); assert.match(result.warnings.join('\n'),/extra_model_paths/);
});

test('安装计划无环境写入，重复 apply 只执行一次且安装前有快照',async t=>{
  const f=await fixture(t); const plan=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});
  assert.equal(plan.changes[0].path,join(f.comfy,'custom_nodes','Plugin'));assert.equal(plan.changes[0].source.toLowerCase(),f.origin.toLowerCase());
  await assert.rejects(lstat(join(f.comfy,'custom_nodes','Plugin')), {code:'ENOENT'}); assert.equal(f.pythonCalls.length,0);
  const [a,b]=await Promise.all([f.manager.apply({planId:plan.id}),f.manager.apply({planId:plan.id})]); assert.equal(a.id,b.id);
  const result=await finish(f.manager,a); assert.equal(result.status,'completed',result.error); assert.ok(result.snapshotId);
  assert.equal(await readFile(join(f.comfy,'custom_nodes','Plugin','plugin.py'),'utf8'),'one\n');
  assert.equal(f.manager.state().tasks.length,1); assert.equal(f.pythonCalls.filter(x=>x.includes('install')).length,0);
});

test('更新真实文件，快照恢复提交、启用状态、配置和运行参数；保留新增资源',async t=>{
  const f=await fixture(t); assert.equal((await install(f)).status,'completed');
  await writeFile(join(f.comfy,'extra_model_paths.yaml'),'original: true\r\n');
  const saved=await f.manager.snapshot({name:'初始版本'});
  await writeFile(join(f.author,'plugin.py'),'two\n'); await git(f.author,'commit','-am','two'); await git(f.author,'push','origin','main');
  const plan=await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin'});
  assert.equal(plan.changes[0].path,join(f.comfy,'custom_nodes','Plugin'));assert.equal(plan.changes[0].source.toLowerCase(),f.origin.toLowerCase());
  const changed=await finish(f.manager,await f.manager.apply({planId:plan.id})); assert.equal(changed.status,'completed',changed.error); assert.ok(changed.snapshotId);
  assert.equal(await readFile(join(f.comfy,'custom_nodes','Plugin','plugin.py'),'utf8'),'two\n');
  const off=await f.manager.plan({operation:'disable-plugin',repositoryId:'plugin:Plugin'});
  assert.equal((await finish(f.manager,await f.manager.apply({planId:off.id}))).status,'completed');
  await writeFile(join(f.comfy,'extra_model_paths.yaml'),'changed: true\n'); f.runtime.saveSettings({vramMode:'cpu'});
  await mkdir(join(f.comfy,'custom_nodes','later')); await writeFile(join(f.comfy,'models','loras','later.bin'),'later');
  const restore=await f.manager.plan({operation:'restore',snapshotId:saved.id});
  assert.equal(restore.changes.find(change=>change.label==='Plugin').path,join(f.comfy,'custom_nodes','Plugin.disabled'));assert.equal(restore.changes.find(change=>change.label==='Plugin').source.toLowerCase(),f.origin.toLowerCase());
  const restored=await finish(f.manager,await f.manager.apply({planId:restore.id})); assert.equal(restored.status,'completed',restored.error);
  assert.equal(await readFile(join(f.comfy,'custom_nodes','Plugin','plugin.py'),'utf8'),'one\n');
  assert.equal(await git(join(f.comfy,'custom_nodes','Plugin'),'rev-parse','HEAD'),f.first);
  assert.equal(await readFile(join(f.comfy,'extra_model_paths.yaml'),'utf8'),'original: true\r\n'); assert.equal(f.runtime.settings().vramMode,'auto');
  assert.ok((await lstat(join(f.comfy,'custom_nodes','later'))).isDirectory()); assert.ok((await lstat(join(f.comfy,'models','loras','later.bin'))).isFile());
});

test('脏仓库、过时计划、禁用目录冲突都拒绝修改',async t=>{
  const f=await fixture(t); await install(f); const path=join(f.comfy,'custom_nodes','Plugin');
  await writeFile(join(path,'untracked.txt'),'user');
  await assert.rejects(f.manager.plan({operation:'update',repositoryId:'plugin:Plugin'}),/未提交|脏/);
  const dirty=await f.manager.snapshot({}); await assert.rejects(f.manager.plan({operation:'restore',snapshotId:dirty.id}),/未提交|脏/);
  await rm(join(path,'untracked.txt'));
  const plan=await f.manager.plan({operation:'disable-plugin',repositoryId:'plugin:Plugin'});
  await writeFile(join(path,'untracked.txt'),'changed after plan');
  await assert.rejects(f.manager.apply({planId:plan.id}),/变化|过期/);
  await rm(join(path,'untracked.txt')); await mkdir(path+'.disabled');
  await assert.rejects(f.manager.plan({operation:'disable-plugin',repositoryId:'plugin:Plugin'}),/同名|冲突|已存在/);
});

test('依赖只在明确 apply 后安装，在线运行禁止环境修改',async t=>{
  let online=false;const f=await fixture(t,{isRunning:async()=>online});await install(f);
  const plan=await f.manager.plan({operation:'dependencies',repositoryId:'plugin:Plugin'});
  assert.match(plan.warnings.join('\n'),/不能自动回退/);assert.equal(f.pythonCalls.filter(x=>x.includes('install')).length,0);
  online=true;await assert.rejects(f.manager.apply({planId:plan.id}),/运行|离线/);online=false;
  const task=await finish(f.manager,await f.manager.apply({planId:plan.id}));assert.equal(task.status,'completed',task.error);assert.ok(task.snapshotId);
  assert.equal(f.pythonCalls.filter(x=>x.includes('install')).length,1);
});

test('依赖安装完成前即可读取流日志，完成后不重复追加，尾部截断明确',async t=>{
  const f=await fixture(t);await install(f);const original=f.manager.runner;
  let entered=false,release;
  const gate=new Promise(resolveGate=>{release=resolveGate;});
  f.manager.runner=async(exe,args,options)=>{
    if(!args.includes('install'))return original(exe,args,options);
    options.onOutput('正在安装中文依赖\n','stdout');entered=true;await gate;
    options.onOutput('安装结束\n','stderr');return {code:0,stdout:'正在安装中文依赖\n',stderr:'安装结束\n'};
  };
  const plan=await f.manager.plan({operation:'dependencies',repositoryId:'plugin:Plugin'});
  const task=await f.manager.apply({planId:plan.id});
  try {
    for(let i=0;i<100&&!entered;i++)await delay(20);
    const running=f.manager.logs(task.id);assert.equal(running.task.status,'running');assert.match(running.text,/正在安装中文依赖/);
  } finally {release();}
  const completed=await finish(f.manager,task);assert.equal(completed.status,'completed');assert.equal(completed.log.split('正在安装中文依赖').length,2);
  const record=f.manager.tasks.find(item=>item.id===task.id);f.manager.appendLog(record,'界'.repeat(40000));
  const tail=f.manager.logs(task.id);assert.equal(tail.truncated,true);assert.equal(tail.text.length,32000);
});

test('HTTP 状态无扫描无网络，管理请求受启用检查且计划拒绝任意路径字段',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'drawing-manager-http-'));let calls=0;
  const app=await createWorkbench({dataDir:directory,drawingOptions:{fetchImpl:async()=>{calls++;throw new Error('unexpected');}}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const request=async(path,value)=>{const response=await fetch(app.url+'/api/modules/drawing/'+path,{method:value?'POST':'GET',...(value?{headers:{'content-type':'application/json'},body:JSON.stringify(value)}:{})});return {status:response.status,value:await response.json()};};
  assert.equal((await request('manager/state')).status,409);await request('enable',{});
  assert.deepEqual((await request('manager/state')).value,{inventory:null,downloads:[],snapshots:[],tasks:[]});assert.equal(calls,0);
  assert.equal((await request('manager/plan',{operation:'update',repositoryId:'core',path:'C:\\anything'})).status,400);
});

test('远端计划过时拒绝且留下失败任务和快照；配置变动在应用前拒绝',async t=>{
  const f=await fixture(t);await install(f);
  const plan=await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin'});
  await writeFile(join(f.author,'plugin.py'),'new remote\n');await git(f.author,'commit','-am','new');await git(f.author,'push','origin','main');
  const failed=await finish(f.manager,await f.manager.apply({planId:plan.id}));assert.equal(failed.status,'failed');assert.match(failed.error,/远端.*变化/);assert.ok(failed.snapshotId);
  assert.equal(await git(join(f.comfy,'custom_nodes','Plugin'),'rev-parse','HEAD'),f.first);
  const stale=await f.manager.plan({operation:'disable-plugin',repositoryId:'plugin:Plugin'});f.runtime.saveSettings({vramMode:'cpu'});
  await assert.rejects(f.manager.apply({planId:stale.id}),/配置.*变化|过期/);
});

test('停止中的依赖进程被取消，重启保留 interrupted 且同计划不会重新执行',async t=>{
  const f=await fixture(t);await install(f);const original=f.manager.runner;let started=false,cancelled=false;
  f.manager.runner=async(exe,args,opts)=>{if(!args.includes('install'))return original(exe,args,opts);started=true;return new Promise(resolveResult=>{opts.signal.addEventListener('abort',()=>{cancelled=true;resolveResult({code:null,error:'已取消',stdout:'',stderr:''});},{once:true});});};
  const plan=await f.manager.plan({operation:'dependencies',repositoryId:'plugin:Plugin'});const task=await f.manager.apply({planId:plan.id});
  for(let i=0;i<200&&!started;i++)await delay(20);assert.ok(started);await f.manager.close();assert.ok(cancelled);
  assert.equal(f.manager.state().tasks.find(x=>x.id===task.id).status,'interrupted');
  const {DrawingManager}=await import('../framework/drawing-manager.mjs');const restarted=new DrawingManager({drawing:f.drawing,store:f.store,dataDir:join(f.root,'data'),runner:original,isRunning:async()=>false,allowLocalRepositories:true});
  try{assert.equal(restarted.state().tasks.find(x=>x.id===task.id).status,'interrupted');assert.equal((await restarted.apply({planId:plan.id})).id,task.id);}finally{await restarted.close();}
});

test('缺少退出证据、PID 存活、远程服务地址和链接根路径均不能修改环境',async t=>{
  const f=await fixture(t,{isRunning:undefined,fetchImpl:async()=>{throw new Error('timeout');}});
  const plan=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});
  await assert.rejects(f.manager.apply({planId:plan.id}),/无法确认.*离线/);
  f.manager.fetch=async()=>{throw Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}});};
  f.runtime.launchRecord={pid:process.pid,cwd:f.comfy,status:'running'};await assert.rejects(f.manager.apply({planId:plan.id}),/进程.*运行/);f.runtime.launchRecord=null;
  f.store.saveConfig('drawing',{serviceUrl:'http://example.invalid:8188'});const remote=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});await assert.rejects(f.manager.apply({planId:remote.id}),/本机/);
  const alias=join(f.root,'linked');await symlink(f.comfy,alias,'junction');f.store.saveConfig('drawing',{comfyPath:alias});await assert.rejects(f.manager.inventory(),/链接|联接/);
});

test('后台持久层故障不会泄漏未处理拒绝且任务停止',async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});
  const original=f.store.setSetting.bind(f.store);let writes=0;f.store.setSetting=(name,value)=>{if(name==='drawing.manager.tasks'&&++writes>1)throw new Error('disk failure');return original(name,value);};
  const task=await f.manager.apply({planId:plan.id});const failed=await finish(f.manager,task);assert.equal(failed.status,'failed');assert.match(failed.error,/记录无法保存/);f.store.setSetting=original;
});

test('预览后 custom_nodes 被换为联接时拒绝安装，不写入外部目录',async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});
  await rmdir(join(f.comfy,'custom_nodes'));await symlink(f.author,join(f.comfy,'custom_nodes'),'junction');
  await assert.rejects(f.manager.apply({planId:plan.id}),/链接|联接/);
  await assert.rejects(lstat(join(f.author,'Plugin')),{code:'ENOENT'});
});

test('默认更新仅允许快进，显式标签切到确定提交且保留原分支',async t=>{
  const f=await fixture(t);await install(f);const plugin=join(f.comfy,'custom_nodes','Plugin');
  await git(f.author,'tag','v1',f.first);await git(f.author,'push','origin','refs/tags/v1');
  await writeFile(join(plugin,'local.py'),'local\n');await git(plugin,'add','.');await git(plugin,'commit','-m','local');const local=await git(plugin,'rev-parse','HEAD');
  await writeFile(join(f.author,'remote.py'),'remote\n');await git(f.author,'add','.');await git(f.author,'commit','-m','remote');await git(f.author,'push','origin','main');
  const plan=await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin'});const failed=await finish(f.manager,await f.manager.apply({planId:plan.id}));assert.equal(failed.status,'failed');assert.ok(failed.snapshotId);assert.equal(await git(plugin,'rev-parse','HEAD'),local);
  const explicit=await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin',revision:'v1'});assert.match(explicit.changes[0].after,/分离 HEAD/);
  const result=await finish(f.manager,await f.manager.apply({planId:explicit.id}));assert.equal(result.status,'completed',result.error);assert.equal(await git(plugin,'rev-parse','HEAD'),f.first);assert.equal(await git(plugin,'rev-parse','refs/heads/main'),local);
});

test('快照未保存的配置文件保留；损坏备份拒绝且不覆盖当前文件',async t=>{
  const f=await fixture(t);await install(f);const empty=await f.manager.snapshot({});const config=join(f.comfy,'extra_model_paths.yaml');await writeFile(config,'later: true\n');
  const plan=await f.manager.plan({operation:'restore',snapshotId:empty.id});const restored=await finish(f.manager,await f.manager.apply({planId:plan.id}));assert.equal(restored.status,'completed',restored.error);assert.equal(await readFile(config,'utf8'),'later: true\n');
  const saved=await f.manager.snapshot({});const file=join(f.root,'data','drawing','snapshots',saved.id,'snapshot.json');const broken=JSON.parse(await readFile(file,'utf8'));broken.files.find(x=>x.exists).bytes=Buffer.from('corrupt').toString('base64');await writeFile(file,JSON.stringify(broken));
  await writeFile(config,'current: true\n');const corrupt=await f.manager.plan({operation:'restore',snapshotId:saved.id});const failed=await finish(f.manager,await f.manager.apply({planId:corrupt.id}));assert.equal(failed.status,'failed');assert.match(failed.error,/校验/);assert.equal(await readFile(config,'utf8'),'current: true\n');
});

test('快照明确保存 Python/pip 失败；真实子进程可被取消并等待退出',async t=>{
  const f=await fixture(t);f.manager.runner=async()=>({code:1,stdout:'',stderr:'pip unavailable'});const snapshot=await f.manager.snapshot({});assert.equal(snapshot.python.freeze.code,1);assert.match(snapshot.warnings.join('\n'),/pip freeze.*未完整记录/);
  const {runManaged}=await import('../framework/drawing-manager.mjs');const controller=new AbortController();const pending=runManaged(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:f.root,signal:controller.signal});await delay(100);controller.abort();const result=await pending;assert.match(result.error,/取消/);
});

test('启动与管理任务互斥；过期计划不可应用',async t=>{
  const f=await fixture(t);const plan=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});
  f.runtime.launchPromise=Promise.resolve();await assert.rejects(f.manager.apply({planId:plan.id}),/启动/);f.runtime.launchPromise=null;
  f.manager.active='fixture';assert.throws(()=>f.manager.assertIdle(),/管理任务/);f.manager.active=null;
  f.manager.planTtlMs=1;const expired=await f.manager.plan({operation:'install-plugin',url:f.origin,name:'Plugin'});await delay(10);await assert.rejects(f.manager.apply({planId:expired.id}),/过期/);
});

test('恢复本体提交不能删除后来纳入 Git 的新增插件或模型',async t=>{
  const f=await fixture(t);await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','core baseline');const saved=await f.manager.snapshot({});
  await writeFile(join(f.comfy,'custom_nodes','later.py'),'# later\n');await writeFile(join(f.comfy,'models','loras','later.bin'),'later');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','new user assets');
  await assert.rejects(f.manager.plan({operation:'restore',snapshotId:saved.id}),/新增.*资源|模型/);
  assert.equal(await readFile(join(f.comfy,'models','loras','later.bin'),'utf8'),'later');
});

test('只读 Git 索引不会执行仓库配置的 fsmonitor hook',async t=>{
  const f=await fixture(t);await git(f.comfy,'clone',f.origin,join('custom_nodes','Plugin'));const plugin=join(f.comfy,'custom_nodes','Plugin');
  const script=join(plugin,'.git','monitor.mjs');const marker=join(plugin,'fsmonitor-ran.txt');
  await writeFile(script,`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('token\\0');`);
  await git(plugin,'config','core.fsmonitor',`"${process.execPath.replaceAll('\\','/')}" "${script.replaceAll('\\','/')}"`);
  await git(plugin,'status','--porcelain');assert.equal(await readFile(marker,'utf8'),'ran');await rm(marker);
  const scan=await f.manager.inventory();assert.ok(scan.repositories.find(repo=>repo.id==='plugin:Plugin'));await assert.rejects(lstat(marker),{code:'ENOENT'});
});

test('HTTP 启动连接探测期间拒绝管理 apply，不能在依赖安装时启动进程',async t=>{
  const f=await fixture(t);await install(f);await f.manager.close();f.store.setEnabled('drawing',true);
  const probes=[];let spawned=0,installing=false;
  const app=await createWorkbench({dataDir:join(f.root,'data'),drawingOptions:{WebSocketImpl:null,fetchImpl:()=>new Promise((_resolve,reject)=>probes.push(reject)),runtimeOptions:{spawnImpl:()=>{spawned++;const child=new EventEmitter();child.pid=12345;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}}},drawingManagerOptions:{allowLocalRepositories:true,isRunning:async()=>false,runner:async(exe,args,options)=>{if(!args.includes('install'))return f.manager.runner(exe,args,options);installing=true;return new Promise(resolveResult=>options.signal.addEventListener('abort',()=>resolveResult({code:null,error:'cancelled',stdout:'',stderr:''}),{once:true}));}}});
  f.closers.push(()=>app.close());
  const post=async(path,value)=>{const response=await fetch(app.url+'/api/modules/drawing/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});return {status:response.status,value:await response.json()};};
  const plan=await post('manager/plan',{operation:'dependencies',repositoryId:'plugin:Plugin'});assert.equal(plan.status,200);
  const launching=post('launch',{});for(let i=0;i<100&&probes.length<2;i++)await delay(10);assert.equal(probes.length,2);
  const applying=await post('manager/apply',{planId:plan.value.id});
  for(const reject of probes)reject(Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}}));
  const launch=await launching;assert.equal(launch.status,200);assert.equal(applying.status,409);assert.equal(installing,false);assert.equal(spawned,1);
});

test('快照扫描期间切换目录或 Python 设置不能持久化混合环境快照',async t=>{
  const f=await fixture(t);await install(f);const before=f.manager.state().snapshots.length;const original=f.manager.repositories.runner;
  let release,entered=false;const gate=new Promise(resolveGate=>{release=resolveGate;});
  f.manager.repositories.runner=async(...args)=>{if(!entered){entered=true;await gate;}return original(...args);};
  const saving=f.manager.snapshot({name:'should not persist'});for(let i=0;i<100&&!entered;i++)await delay(10);assert.ok(entered);
  const changedPython=join(f.root,'other-python.exe');await writeFile(changedPython,'fixture');f.runtime.saveSettings({pythonPath:changedPython,vramMode:'cpu'});f.store.saveConfig('drawing',{comfyPath:join(f.root,'other-ComfyUI')});release();
  await assert.rejects(saving,/配置.*变化|环境.*变化/);assert.equal(f.manager.state().snapshots.length,before);
});

test('资料目录与 ComfyUI 跨盘时插件经同卷暂存校验后发布',async t=>{
  const f=await fixture(t);const qaRoot=join(process.cwd(),'qa');await mkdir(qaRoot,{recursive:true});const crossRoot=await mkdtemp(join(qaRoot,'drawing-manager-cross-'));
  f.closers.push(async()=>{await f.manager.close();assert.ok(resolve(crossRoot).startsWith(resolve(qaRoot)+sep));await rm(crossRoot,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
  if((await lstat(crossRoot)).dev===(await lstat(f.root)).dev){t.skip('当前工作区与临时目录位于同一卷');return;}
  const comfy=join(crossRoot,'ComfyUI');await mkdir(join(comfy,'comfy'),{recursive:true});await mkdir(join(comfy,'custom_nodes'));for(const name of ['main.py','nodes.py','server.py'])await writeFile(join(comfy,name),'# fixture\n');
  f.store.saveConfig('drawing',{comfyPath:comfy});const task=await install(f);assert.equal(task.status,'completed',task.error);assert.ok(task.snapshotId);assert.equal(await git(join(comfy,'custom_nodes','Plugin'),'rev-parse','HEAD'),f.first);
  assert.equal(await readFile(join(comfy,'custom_nodes','Plugin','plugin.py'),'utf8'),'one\n');
});

test('插件暂存校验失败时保持 disabled 且不发布或加入插件索引',async t=>{
  const f=await fixture(t);const original=f.manager.repositories.runner;f.manager.repositories.runner=(exe,args,options)=>args.includes('checkout')?Promise.resolve({code:1,stderr:'fixture checkout failure',stdout:''}):original(exe,args,options);
  const task=await install(f);assert.equal(task.status,'failed');assert.match(task.stagingPath,/\.disabled$/);assert.ok((await lstat(task.stagingPath)).isDirectory());await assert.rejects(lstat(join(f.comfy,'custom_nodes','Plugin')),{code:'ENOENT'});
  const scanned=await f.manager.inventory();assert.equal(scanned.repositories.filter(repo=>repo.kind==='plugin').length,0);
});

for(const revision of [undefined,'main'])test(`Git 更新${revision?'显式切换':'默认快进'}不能覆盖被忽略的用户文件`,async t=>{
  const f=await fixture(t);await writeFile(join(f.author,'.gitignore'),'settings.json\n');await git(f.author,'add','.gitignore');await git(f.author,'commit','-m','ignore local settings');await git(f.author,'push','origin','main');await install(f);
  const plugin=join(f.comfy,'custom_nodes','Plugin');const original=await git(plugin,'rev-parse','HEAD');await writeFile(join(plugin,'settings.json'),'USER SETTINGS');assert.equal(await git(plugin,'status','--porcelain=v1','--untracked-files=all'),'');
  await writeFile(join(f.author,'settings.json'),'UPSTREAM DEFAULT');await git(f.author,'add','-f','settings.json');await git(f.author,'commit','-m','add upstream defaults');await git(f.author,'push','origin','main');
  const plan=await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin',...(revision?{revision}:{})});const task=await finish(f.manager,await f.manager.apply({planId:plan.id}));
  assert.equal(task.status,'failed');assert.ok(task.snapshotId);assert.equal(await readFile(join(plugin,'settings.json'),'utf8'),'USER SETTINGS');assert.equal(await git(plugin,'rev-parse','HEAD'),original);
});

test('Git 快照恢复不能覆盖当前被忽略的用户文件',async t=>{
  const f=await fixture(t);await writeFile(join(f.author,'settings.json'),'OLD DEFAULT');await git(f.author,'add','settings.json');await git(f.author,'commit','-m','tracked defaults');await git(f.author,'push','origin','main');await install(f);const saved=await f.manager.snapshot({});
  await git(f.author,'rm','settings.json');await writeFile(join(f.author,'.gitignore'),'settings.json\n');await git(f.author,'add','.gitignore');await git(f.author,'commit','-m','move to local settings');await git(f.author,'push','origin','main');
  const updated=await finish(f.manager,await f.manager.apply({planId:(await f.manager.plan({operation:'update',repositoryId:'plugin:Plugin'})).id}));assert.equal(updated.status,'completed',updated.error);
  const plugin=join(f.comfy,'custom_nodes','Plugin');const original=await git(plugin,'rev-parse','HEAD');await writeFile(join(plugin,'settings.json'),'USER SETTINGS');assert.equal(await git(plugin,'status','--porcelain=v1','--untracked-files=all'),'');
  const task=await finish(f.manager,await f.manager.apply({planId:(await f.manager.plan({operation:'restore',snapshotId:saved.id})).id}));assert.equal(task.status,'failed');assert.ok(task.snapshotId);assert.equal(await readFile(join(plugin,'settings.json'),'utf8'),'USER SETTINGS');assert.equal(await git(plugin,'rev-parse','HEAD'),original);
});

test('恢复本体不能删除快照已有但当时未纳入本体 Git 的普通插件',async t=>{
  const f=await fixture(t);const plugin=join(f.comfy,'custom_nodes','my_plugin.py');await writeFile(plugin,'USER PLUGIN');await writeFile(join(f.comfy,'.gitignore'),'custom_nodes/\n');
  await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','core ignores local plugins');const saved=await f.manager.snapshot({});
  await git(f.comfy,'add','-f','custom_nodes/my_plugin.py');await git(f.comfy,'commit','-m','track existing plugin');const original=await git(f.comfy,'rev-parse','HEAD');
  await assert.rejects(f.manager.plan({operation:'restore',snapshotId:saved.id}),/插件.*未.*保存|插件.*资源|插件.*备份/);
  assert.equal(await readFile(plugin,'utf8'),'USER PLUGIN');assert.equal(await git(f.comfy,'rev-parse','HEAD'),original);
});

test('普通插件目录只有部分文件被核心 Git 保存时逐文件保护未保存内容',async t=>{
  const f=await fixture(t);const plugin=join(f.comfy,'custom_nodes','plain');await mkdir(plugin);await writeFile(join(plugin,'builtin.py'),'BUILTIN');await writeFile(join(plugin,'user.py'),'USER CONTENT');await writeFile(join(f.comfy,'.gitignore'),'custom_nodes/plain/user.py\n');
  await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','partial plugin backup');const saved=await f.manager.snapshot({});
  await git(f.comfy,'add','-f','custom_nodes/plain/user.py');await git(f.comfy,'commit','-m','track user file');const original=await git(f.comfy,'rev-parse','HEAD');
  await assert.rejects(f.manager.plan({operation:'restore',snapshotId:saved.id}),/插件.*未.*保存|插件.*资源/);assert.equal(await readFile(join(plugin,'user.py'),'utf8'),'USER CONTENT');assert.equal(await git(f.comfy,'rev-parse','HEAD'),original);
});

test('快照核心 Git 已保存的普通插件仍可正常恢复版本',async t=>{
  const f=await fixture(t);const plugin=join(f.comfy,'custom_nodes','builtin.py');await writeFile(plugin,'OLD BUILTIN\n');await writeFile(join(f.comfy,'.gitattributes'),'*.py text eol=lf\n');await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','tracked builtin');const saved=await f.manager.snapshot({});
  await writeFile(plugin,'NEW BUILTIN\n');await git(f.comfy,'commit','-am','new builtin');
  const task=await finish(f.manager,await f.manager.apply({planId:(await f.manager.plan({operation:'restore',snapshotId:saved.id})).id}));assert.equal(task.status,'completed',task.error);assert.equal(await readFile(plugin,'utf8'),'OLD BUILTIN\n');
});

async function coreUpdateFixture(f){
  await writeFile(join(f.comfy,'extra_model_paths.yaml'),'version: one\n');await writeFile(join(f.comfy,'.gitattributes'),'*.yaml text eol=lf\n');await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','core first');const original=await git(f.comfy,'rev-parse','HEAD');
  const origin=join(f.root,'core-origin.git'),author=join(f.root,'core-author');await git(f.root,'clone','--bare',f.comfy,origin);await git(f.comfy,'remote','add','origin',origin);await git(f.root,'clone',origin,author);
  await writeFile(join(author,'extra_model_paths.yaml'),'version: two\n');await git(author,'commit','-am','core second');await git(author,'push','origin','main');
  const plan=await f.manager.plan({operation:'update',repositoryId:'core'});return {plan,original};
}

test('手工快照先开始时 apply 必须等待结束，不能记录旧提交与新配置的混合快照',async t=>{
  const f=await fixture(t);const {plan,original}=await coreUpdateFixture(f);const runner=f.manager.repositories.runner;let release,entered=false;
  const gate=new Promise(resolveGate=>{release=resolveGate;});f.manager.repositories.runner=async(exe,args,options)=>{const result=await runner(exe,args,options);if(!entered&&args.slice(-2).join(' ')==='rev-parse HEAD'){entered=true;await gate;}return result;};
  const saving=f.manager.snapshot({});for(let i=0;i<100&&!entered;i++)await delay(10);assert.ok(entered);
  try{await assert.rejects(f.manager.apply({planId:plan.id}),/快照|管理任务/);}finally{release();await saving.catch(()=>{});}
  const snapshot=await saving;assert.equal(snapshot.repositories.find(repo=>repo.id==='core').git.head,original);assert.equal(Buffer.from(snapshot.files.find(file=>file.relativePath==='extra_model_paths.yaml').bytes,'base64').toString('utf8'),'version: one\n');
  assert.equal(f.manager.state().tasks.length,0);const task=await finish(f.manager,await f.manager.apply({planId:plan.id}));assert.equal(task.status,'completed',task.error);
});

test('apply 先开始时手工快照必须等待结束，自动操作前快照仍正常保存',async t=>{
  const f=await fixture(t);const {plan}=await coreUpdateFixture(f);const runner=f.manager.repositories.runner;let release,entered=false;
  const gate=new Promise(resolveGate=>{release=resolveGate;});f.manager.repositories.runner=async(exe,args,options)=>{if(!entered&&args.includes('fetch')){entered=true;await gate;}return runner(exe,args,options);};
  const task=await f.manager.apply({planId:plan.id});for(let i=0;i<400&&!entered;i++)await delay(10);assert.ok(entered);
  try{await assert.rejects(f.manager.snapshot({}),/管理任务|快照/);}finally{release();await finish(f.manager,task);}
  const completed=await finish(f.manager,task);assert.equal(completed.status,'completed',completed.error);assert.ok(completed.snapshotId);assert.equal(f.manager.state().snapshots.length,1);
  const saved=await f.manager.snapshot({});assert.equal(Buffer.from(saved.files.find(file=>file.relativePath==='extra_model_paths.yaml').bytes,'base64').toString('utf8'),'version: two\n');
});

for(const switchRoot of [false,true])test(`恢复期间${switchRoot?'切换目录并':'仅'}修改运行设置时保留新设置且报告部分恢复`,async t=>{
  const f=await fixture(t);await writeFile(join(f.comfy,'extra_model_paths.yaml'),'version: one\n');await writeFile(join(f.comfy,'.gitattributes'),'*.yaml text eol=lf\n');await git(f.comfy,'init','-b','main');await git(f.comfy,'add','.');await git(f.comfy,'commit','-m','before snapshot');const saved=await f.manager.snapshot({});
  await writeFile(join(f.comfy,'extra_model_paths.yaml'),'version: two\n');await git(f.comfy,'commit','-am','after snapshot');f.runtime.saveSettings({vramMode:'lowvram'});const plan=await f.manager.plan({operation:'restore',snapshotId:saved.id});
  const runner=f.manager.repositories.runner;let release,entered=false;const gate=new Promise(resolveGate=>{release=resolveGate;});f.manager.repositories.runner=async(exe,args,options)=>{if(!entered&&args.includes('checkout')){entered=true;await gate;}return runner(exe,args,options);};
  const task=await f.manager.apply({planId:plan.id});for(let i=0;i<300&&!entered;i++)await delay(10);assert.ok(entered);
  const currentRoot=switchRoot?join(f.root,'other-ComfyUI'):f.comfy;if(switchRoot)f.store.saveConfig('drawing',{comfyPath:currentRoot});f.runtime.saveSettings({vramMode:'cpu'});release();
  const result=await finish(f.manager,task);assert.equal(result.status,'failed');assert.match(result.error,/部分.*恢复/);assert.equal(f.runtime.settings().vramMode,'cpu');assert.equal(f.drawing.config().comfyPath,currentRoot);
});
