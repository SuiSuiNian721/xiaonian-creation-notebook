import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { InstanceCoordination } from '../framework/instance-coordination.mjs';
import { MinecraftCompanion, minecraftConnection } from '../framework/mc-play.mjs';
import { WorkbenchStore } from '../framework/store.mjs';
import { createWorkbench } from '../framework/server.mjs';

const appUrl='http://127.0.0.1:17881';
const nextTurn=()=>new Promise(done=>setImmediate(done));
const settings=(playerName='FirstBot',serverHost='127.0.0.1',extra={})=>({playerName,serverHost,serverPort:25565,authMode:'offline',...extra});
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}

async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'mc-bots-'));
  const component=join(directory,'component');
  for(const [name,content] of [['worker.mjs',''],['node_modules/tsx/package.json','{}'],['node_modules/isolated-vm/isolated-vm.js','']]){
    const path=join(component,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content,'utf8');
  }
  const coordination=new InstanceCoordination(new Map());const instances=[];
  async function bot(id,config=settings(id),{acquireGate,spawnError,automaticExit=true}={}){
    const dataDir=join(directory,id);const store=new WorkbenchStore(dataDir);const children=[];const aiCalls=[];
    store.setEnabled('mc-play',true);store.saveConfig('mc-play',config);
    const ai={config:()=>({enabled:true}),complete:async(messages,{signal})=>{aiCalls.push({messages,signal});return {text:id};}};
    const runtime=new MinecraftCompanion({store,dataDir,sharedAI:ai,nodePath:process.execPath,coordination:coordination.forInstance(id),componentProvider:{
      resolve:()=>({path:component}),acquire:async()=>{await acquireGate?.promise;return {path:component,release(){}};},
    },spawnImpl:()=>{
      if(spawnError)throw new Error(spawnError);
      const child=new EventEmitter();Object.assign(child,{pid:4000+instances.length,connected:true,kills:0,sent:[],stdout:new EventEmitter(),stderr:new EventEmitter()});
      child.finish=()=>{child.connected=false;child.emit('exit',0);child.emit('close',0);};
      child.send=(message,callback)=>{child.sent.push(message);callback?.();if(message.type==='disconnect'&&automaticExit)queueMicrotask(child.finish);if(message.type==='command')queueMicrotask(()=>child.emit('message',{type:'command-result',sessionId:message.sessionId,requestId:message.requestId,ok:true}));};
      child.kill=()=>{child.kills++;if(automaticExit)queueMicrotask(child.finish);return true;};
      children.push(child);return child;
    }});
    const item={runtime,store,children,ai,aiCalls,online:(extra={})=>children.at(-1).emit('message',{type:'online',sessionId:runtime.session.id,username:config.playerName,paused:false,...extra})};instances.push(item);return item;
  }
  t.after(async()=>{for(const item of instances){for(const child of item.children)if(child.connected)child.finish();await item.runtime.close();item.store.close();}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {bot,coordination,component,directory};
}

test('不同实例同时连接同服同名时，在异步组件准备前同步占用身份',async t=>{
  const {bot}=await fixture(t);const gate=deferred();
  const first=await bot('first',settings(),{acquireGate:gate});const second=await bot('second',settings('firstbot'));
  const starting=first.runtime.connect(appUrl);
  try{await assert.rejects(second.runtime.connect(appUrl),{status:409});assert.equal(second.children.length,0);assert.equal(first.children.length,0);}
  finally{gate.resolve();await starting;}
  assert.equal(first.children.length,1);
});

test('主机名大小写与末尾点，以及本机三种地址指向同一身份占用',async t=>{
  for(const hosts of [['EXAMPLE.COM.','example.com'],['LOCALHOST.','127.0.0.1'],['127.0.0.1','::1']])await t.test(hosts.join(' / '),async t=>{
    const {bot}=await fixture(t);const first=await bot('first',settings('Bot',hosts[0]));const second=await bot('second',settings('bot',hosts[1]));
    assert.doesNotThrow(()=>minecraftConnection(settings('Bot',hosts[0])));
    await first.runtime.connect(appUrl);await assert.rejects(second.runtime.connect(appUrl),{status:409});
  });
});

const ipv6Aliases=[
  ['::1','0:0:0:0:0:0:0:1'],
  ['127.0.0.1','::ffff:127.0.0.1'],
  ['localhost','0:0:0:0:0:ffff:7f00:0001'],
  ['2001:db8::1','2001:0DB8:0:0:0:0:0:0001'],
  ['192.0.2.9','::ffff:c000:0209'],
  ['::ffff:192.0.2.9','0:0:0:0:0:FFFF:c000:209'],
  ['fe80::1%3','fe80:0:0:0:0:0:0:1%3'],
];

test('IPv6 等价写法和 IPv4 映射地址共享玩家名占用及同伴名单',async t=>{
  for(const [a,b] of ipv6Aliases)await t.test(a+' / '+b,()=>{
    const coordination=new InstanceCoordination(new Map());const peers=[];
    assert.doesNotThrow(()=>minecraftConnection(settings('FirstBot',a)));assert.doesNotThrow(()=>minecraftConnection(settings('FirstBot',b)));
    const first=coordination.forInstance('first').claimMinecraft(settings('FirstBot',a),'first-session');first.subscribe(names=>peers.push(names));
    assert.throws(()=>coordination.forInstance('duplicate').claimMinecraft(settings('firstbot',b),'duplicate-session'),{status:409});
    const second=coordination.forInstance('second').claimMinecraft(settings('SecondBot',b),'second-session');
    assert.deepEqual(peers.at(-1),['SecondBot']);second.subscribe(names=>assert.deepEqual(names,['FirstBot']));
    second.release();assert.deepEqual(peers.at(-1),[]);first.release();
  });
});

test('相同 UUID 在 IPv6 等价地址间仍被拒绝，失败不会改变既有占用',async t=>{
  for(const [a,b] of ipv6Aliases)await t.test(a+' / '+b,()=>{
    const coordination=new InstanceCoordination(new Map());
    const first=coordination.forInstance('first').claimMinecraft(settings('first@example.com',a,{authMode:'microsoft'}),'first-session');
    const second=coordination.forInstance('second').claimMinecraft(settings('second@example.com',b,{authMode:'microsoft'}),'second-session');
    const uuid='12345678-1234-1234-1234-123456789abc';first.updateIdentity({playerName:'ActualFirst',uuid});
    assert.throws(()=>second.updateIdentity({playerName:'ActualSecond',uuid:uuid.replaceAll('-','').toUpperCase()}),{status:409});
    const peers=[];first.subscribe(names=>peers.push(names));assert.deepEqual(peers.at(-1),[]);
    first.updateIdentity({playerName:'ActualFirst',uuid});second.release();first.release();
  });
});

test('IPv6 规范化保留不同地址、端口和网卡作用域的区别',()=>{
  for(const [a,b,extra] of [
    ['2001:db8::1','2001:db8::2'],['192.0.2.9','::ffff:192.0.2.10'],
    ['127.0.0.1','127.0.0.2'],['127.0.0.1','::127.0.0.1'],
    ['::1','0:0:0:0:0:0:0:1',{serverPort:25566}],['fe80::1%3','fe80::1%4'],
  ]){
    const coordination=new InstanceCoordination(new Map());
    const first=coordination.forInstance('first').claimMinecraft(settings('SameBot',a),'first-session');
    const second=coordination.forInstance('second').claimMinecraft(settings('SameBot',b,extra),'second-session');
    const identity={playerName:'SameBot',uuid:'12345678-1234-1234-1234-123456789abc'};first.updateIdentity(identity);second.updateIdentity(identity);
    first.subscribe(names=>assert.deepEqual(names,[]));second.subscribe(names=>assert.deepEqual(names,[]));second.release();first.release();
  }
});

test('同服不同名、不同服务器或不同端口可同时使用，各自保留状态和指令',async t=>{
  const {bot}=await fixture(t);const configs=[settings('FirstBot'),settings('SecondBot'),settings('FirstBot','example.com'),settings('FirstBot','localhost',{serverPort:25566})];const all=[];
  for(let index=0;index<configs.length;index++)all.push(await bot('bot'+index,configs[index]));
  await Promise.all(all.map(item=>item.runtime.connect(appUrl)));all.forEach(item=>item.online());
  await all[0].runtime.command({kind:'instruction',text:'只跟随我'});
  assert.equal(all[0].children[0].sent.filter(message=>message.type==='command').length,1);
  for(const item of all.slice(1)){assert.equal(item.children[0].sent.filter(message=>message.type==='command').length,0);assert.equal(item.runtime.state().connection.status,'connected');}
  await all[0].runtime.disconnect();for(const item of all.slice(1))assert.equal(item.children[0].connected,true);
});

test('身份预留覆盖登录标识，微软实际玩家名和 UUID 在入服前复核',async t=>{
  const {bot}=await fixture(t);const first=await bot('first',settings('account@example.com','localhost',{authMode:'microsoft'}));
  const duplicate=await bot('duplicate',settings('ACCOUNT@example.com','::1',{authMode:'microsoft'}));
  const other=await bot('other',settings('different@example.com','127.0.0.1',{authMode:'microsoft'}),{automaticExit:false});
  await first.runtime.connect(appUrl);await assert.rejects(duplicate.runtime.connect(appUrl),{status:409});
  first.children[0].emit('message',{type:'identity',sessionId:first.runtime.session.id,requestId:'one',username:'ActualBot',uuid:'12345678-1234-1234-1234-123456789abc'});
  assert.equal(first.children[0].sent.at(-1).type,'identity-result');assert.equal(first.children[0].sent.at(-1).ok,true);first.online({username:'ActualBot'});
  await other.runtime.connect(appUrl);other.children[0].emit('message',{type:'identity',sessionId:other.runtime.session.id,requestId:'two',username:'RenamedBot',uuid:'12345678123412341234123456789ABC'});
  assert.equal(other.runtime.state().connection.status,'error');assert.equal(other.children[0].sent.at(-1).ok,false);assert.equal(other.children[0].kills,1);
  assert.equal(first.runtime.state().connection.status,'connected');assert.equal(first.children[0].kills,0);
  const offline=await bot('offline',settings('actualbot'));await assert.rejects(offline.runtime.connect(appUrl),{status:409});
});

test('online 上报的最终身份仍会复核，冲突只终止后来的运行端',async t=>{
  const {bot}=await fixture(t);const first=await bot('first',settings('ActualBot'));const second=await bot('second',settings('login@example.com','localhost',{authMode:'microsoft'}),{automaticExit:false});
  await first.runtime.connect(appUrl);first.online();await second.runtime.connect(appUrl);second.online({username:'actualbot'});
  assert.equal(second.runtime.state().connection.status,'error');assert.equal(second.children[0].kills,1);assert.equal(first.runtime.state().connection.status,'connected');
});

test('错误、断线与停止请求都保留占用，只有进程真实退出后才能重试',async t=>{
  for(const kind of ['failure','offline','error','disconnect','close'])await t.test(kind,async t=>{
    const {bot}=await fixture(t);const first=await bot('first',settings(),{automaticExit:false});const second=await bot('second',settings());
    await first.runtime.connect(appUrl);let stopping;
    if(kind==='error')first.children[0].emit('error',new Error('IPC broken'));
    else if(kind==='disconnect'||kind==='close')stopping=first.runtime[kind]();
    else first.children[0].emit('message',{type:kind,sessionId:first.runtime.session.id,message:'fixture'});
    await assert.rejects(second.runtime.connect(appUrl),{status:409});first.children[0].finish();await stopping;await nextTurn();await second.runtime.connect(appUrl);
    assert.equal(second.children.length,1);
  });
});

test('spawn 之前失败或取消释放身份，已失效的释放句柄不能释放新会话',async t=>{
  const {bot,coordination}=await fixture(t);const first=await bot('first',settings(),{spawnError:'fixture denied'});const second=await bot('second',settings());
  await assert.rejects(first.runtime.connect(appUrl),/fixture denied/);await second.runtime.connect(appUrl);await second.runtime.disconnect();
  const scoped=coordination.forInstance('lease');assert.equal(typeof scoped.claimMinecraft,'function');
  const old=scoped.claimMinecraft(settings(),'old');old.release();const current=scoped.claimMinecraft(settings(),'new');old.release();
  assert.throws(()=>coordination.forInstance('competitor').claimMinecraft(settings(),'other'),{status:409});current.release();
});

test('取消组件准备期间的连接，迟到的准备不能进服或保留身份',async t=>{
  const {bot}=await fixture(t);const gate=deferred();const first=await bot('first',settings(),{acquireGate:gate});const second=await bot('second',settings());
  const starting=first.runtime.connect(appUrl).catch(error=>error);const stopping=first.runtime.disconnect();
  gate.resolve();await stopping;assert.equal((await starting).status,409);assert.equal(first.children.length,0);await second.runtime.connect(appUrl);
});

test('读取 AI 设置失败时没有遗留的身份占用',async t=>{
  const {bot}=await fixture(t);const first=await bot('first',settings());const second=await bot('second',settings());
  first.ai.config=()=>{throw new Error('fixture settings unavailable');};
  await assert.rejects(first.runtime.connect(appUrl),/settings unavailable/);first.ai.config=()=>({enabled:true});
  await second.runtime.connect(appUrl);assert.equal(first.children.length,0);
});

test('同服同伴名单随加入、实际身份和退出更新，其他服务器不进入名单',async t=>{
  const {bot}=await fixture(t);const first=await bot('first',settings('FirstBot'));const second=await bot('second',settings('SecondBot'));const remote=await bot('remote',settings('RemoteBot','example.com'));
  await first.runtime.connect(appUrl);await remote.runtime.connect(appUrl);await second.runtime.connect(appUrl);
  const peers=item=>item.children[0].sent.filter(message=>message.type==='peers').at(-1)?.names;
  assert.deepEqual(peers(first),['SecondBot']);assert.deepEqual(second.children[0].sent.find(message=>message.type==='init').peerBotNames,['FirstBot']);assert.deepEqual(peers(remote)||[],[]);
  second.online({username:'ActualSecond'});assert.deepEqual(peers(first),['ActualSecond']);
  await second.runtime.disconnect();assert.deepEqual(peers(first),[]);
  const old=second.children[0];await second.runtime.connect(appUrl);old.emit('close',0);old.emit('message',{type:'online',sessionId:'stale',username:'Stale'});
  assert.deepEqual(peers(first),['SecondBot']);assert.equal(first.children[0].sent.filter(message=>message.type==='peers').every(message=>message.sessionId===first.runtime.session.id),true);
});

test('一个 Bot 暂停、退出或收到旧会话数据时不取消另一个 Bot 的 AI',async t=>{
  const {bot}=await fixture(t);const first=await bot('first',settings('FirstBot'));const second=await bot('second',settings('SecondBot'));
  await first.runtime.connect(appUrl);first.online();await second.runtime.connect(appUrl);second.online();
  const release=deferred();let signal;second.ai.complete=async(_messages,options)=>{signal=options.signal;await release.promise;return {text:'独立回复'};};
  const pending=second.runtime.complete(second.runtime.session.token,[{role:'user',content:'自己的任务'}]);
  try{await first.runtime.command({kind:'pause'});await first.runtime.disconnect();second.children[0].emit('message',{type:'identity',sessionId:'old',requestId:'stale',username:'FirstBot'});assert.equal(signal.aborted,false);assert.equal(second.runtime.state().connection.status,'connected');}
  finally{release.resolve();}
  assert.equal((await pending).text,'独立回复');
});

test('两个真实 HTTP 实例共享身份协调，但工作目录、认证缓存、指令与 AI 令牌互相隔离',async t=>{
  const {component,directory}=await fixture(t);const children=new Map();
  const app=await createWorkbench({dataDir:join(directory,'app'),aiOptions:{codexRunner:async()=>({text:'独立响应'})},instanceOptionsFactory:({instanceId})=>({minecraftOptions:{runtimeRoot:component,nodePath:process.execPath,spawnImpl:(_node,_args,options)=>{
    const child=new EventEmitter();Object.assign(child,{pid:4000+children.size,connected:true,options,sent:[],stdout:new EventEmitter(),stderr:new EventEmitter()});
    child.finish=()=>{child.connected=false;child.emit('exit',0);};child.kill=child.finish;
    child.send=(message,callback)=>{child.sent.push(message);callback?.();queueMicrotask(()=>{
      if(message.type==='init')child.emit('message',{type:'online',sessionId:message.sessionId,username:message.settings.playerName,paused:false});
      if(message.type==='disconnect')child.finish();
      if(message.type==='command')child.emit('message',{type:'command-result',sessionId:message.sessionId,requestId:message.requestId,ok:true});
    });};children.set(instanceId,child);return child;
  }}})});
  const api=async(path,method='GET',body,token)=>{const response=await fetch(app.url+path,{method,headers:{...(body===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,...await response.json()};};
  try{
    await api('/api/ai/config','PUT',{provider:'codex',enabled:true});
    const a=(await api('/api/instances','POST',{moduleId:'mc-play',name:'MC A'})).instance,b=(await api('/api/instances','POST',{moduleId:'mc-play',name:'MC B'})).instance;
    const route=id=>'/instances/'+id+'/api/modules/mc-play';
    await api(route(a.id)+'/connection','PUT',settings('HttpBot'));await api(route(b.id)+'/connection','PUT',settings('httpbot','localhost'));
    assert.equal((await api(route(a.id)+'/connect','POST',{})).status,200);assert.equal((await api(route(b.id)+'/connect','POST',{})).status,409);assert.equal(children.size,1);
    await api(route(b.id)+'/connection','PUT',settings('OtherBot'));assert.equal((await api(route(b.id)+'/connect','POST',{})).status,200);
    const ca=children.get(a.id),cb=children.get(b.id);const ia=ca.sent.find(message=>message.type==='init'),ib=cb.sent.find(message=>message.type==='init');
    assert.notEqual(ca.options.cwd,cb.options.cwd);assert.notEqual(ia.authDirectory,ib.authDirectory);assert.notEqual(ia.aiToken,ib.aiToken);assert.ok(ib.aiBaseUrl.includes('/instances/'+b.id+'/'));
    assert.equal((await api(route(a.id)+'/command','POST',{kind:'instruction',text:'只交给 A'})).status,200);assert.equal(cb.sent.some(message=>message.type==='command'),false);
    const endpoint='/instances/'+b.id+'/internal/mc-play/ai/v1/chat/completions',messages={messages:[{role:'user',content:'只交给 B'}]};
    assert.equal((await api(endpoint,'POST',messages,ia.aiToken)).status,403);
    await api(route(a.id)+'/disconnect','POST',{});assert.equal((await api(route(b.id)+'/state')).connection.status,'connected');assert.equal((await api(endpoint,'POST',messages,ib.aiToken)).status,200);
  }finally{await app.close();}
});

test('实际 worker 与认知入口验证动态同伴过滤，以及身份拒绝、超时和取消',{timeout:10000},async t=>{
  for(const mode of ['chat','denied','timeout','cancel'])await t.test(mode,async()=>{
    const child=spawn(process.execPath,['--experimental-vm-modules',resolve('tests/fixtures/mc-bots-worker.mjs'),mode],{windowsHide:true});let output='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>output+=value);
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/MC_BOTS_WORKER_OK/);
  });
});
