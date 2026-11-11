import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { VISION_PACKAGE } from '../framework/vision-package.mjs';
import { extractVisionArchive } from '../framework/vision-download.mjs';

const moduleResult = await import('../framework/vision-extension.mjs').catch(error => ({ importError:error }));
const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error('等待测试状态超时');
}

test('提供独立的视觉扩展控制器', () => assert.equal(typeof moduleResult.VisionExtension, 'function', moduleResult.importError?.message));

async function fixture(t, options = {}) {
  const { VisionExtension } = moduleResult;
  assert.equal(typeof VisionExtension, 'function', '视觉扩展控制器尚未实现');
  const root = await mkdtemp(join(tmpdir(), 'workbench-vision-'));
  const contents = { model:Buffer.alloc(96 * 1024, 31), projector:Buffer.alloc(16 * 1024, 47), runtime:Buffer.alloc(8 * 1024, 63) };
  const requests = [], spawns = [], children = [], settings = new Map();
  const flags = { slow:false, stall:false, corrupt:null, fail:null, health:true, wrongAlias:false, auth:true, ...options.flags };
  const store = { getSetting:key => structuredClone(settings.get(key)), setSetting:(key,value) => settings.set(key,structuredClone(value)) };
  const server = createServer((req,res) => {
    const id = req.url.slice(1), payload = contents[id];
    requests.push({id,range:req.headers.range});
    if (flags.fail === id) { res.writeHead(503).end(); return; }
    const bytes = flags.corrupt === id ? Buffer.alloc(payload.length,1) : payload;
    const offset = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1] || 0);
    res.writeHead(offset ? 206 : 200, {'content-length':bytes.length-offset,'content-type':'application/octet-stream',
      ...(offset ? {'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`} : {})});
    let cursor = offset;
    const pump = () => {
      if (res.destroyed) return;
      if (cursor >= bytes.length) { res.end(); return; }
      const next = Math.min(cursor+4096,bytes.length); res.write(bytes.subarray(cursor,next)); cursor=next;
      if(!flags.stall)setTimeout(pump,flags.slow ? 12 : 0);
    };
    pump();
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const required = ['llama-server.exe','llama-server-impl.dll','llama.dll','ggml.dll','ggml-base.dll','ggml-cpu.dll','ggml-vulkan.dll','mtmd.dll','libomp.dll'];
  const packageSpec = {id:'qwen-test-package',name:'测试视觉扩展',model:'Qwen3.5-4B',quantization:'Q4_K_M',requirements:['Windows x64'],links:[],
    files:Object.entries(contents).map(([id,bytes])=>({id,filename:id==='runtime'?'runtime.zip':`${id}.gguf`,url:`http://127.0.0.1:${server.address().port}/${id}`,bytes:bytes.length,sha256:digest(bytes)})),
    runtime:{directory:'runtime',executable:'llama-server.exe',requiredFiles:required,unpackedBytes:required.length*7},
    alias:'workbench-qwen-vision'};
  packageSpec.downloadBytes=packageSpec.files.reduce((sum,file)=>sum+file.bytes,0);
  packageSpec.installedBytes=packageSpec.downloadBytes+packageSpec.runtime.unpackedBytes;
  packageSpec.peakDiskBytes=packageSpec.installedBytes+packageSpec.runtime.unpackedBytes;
  const spawnImpl = (file,args,spawnOptions) => {
    const child = new EventEmitter(); child.stderr=new PassThrough(); child.stdout=new PassThrough(); child.pid=123456+children.length; child.exitCode=null; child.signalCode=null;
    const port=Number(args[args.indexOf('--port')+1]);
    const runtimeServer=createServer((req,res)=>{
      if (flags.auth&&req.headers.authorization!==`Bearer ${spawnOptions.env.LLAMA_API_KEY}`) { res.writeHead(401).end(); return; }
      res.setHeader('content-type','application/json');
      if (req.url==='/health') res.writeHead(flags.health?200:503).end(JSON.stringify({status:flags.health?'ok':'loading model'}));
      else res.end(JSON.stringify({data:[{id:flags.wrongAlias?'external-model':packageSpec.alias}]}));
    });
    let stopped=false;
    child.kill = signal => {
      if (stopped) return false; stopped=true; child.signalCode=signal; child.exitCode=0;
      runtimeServer.closeAllConnections(); runtimeServer.close(()=>child.emit('exit',0,signal));
      if (!runtimeServer.listening) queueMicrotask(()=>child.emit('exit',0,signal));
      return true;
    };
    runtimeServer.on('error',error=>child.emit('error',error));
    runtimeServer.listen(port,'127.0.0.1');
    spawns.push({file,args,options:spawnOptions}); children.push(child); return child;
  };
  const extractImpl = async ({destination,signal}) => {
    await mkdir(destination,{recursive:true});
    for (const file of required) { signal.throwIfAborted(); await writeFile(join(destination,file),'runtime'); }
  };
  const args = {store,dataDir:root,packageSpec,platform:'win32',arch:'x64',spawnImpl,extractImpl,startupTimeoutMs:500,healthIntervalMs:10,
    chooseDirectory:async()=>null,...options.engine};
  let extension = new VisionExtension(args);
  await extension.ready;
  t.after(async()=>{
    try{await extension.close();}
    finally{
      for(const child of children) child.kill('SIGTERM');
      server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true});
    }
  });
  return {root,contents,requests,spawns,children,settings,store,flags,args,packageSpec,get extension(){return extension;},
    packageRoot:join(root,'resources','vision',packageSpec.id),
    install:async()=>{extension.install({startAfter:true});await extension.waitForIdle();return extension.state();},
    restart:async()=>{await extension.close();extension=new VisionExtension(args);await extension.ready;return extension;}};
}

test('未安装时不自动下载，公开状态不带凭据且严格限制请求字段',async t=>{
  const f=await fixture(t); const state=f.extension.state();
  assert.equal(state.installed,false);assert.equal(state.runtime.status,'stopped');assert.equal(state.autoStart,false);
  assert.equal(state.directory,join(f.root,'resources','vision'));assert.equal(f.requests.length,0);
  assert.equal(JSON.stringify(state).includes('apiKey'),false);
  assert.throws(()=>f.extension.install({url:'https://example.com/evil'}),/字段/);
  assert.throws(()=>f.extension.connection({}),/启动|运行/);
});

test('显式选择安装后启动时，真实流式下载校验全部运行库并启动鉴权服务',async t=>{
  const f=await fixture(t);const immediate=f.extension.install({startAfter:true});assert.equal(immediate.task.status,'running');
  await f.extension.waitForIdle();const state=f.extension.state();
  assert.equal(state.task.status,'completed',state.task.error);assert.equal(state.runtime.status,'running',state.runtime.error);assert.equal(state.installed,true);
  assert.equal(state.task.completedBytes,state.package.downloadBytes);assert.equal(f.requests.length,3);
  for(const file of f.packageSpec.files)assert.equal(digest(await readFile(join(f.packageRoot,file.filename))),file.sha256);
  for(const file of f.packageSpec.runtime.requiredFiles)assert.ok((await stat(join(f.packageRoot,'runtime',file))).isFile());
  const media=f.extension.connection({}).media;assert.equal(media.localVisionEnabled,true);assert.equal(media.localVisionModel,'workbench-qwen-vision');assert.match(media.localVisionKey,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(state).includes(media.localVisionKey),false);
  const launch=f.spawns[0];assert.equal(launch.options.windowsHide,true);assert.equal(launch.options.shell,false);assert.equal(launch.options.env.LLAMA_API_KEY,media.localVisionKey);
  for(const flag of ['--host','--port','--alias','--model','--mmproj','--jinja','--chat-template-kwargs','--ctx-size','--parallel'])assert.ok(launch.args.includes(flag));
  assert.equal(launch.args[launch.args.indexOf('--host')+1],'127.0.0.1');assert.equal(launch.args.includes(media.localVisionKey),false);
});

test('视觉运行进程持有跨窗口资源租约，停止后才允许回收',async t=>{
  const {acquireResourceStorageLease}=await import('../framework/resource-storage.mjs');
  const f=await fixture(t);assert.equal((await f.install()).runtime.status,'running');
  assert.throws(()=>acquireResourceStorageLease(f.root,'vision',{exclusive:true}),/使用|维护/);
  await f.extension.stop({});acquireResourceStorageLease(f.root,'vision',{exclusive:true})();
});

test('损坏下载不发布；重试重用已验证文件',async t=>{
  const f=await fixture(t,{flags:{corrupt:'projector'}});const failed=await f.install();
  assert.equal(failed.task.status,'failed');assert.match(failed.task.error,/SHA256/);assert.equal(f.spawns.length,0);
  await assert.rejects(stat(join(f.packageRoot,'projector.gguf')),{code:'ENOENT'});
  f.flags.corrupt=null;const done=await f.install();assert.equal(done.task.status,'completed',done.task.error);
  assert.equal(f.requests.filter(r=>r.id==='model').length,1);assert.equal(f.requests.filter(r=>r.id==='projector').length,2);
});

test('取消下载保留部分文件，重试续传且取消后不会启动进程',async t=>{
  const f=await fixture(t,{flags:{slow:true}});f.extension.install({});await until(()=>f.extension.state().task.completedBytes>0);
  await f.extension.cancel({});assert.equal(f.extension.state().task.status,'cancelled');assert.equal(f.spawns.length,0);
  const size=(await stat(join(f.packageRoot,'model.gguf.part'))).size;assert.ok(size>0&&size<f.contents.model.length);
  const done=await f.install();assert.equal(done.task.status,'completed',done.task.error);assert.ok(f.requests.some(r=>r.id==='model'&&r.range===`bytes=${size}-`));
});

test('close 保持自启意图，重启复用端口与密钥；显式停止后不自启',async t=>{
  const f=await fixture(t);assert.equal((await f.install()).runtime.status,'running');const original=f.extension.connection({});
  await f.restart();assert.equal(f.extension.state().runtime.status,'running');assert.deepEqual(f.extension.connection({}),original);assert.equal(f.requests.length,3);
  await f.extension.stop({});assert.equal(f.extension.state().autoStart,false);assert.equal(f.extension.state().runtime.status,'stopped');
  await f.restart();assert.equal(f.extension.state().runtime.status,'stopped');assert.equal(f.spawns.length,2);
});

test('他人占用已分配端口时不接管也不结束其进程',async t=>{
  const f=await fixture(t);await f.install();const url=new URL(f.extension.connection({}).media.localVisionBaseUrl);await f.extension.stop({});
  const external=createServer((req,res)=>res.end('external'));await new Promise(resolve=>external.listen(Number(url.port),'127.0.0.1',resolve));
  try { f.extension.start({});await f.extension.waitForIdle();assert.equal(f.extension.state().runtime.status,'failed');assert.match(f.extension.state().runtime.error,/端口.*占用/);assert.equal(f.spawns.length,1);assert.equal(await (await fetch(url.origin)).text(),'external'); }
  finally {external.closeAllConnections();await new Promise(resolve=>external.close(resolve));}
});

test('CPU 启动关闭视觉 GPU 卸载；运行时禁止切换目录',async t=>{
  const f=await fixture(t);await f.install();await assert.rejects(f.extension.chooseDirectory({}),/停止|运行/);await f.extension.stop({});
  f.extension.start({device:'cpu'});await f.extension.waitForIdle();assert.equal(f.extension.state().runtime.status,'running');
  assert.ok(f.spawns.at(-1).args.includes('--no-mmproj-offload'));assert.equal(f.spawns.at(-1).args[f.spawns.at(-1).args.indexOf('-ngl')+1],'0');
});

test('手动关联的三个视觉组件原样进入运行器命令，保存路径不会下载或自动启动',async t=>{
  const f=await fixture(t),modelPath=join(f.root,'selected-model.gguf'),projectorPath=join(f.root,'selected-projector.gguf'),runtimePath=join(f.root,'llama-server.exe');
  await writeFile(modelPath,'GGUF fixture model');await writeFile(projectorPath,'GGUF fixture projector');await writeFile(runtimePath,'fixture runtime');
  await f.extension.configure({modelPath,projectorPath,runtimePath});assert.equal(f.spawns.length,0);assert.equal(f.requests.length,0);
  assert.deepEqual(f.settings.get('vision.extension').bindings,{modelPath,projectorPath,runtimePath});
  f.extension.start({});await f.extension.waitForIdle();assert.equal(f.extension.state().runtime.status,'running');
  const command=f.spawns[0];assert.equal(command.file,runtimePath);assert.equal(command.args[command.args.indexOf('--model')+1],modelPath);assert.equal(command.args[command.args.indexOf('--mmproj')+1],projectorPath);
});

test('服务健康或模型别名校验未通过时终止自己的子进程并报告失败',async t=>{
  const f=await fixture(t,{flags:{wrongAlias:true}});const state=await f.install();assert.equal(state.runtime.status,'failed');assert.match(state.runtime.error,/启动|模型|超时/);
  assert.equal(state.task.status,'failed');assert.notEqual(f.children[0].exitCode,null);assert.throws(()=>f.extension.connection({}),/运行|启动/);
});

test('真实 b12110 压缩包解压后所有必需 DLL 均存在',async t=>{
  const archive=join(process.cwd(),'artifacts','vision-extension','llama-b12110-bin-win-vulkan-x64.zip');
  if(!await stat(archive).catch(()=>null)){t.skip('当前检出未带本地发布包');return;}
  const root=await mkdtemp(join(tmpdir(),'vision-real-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const destination=join(root,'runtime');
  await extractVisionArchive({archive,destination,unpackedBytes:VISION_PACKAGE.runtime.unpackedBytes,signal:new AbortController().signal});
  for(const filename of VISION_PACKAGE.runtime.requiredFiles)assert.ok((await stat(join(destination,filename))).isFile(),filename);
});

test('取消服务启动会清除自启意图，重启不偷偷加载模型',async t=>{
  const f=await fixture(t,{flags:{health:false}});f.extension.install({startAfter:true});await until(()=>f.spawns.length===1);
  await f.extension.cancel({});assert.equal(f.extension.state().task.status,'cancelled');assert.equal(f.extension.state().autoStart,false);
  await f.restart();assert.equal(f.extension.state().runtime.status,'stopped');assert.equal(f.spawns.length,1);
});

test('安装期间关闭并重启，只恢复中断记录而不重新下载',async t=>{
  const f=await fixture(t,{flags:{slow:true}});f.extension.install({});await until(()=>f.extension.state().task.completedBytes>0);
  await f.restart();assert.equal(f.extension.state().task.status,'interrupted');assert.equal(f.spawns.length,0);const count=f.requests.length;
  await sleep(30);assert.equal(f.requests.length,count);assert.equal((await f.install()).task.status,'completed');
});

test('新目录通过原生选择器传入，取消选择不改状态且原安装文件保留',async t=>{
  const choices=[],f=await fixture(t,{engine:{chooseDirectory:async options=>{choices.push(options);return choices.length===1?null:join(f.root,'another');}}});
  await f.install();await f.extension.stop({});const directory=f.extension.state().directory;
  await f.extension.chooseDirectory({});assert.equal(f.extension.state().directory,directory);
  await mkdir(join(f.root,'another'));await f.extension.chooseDirectory({});assert.equal(f.extension.state().installed,false);assert.equal(f.extension.state().autoStart,false);
  assert.deepEqual(choices[0],{moduleId:'qq',defaultPath:directory});assert.ok(await stat(join(f.packageRoot,'model.gguf')));
});

test('已安装后丢失关键 DLL 时启动失败，不会拉起残缺运行器',async t=>{
  const f=await fixture(t);await f.install();await f.extension.stop({});await rm(join(f.packageRoot,'runtime','llama-server-impl.dll'));
  f.extension.start({});await f.extension.waitForIdle();assert.equal(f.extension.state().installed,false);assert.equal(f.extension.state().runtime.status,'failed');assert.equal(f.spawns.length,1);
});

test('进程意外退出后的错误隐藏密钥，状态不再允许取得连接',async t=>{
  const f=await fixture(t);await f.install();const secret=f.extension.connection({}).media.localVisionKey;
  f.children[0].stderr.write(`fatal key=${secret}`);f.children[0].kill('SIGKILL');await until(()=>f.extension.state().runtime.status==='failed');
  assert.equal(JSON.stringify(f.extension.state()).includes(secret),false);assert.match(f.extension.state().runtime.error,/fatal key=/);assert.throws(()=>f.extension.connection({}),/运行|启动/);
});

test('后台尚未恢复完成时的安装请求不会同时自动启动旧服务',async t=>{
  const f=await fixture(t);await f.install();await f.extension.close();
  const extension=new moduleResult.VisionExtension(f.args);t.after(()=>extension.close());
  extension.install({startAfter:true});await extension.waitForIdle();assert.equal(extension.state().task.status,'completed',extension.state().task.error);assert.equal(f.spawns.length,2);
});

test('健康接口正常但未启用 API 鉴权的服务不被认作安全就绪',async t=>{
  const f=await fixture(t,{flags:{auth:false}});const state=await f.install();assert.equal(state.runtime.status,'failed');assert.equal(state.task.status,'failed');
});

test('下载空闲超时会终止连接并保留部分字节供重试',async t=>{
  const f=await fixture(t,{flags:{stall:true},engine:{idleTimeoutMs:80}});const started=Date.now(),state=await f.install();
  assert.equal(state.task.status,'failed');assert.match(state.task.error,/响应|超时/);assert.ok(Date.now()-started<2000);assert.equal(f.spawns.length,0);
  f.flags.stall=false;assert.equal((await f.install()).task.status,'completed');assert.ok(f.requests.some(r=>r.range));
});

test('在解压暂停点取消后即使解压器稍后返回，也不发布运行器或启动进程',async t=>{
  let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{engine:{extractImpl:async()=>{entered=true;await gate;}}});f.extension.install({});await until(()=>entered);
  const pending=f.extension.cancel({});release();await pending;
  assert.equal(f.extension.state().task.status,'cancelled');assert.equal(f.spawns.length,0);await assert.rejects(stat(join(f.packageRoot,'installed.json')),{code:'ENOENT'});
});

test('启动超时和 spawn error 均被吸收为可读失败状态',async t=>{
  const f=await fixture(t,{engine:{spawnImpl:()=>{
    const child=new EventEmitter();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('error',new Error('缺少运行库')));return child;
  }}});const state=await f.install();assert.equal(state.runtime.status,'failed');assert.match(state.runtime.error,/缺少运行库/);assert.equal(state.task.status,'failed');
});

function zipFile(name, content, attributes=0) {
  const filename=Buffer.from(name),bytes=Buffer.from(content);let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
  crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(attributes>>>0,38);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+bytes.length,16);
  return Buffer.concat([local,filename,bytes,central,filename,end]);
}

for(const [name,attributes] of [['../escaped.txt',0],['C:/escaped.txt',0],['link.dll',(0xa1ff<<16)>>>0]])test(`安全解压拒绝 ${name}`,async t=>{
  if(process.platform!=='win32'){t.skip('使用 Windows PowerShell 7 解压入口');return;}
  const root=await mkdtemp(join(tmpdir(),'vision-zip-'));t.after(()=>rm(root,{recursive:true,force:true}));const archive=join(root,'runtime.zip');
  await writeFile(archive,zipFile(name,'bad',attributes));
  await assert.rejects(extractVisionArchive({archive,destination:join(root,'out'),unpackedBytes:3,signal:new AbortController().signal}),/路径|符号链接|绝对/);
  await assert.rejects(stat(join(root,'escaped.txt')),{code:'ENOENT'});
});

test('不支持的系统不会下载或启动',async t=>{
  const f=await fixture(t,{engine:{platform:'darwin'}});assert.equal(f.extension.state().supported,false);assert.throws(()=>f.extension.install({}),/Windows x64/);assert.equal(f.requests.length,0);
});

test('服务发出进程错误但尚未退出时仍保留所有权并停止它',async t=>{
  const f=await fixture(t);await f.install();const child=f.children[0];child.emit('error',new Error('进程通信故障'));
  await until(()=>f.extension.state().runtime.status==='failed');await f.extension.stop({});assert.notEqual(child.exitCode,null);
});

test('子进程拒绝终止时保留所有权并报告失败，不会变成未处理拒绝或另起进程',async t=>{
  const f=await fixture(t,{flags:{health:false},engine:{startupTimeoutMs:180,stopTimeoutMs:15}});f.extension.install({startAfter:true});await until(()=>f.children.length===1);
  const child=f.children[0],kill=child.kill;child.kill=()=>false;
  try{await f.extension.waitForIdle();assert.equal(f.extension.state().runtime.status,'failed');assert.match(f.extension.state().runtime.error,/退出|停止/);assert.throws(()=>f.extension.start({}),/停止|运行/);assert.equal(f.spawns.length,1);}
  finally{child.kill=kill;await f.extension.stop({});}
});

test('首次安装或手动启动失败不会建立自动恢复意愿',async t=>{
  const f=await fixture(t,{flags:{health:false},engine:{startupTimeoutMs:100}});
  assert.equal((await f.install()).runtime.status,'failed');assert.equal(f.extension.state().autoStart,false);
  assert.equal(f.store.getSetting('vision.extension').autoStart,false);
  await f.restart();assert.equal(f.spawns.length,1);assert.equal(f.extension.state().runtime.status,'stopped');
  f.extension.start({});await f.extension.waitForIdle();assert.equal(f.extension.state().runtime.status,'failed');assert.equal(f.extension.state().autoStart,false);
  await f.restart();assert.equal(f.spawns.length,2);assert.equal(f.extension.state().runtime.status,'stopped');
});

test('成功运行建立的恢复意愿在后续恢复失败时保留',async t=>{
  const f=await fixture(t,{engine:{startupTimeoutMs:100}});assert.equal((await f.install()).autoStart,true);
  f.flags.health=false;await f.restart();assert.equal(f.extension.state().runtime.status,'failed');assert.equal(f.extension.state().autoStart,true);
  f.flags.health=true;await f.restart();assert.equal(f.extension.state().runtime.status,'running');assert.equal(f.extension.state().autoStart,true);
});

for(const action of ['stop','cancel','close'])test(`鉴权检查返回前 ${action} 不会被迟到的就绪响应重新启用自启`,async t=>{
  let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{engine:{fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/v1/chat/completions')){entered=true;await gate;return new Response('',{status:401});}
    return fetch(url,options);
  }}});
  f.extension.install({startAfter:true});await until(()=>entered);const stopping=f.extension[action]({});release();await stopping;
  assert.equal(f.extension.state().autoStart,false);assert.equal(f.extension.state().runtime.status,'stopped');
  assert.equal(f.store.getSetting('vision.extension').autoStart,false);
  await f.restart();assert.equal(f.spawns.length,1);assert.equal(f.extension.state().runtime.status,'stopped');
});

test('initialized 完成本地安装状态检查，不等待自动恢复服务的健康响应',async t=>{
  const f=await fixture(t);await f.install();await f.extension.close();
  let release,entered=false;const gate=new Promise(resolve=>{release=resolve;});
  const extension=new moduleResult.VisionExtension({...f.args,fetchImpl:async(url,options)=>{
    if(String(url).endsWith('/health')){entered=true;await gate;}
    return fetch(url,options);
  }});
  t.after(async()=>{release();await extension.close();});
  assert.equal(typeof extension.initialized?.then,'function');await extension.initialized;
  assert.equal(extension.state().installed,true);assert.notEqual(extension.state().runtime.status,'running');
  await until(()=>entered);assert.equal(extension.state().runtime.status,'starting');
  release();await extension.ready;assert.equal(extension.state().runtime.status,'running');
});

test('initialized 检查未安装目录时不下载或启动，也不自动创建目录',async t=>{
  const f=await fixture(t);assert.equal(typeof f.extension.initialized?.then,'function');await f.extension.initialized;
  assert.equal(f.extension.state().installed,false);assert.equal(f.requests.length,0);assert.equal(f.spawns.length,0);
  await assert.rejects(stat(join(f.root,'resources','vision')),{code:'ENOENT'});
});

test('关闭失败后恢复可操作状态，保留自启意愿与进程所有权并允许再次停止',async t=>{
  const f=await fixture(t,{engine:{stopTimeoutMs:10}});await f.install();const child=f.children[0],kill=child.kill;child.kill=()=>false;
  try{
    await assert.rejects(f.extension.close(),/进程尚未退出/);
    assert.equal(f.extension.state().runtime.status,'failed');assert.match(f.extension.state().runtime.error,/进程尚未退出/);
    assert.equal(f.extension.state().autoStart,true);assert.equal(child.exitCode,null);
    child.kill=kill;await f.extension.stop({});
    assert.notEqual(child.exitCode,null);assert.equal(f.extension.state().runtime.status,'stopped');assert.equal(f.extension.state().autoStart,false);
    const closed=f.extension.close();await closed;assert.equal(f.extension.close(),closed);
  }finally{child.kill=kill;}
});

test('关闭失败后进程稍后退出，下一次关闭可成功且不会重放旧的拒绝',async t=>{
  const f=await fixture(t,{engine:{stopTimeoutMs:10}});await f.install();const child=f.children[0],kill=child.kill;child.kill=()=>false;
  try{
    await assert.rejects(f.extension.close(),/进程尚未退出/);assert.equal(f.extension.state().autoStart,true);
    child.kill=kill;child.kill('SIGTERM');await until(()=>!f.extension.child);
    const closed=f.extension.close();await closed;assert.equal(f.extension.close(),closed);
    assert.equal(f.extension.state().runtime.status,'stopped');assert.equal(f.extension.state().autoStart,true);
  }finally{child.kill=kill;}
});
