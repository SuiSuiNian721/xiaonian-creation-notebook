import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { QQRuntime } = await import('../framework/qq-runtime.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  assert.equal(typeof QQRuntime, 'function', '需要可独立管理的 QQ 运行端');
  const directory = await mkdtemp(join(tmpdir(), 'qq-runtime-'));
  let online = false, account = '70001', credentials = 0, sentConfig;
  const calls = [], children = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    calls.push(req.url);
    let data;
    if (req.url === '/api/auth/login') { credentials++; data = { Credential: 'fixture-credential' }; }
    else if (req.headers.authorization !== 'Bearer fixture-credential') { res.end(JSON.stringify({code:-1,message:'bad credential'}));return; }
    else if (req.url.endsWith('CheckLoginStatus')) data = { isLogin: online, coreReady: online, loginPhase: online ? 'online' : 'waiting_qrcode' };
    else if (req.url.endsWith('GetQQLoginQrcode')) data = { qrcode: 'https://qq.example/login?ticket=private-qr' };
    else if (req.url.endsWith('RefreshQRcode')) data = { qrcodeurl: 'https://qq.example/login?ticket=new-private-qr' };
    else if (req.url.endsWith('GetQQLoginInfo')) data = { uin: account, nick: '测试角色', online:true };
    else if (req.url.endsWith('SetConfig')) { sentConfig = JSON.parse(value.config);await writeFile(join(children[0].options.env.NAPCAT_WORKDIR,'config/onebot11_'+account+'.json'),value.config,'utf8'); data = null; }
    else { res.statusCode=404; res.end('{}');return; }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({code:0,data}));
  });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  const port = server.address().port;
  const bytes=Buffer.from('test package'), packageSpec={version:'fixture-v1',url:'https://example.test/runtime.zip',sha256:digest(bytes),downloadBytes:bytes.length};
  let allocated=0;
  let processState=null;
  const processHost={
    async recover(){return children.at(-1)?.child.exitCode===null?processState:null;},
    async start(input){const child=runtime.spawn(input.command,input.args,input.options);await new Promise((done,reject)=>{child.once('error',reject);setImmediate(done);});processState={pid:child.pid,childPid:child.pid,status:'running',webPort:input.webPort,onebotPort:input.onebotPort};return processState;},
    async stop(){children.at(-1)?.child.kill();processState=null;},async close(){},
  };
  const runtime = new QQRuntime({dataDir:directory,packageSpec,processHost,
    fetchImpl:async (url,options) => String(url) === packageSpec.url ? new Response(bytes) : fetch(url,options),
    allocatePort:async()=>++allocated===1?port:port+1,
    extractImpl:async (_archive,destination)=>{ await mkdir(join(destination,'napcat'),{recursive:true});for(const name of ['node.exe','index.js','wrapper.node','QQNT.dll','napcat/napcat.mjs'])await writeFile(join(destination,name),'fixture content'); },
    spawnImpl:(command,args,options)=>{
      const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.pid=9876;child.exitCode=null;
      child.kill=()=>{child.exitCode=0;queueMicrotask(()=>child.emit('exit',0,null));return true;};
      children.push({child,command,args,options});return child;
    },startupTimeoutMs:1000,
  });
  t.after(async()=>{try{await runtime.close();await processHost.stop();}finally{await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}});
  return {runtime,directory,calls,children,packageSpec,processHost,reopen:()=>new QQRuntime({dataDir:directory,packageSpec,processHost}),setOnline(value){online=value;},setAccount(value){account=value;},get config(){return sentConfig;},get credentials(){return credentials;}};
}

test('QQ 状态查询不启动进程、不访问网关，外接配置令牌不回显',async t=>{
  const f=await fixture(t);assert.equal(f.runtime.state().running,false);assert.equal(f.calls.length,0);
  await f.runtime.configure({mode:'external',wsUrl:'ws://127.0.0.1:31000',accountId:'70001',token:'secret-onebot'});
  assert.equal(f.runtime.connection().token,'secret-onebot');assert.equal(f.runtime.connection().expectedAccountId,'70001');
  assert.equal(JSON.stringify(f.runtime.state()).includes('secret-onebot'),false);assert.equal(f.children.length,0);
  await assert.rejects(f.runtime.configure({mode:'external',wsUrl:'http://127.0.0.1:3001',accountId:'70001'}));
});

test('采用扫描找到的组件前重新校验，失败时保留运行方式和当前槽位',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});
  const path=f.runtime.state().installation.installDirectory,slot=f.runtime.config.slotId;
  await f.runtime.configure({mode:'external',wsUrl:'ws://127.0.0.1:31000',accountId:'70001'});
  await writeFile(join(path,'wrapper.node'),'changed after scan');
  await assert.rejects(f.runtime.configure({mode:'managed',installDirectory:path}),/wrapper\.node.*校验失败/);
  assert.equal(f.runtime.state().mode,'external');assert.equal(f.runtime.config.slotId,slot);assert.equal(f.children.length,0);
  await assert.rejects(f.runtime.configure({mode:'managed',installDirectory:join(f.directory,'not-a-package')}),/workbench-qq-runtime\.json/);
  assert.equal(f.runtime.state().mode,'external');
});

test('固定包校验后安装；扫码使用独立目录、回环端口和两个不同令牌',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install'),report:()=>{}});
  assert.equal(f.runtime.state().installation.status,'ready');
  const state=await f.runtime.startLogin();assert.equal(state.login.status,'waiting_qrcode');assert.ok(state.login.sessionId);assert.ok(state.login.qrcodeUrl);
  const settings=f.children[0].options;assert.equal(settings.windowsHide,true);assert.ok(settings.env.NAPCAT_QQ_DATA_DIR.startsWith(f.directory));assert.ok(settings.env.NAPCAT_WORKDIR.startsWith(f.directory));
  const web=JSON.parse(await readFile(join(settings.env.NAPCAT_WORKDIR,'config/webui.json'),'utf8'));assert.equal(web.host,'127.0.0.1');assert.ok(web.token.length>=32);
  assert.equal(JSON.stringify(state).includes(web.token),false);assert.throws(()=>f.runtime.connection(),/登录|在线/);
  f.setOnline(true);const verified=await f.runtime.pollLogin({sessionId:state.login.sessionId});assert.equal(verified.login.status,'online');assert.equal(verified.login.accountId,'70001');
  const connection=f.runtime.connection();assert.equal(connection.expectedAccountId,'70001');assert.notEqual(connection.token,web.token);
  assert.equal(f.config.network.websocketServers[0].host,'127.0.0.1');assert.equal(f.config.network.websocketServers[0].token,connection.token);
});

test('刷新和取消二维码令旧登录会话失效；换号不能覆盖已绑定账号',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install'),report:()=>{}});
  const first=await f.runtime.startLogin(),next=await f.runtime.refreshLogin({sessionId:first.login.sessionId});
  assert.notEqual(first.login.sessionId,next.login.sessionId);
  await assert.rejects(f.runtime.pollLogin({sessionId:first.login.sessionId}),/失效|过期/);
  f.setOnline(true);await f.runtime.pollLogin({sessionId:next.login.sessionId});f.setAccount('70002');
  await assert.rejects(f.runtime.pollLogin({sessionId:next.login.sessionId}),/账号|身份/);
  assert.throws(()=>f.runtime.connection(),/账号|在线|登录/);
  await f.runtime.cancelLogin({sessionId:next.login.sessionId});assert.equal(f.runtime.state().running,false);
});

test('安装内容被改动后拒绝启动，保留用户现有文件',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install'),report:()=>{}});
  await writeFile(join(f.runtime.state().installation.installDirectory,'index.js'),'modified');
  await assert.rejects(f.runtime.startLogin(),/校验|变化|修改/);assert.equal(f.children.length,0);
});

test('启动预检尚未完成时关闭，不得迟到创建 QQ 进程',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install'),report:()=>{}});
  let release;const barrier=new Promise(done=>{release=done;});const verify=f.runtime.verify.bind(f.runtime);
  f.runtime.verify=async()=>{await verify();await barrier;return true;};
  const started=f.runtime.startLogin();await new Promise(done=>setImmediate(done));await f.runtime.close();release();
  await assert.rejects(started,/取消|关闭/);assert.equal(f.children.length,0);assert.equal(f.runtime.state().running,false);
});

test('spawn 失败只产生 error/close 时释放句柄，可以重新配置',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install'),report:()=>{}});
  f.runtime.spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;child.kill=()=>false;queueMicrotask(()=>{child.emit('error',new Error('EPERM'));child.emit('close',-1);});return child;};
  await assert.rejects(f.runtime.startLogin(),/启动|退出/);assert.equal(f.runtime.state().running,false);
  await f.runtime.configure({mode:'external',wsUrl:'ws://127.0.0.1:31000',accountId:'70001'});
});

test('UNC 与设备路径在持久化前拒绝，保留原运行配置',async t=>{
  const f=await fixture(t);const before=await readFile(f.runtime.file,'utf8');
  // 避免旧实现的 inspect 对 UNC 产生文件系统探测，只验证输入与落盘边界。
  f.runtime.inspect=()=>{};
  await assert.rejects(f.runtime.configure({installDirectory:'//localhost/qq-test-no-access'}),/本地|路径|目录/);
  assert.equal(await readFile(f.runtime.file,'utf8'),before);
});

test('重复访问令牌查询参数被拒绝，空参数移除，状态不回显令牌',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.runtime.configure({mode:'external',accountId:'70001',wsUrl:'ws://127.0.0.1:3001/?access_token=&access_token=private-token'}),/令牌|重复/);
  await f.runtime.configure({mode:'external',accountId:'70001',wsUrl:'ws://127.0.0.1:3001/?access_token='});
  assert.equal(f.runtime.state().external.wsUrl.includes('access_token'),false);
});

test('安装最后校验期间取消，不发布为 ready 或绑定安装目录',async t=>{
  const f=await fixture(t),cancel=new AbortController(),verify=f.runtime.verify.bind(f.runtime);
  f.runtime.verify=async directory=>{const valid=await verify(directory);cancel.abort();return valid;};
  await assert.rejects(f.runtime.install({directory:join(f.directory,'install'),signal:cancel.signal}),/中断|取消/);
  assert.notEqual(f.runtime.state().installation.status,'ready');
  assert.equal(JSON.parse(await readFile(f.runtime.file,'utf8')).installDirectory,'');
});

test('关闭工作台保留 QQ，重开接回同一进程与端口且不重写配置',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});
  const first=await f.runtime.startLogin();f.setOnline(true);await f.runtime.pollLogin({sessionId:first.login.sessionId});
  const before=await readFile(join(f.children[0].options.env.NAPCAT_WORKDIR,'config/webui.json'),'utf8');
  const connection=f.runtime.connection(),slot=f.runtime.config.slotId;
  await f.runtime.close();assert.equal(f.children[0].child.exitCode,null,'关闭窗口不应杀掉 QQ');
  const recovered=f.reopen();t.after(()=>recovered.stop());await recovered.ready;
  assert.equal(recovered.state().login.status,'online');assert.equal(recovered.config.slotId,slot);
  assert.deepEqual(recovered.connection(),connection);assert.equal(f.children.length,1);
  assert.equal(await readFile(join(f.children[0].options.env.NAPCAT_WORKDIR,'config/webui.json'),'utf8'),before);
  assert.equal(f.calls.filter(path=>path.endsWith('RefreshQRcode')).length,0);
});

test('后台恢复连续失败时保持阻塞，不退回新建进程或覆盖已有配置',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});await f.runtime.startLogin();await f.runtime.close();
  const recover=f.processHost.recover;f.processHost.recover=async()=>{throw new Error('fixture background unavailable');};
  const reopened=f.reopen();await reopened.ready;let launches=0;reopened.verify=async()=>{launches++;throw new Error('unexpected fresh launch');};
  try{await assert.rejects(reopened.startLogin());await assert.rejects(reopened.startLogin());assert.equal(launches,0);assert.equal(f.children.length,1);}
  finally{f.processHost.recover=recover;await reopened.close();}
});

test('状态刷新正在恢复后台时，并发扫码请求等待恢复，不启动或重写存活 QQ',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});await f.runtime.startLogin();await f.runtime.close();
  const recover=f.processHost.recover;f.processHost.recover=async()=>{throw new Error('initial recovery unavailable');};
  const reopened=f.reopen();await reopened.ready;let launches=0,release;const gate=new Promise(done=>{release=done;});
  reopened.verify=async()=>{launches++;throw new Error('unexpected fresh launch');};
  f.processHost.recover=async()=>{await gate;return recover();};
  const refresh=reopened.sync();await new Promise(done=>setImmediate(done));
  const started=reopened.startLogin().catch(error=>error);await new Promise(done=>setImmediate(done));release();
  try{await refresh;const result=await started;assert.equal(launches,0);assert.equal(result.login?.status,'waiting_qrcode');assert.equal(f.children.length,1);}
  finally{f.processHost.recover=recover;await reopened.close();}
});

test('保存未变化配置保留 QQ，无效修改先报错，只有有效变化才执行停止回调',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});await f.runtime.startLogin();let stopped=0;
  const options={beforeChange:async()=>{stopped++;await f.runtime.stop();}};
  assert.equal((await f.runtime.configure({mode:'managed'},options)).running,true);assert.equal(stopped,0);
  await assert.rejects(f.runtime.configure({mode:'external',wsUrl:'invalid',accountId:'70001'},options));assert.equal(stopped,0);
  const saved=await f.runtime.configure({mode:'external',wsUrl:'ws://127.0.0.1:3001',accountId:'70001'},options);
  assert.equal(saved.mode,'external');assert.equal(stopped,1);
});

test('并发接入设置保存不会用旧快照覆盖另一请求已更新的账号',async t=>{
  const f=await fixture(t);await f.runtime.configure({mode:'external',wsUrl:'ws://127.0.0.1:3001',accountId:'70001'});
  let releaseA,releaseB;const aGate=new Promise(done=>{releaseA=done;}),bGate=new Promise(done=>{releaseB=done;});
  const a=f.runtime.configure({accountId:'70002'},{beforeChange:()=>aGate});
  const b=f.runtime.configure({token:'fixture-new'},{beforeChange:()=>bGate});
  await new Promise(done=>setImmediate(done));releaseA();await a;releaseB();
  await assert.rejects(b,/变化|重新/);assert.equal(f.runtime.config.accountId,'70002');assert.equal(f.runtime.config.externalToken,'');
});

test('并发停止共享同一停止任务，完成前不允许新扫码进入',async t=>{
  const f=await fixture(t);await f.runtime.install({directory:join(f.directory,'install')});await f.runtime.startLogin();
  let calls=0,release;const gate=new Promise(done=>{release=done;}),stop=f.processHost.stop;
  f.processHost.stop=async()=>{calls++;await gate;await stop();};
  const a=f.runtime.stop(),b=f.runtime.stop();await new Promise(done=>setImmediate(done));
  try{assert.equal(calls,1);await assert.rejects(f.runtime.startLogin(),/停止/);}
  finally{release();await Promise.all([a,b]);f.processHost.stop=stop;}
});
