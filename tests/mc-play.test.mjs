import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchStore } from '../framework/store.mjs';
import { MinecraftCompanion, minecraftConnection } from '../framework/mc-play.mjs';
import { createWorkbench } from '../framework/server.mjs';

async function runtimeFixture(directory) {
  const runtimeRoot=join(directory,'runtime-fixture');
  // 子进程由 spawnImpl 模拟；依赖标记也放在临时目录，不依赖开发机已安装的 MC 组件。
  for(const [name,content] of [['worker.mjs',''],['node_modules/tsx/package.json','{}'],['node_modules/isolated-vm/isolated-vm.js','']]){
    const path=join(runtimeRoot,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content,'utf8');
  }
  return {runtimeRoot,nodePath:process.execPath};
}

async function fixture(t, { online = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-mc-play-'));
  const store = new WorkbenchStore(directory);
  store.setEnabled('mc-play', true);
  store.saveConfig('mc-play', { serverHost:'127.0.0.1', serverPort:'25565', playerName:'Companion', ownerName:'TestPlayer', authMode:'offline', gameVersion:'' });
  const children = [];
  const aiCalls = [];
  const sharedAI = { config:() => ({enabled:true}), complete:async messages => { aiCalls.push(messages); return {text:'await skip({})',usage:null}; } };
  const runtime = new MinecraftCompanion({store,dataDir:directory,sharedAI,...await runtimeFixture(directory),spawnImpl:(_node,args,options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.connected = true;
    child.sent = []; child.args = args; child.options = options;
    child.send = (message, callback) => { child.sent.push(message); callback?.(); queueMicrotask(() => {
      if(message.type === 'init' && online) child.emit('message',{type:'online',sessionId:message.sessionId,version:'1.21.1',username:'Companion',paused:false});
      if(message.type === 'disconnect') { child.connected=false; child.emit('exit',0,null); }
      if(message.type === 'command') child.emit('message',{type:'command-result',sessionId:message.sessionId,requestId:message.requestId,ok:true});
    }); };
    child.kill = () => { child.connected=false; child.emit('exit',0,null); };
    children.push(child); return child;
  }});
  t.after(async () => { await runtime.close(); store.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)); await rm(directory,{recursive:true,force:true}); });
  return {runtime,store,children,aiCalls};
}

test('Minecraft 连接字段校验，端口自动版本和离线登录有明确默认值', () => {
  assert.deepEqual(minecraftConnection({playerName:'Companion'}),{serverHost:'127.0.0.1',serverPort:25565,playerName:'Companion',ownerName:'',authMode:'offline',gameVersion:''});
  for(const config of [{playerName:'bad name'},{playerName:'Bot',serverPort:'0'},{playerName:'Bot',serverHost:'http://example.com'},{playerName:'Bot',authMode:'mojang'},{playerName:'Bot',serverPort:'25565oops'}]) assert.throws(() => minecraftConnection(config));
});

test('打开模块不启动运行端；连接后以实际 online 事件显示在线', async t => {
  const {runtime,children} = await fixture(t);
  assert.equal(children.length,0); assert.equal(runtime.state().connection.status,'disconnected');
  await runtime.connect('http://127.0.0.1:17881'); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(children.length,1); assert.equal(runtime.state().connection.status,'connected');
  assert.equal(runtime.state().connection.gameVersion,'1.21.1');
  assert.equal(JSON.stringify(runtime.state()).includes(runtime.session.token),false);
  assert.ok(!children[0].args.some(value=>value.includes(runtime.session.token)));
});

test('陪玩运行端初始化使用模块有效启用状态，不被全局停用覆盖',async t=>{
  const {runtime,children}=await fixture(t);runtime.ai.config=id=>({enabled:id==='mc-play'});
  await runtime.connect('http://127.0.0.1:17881');await new Promise(done=>setImmediate(done));
  assert.equal(runtime.state().aiEnabled,true);assert.equal(children[0].sent.find(message=>message.type==='init').aiEnabled,true);
});

test('连接中阻止重复启动；掉线与错误不会冒充在线', async t => {
  const {runtime,children} = await fixture(t,{online:false});
  await runtime.connect('http://127.0.0.1:17881');
  await assert.rejects(runtime.connect('http://127.0.0.1:17881'),/连接|运行/);
  assert.equal(runtime.state().connection.status,'connecting');
  children[0].emit('message',{type:'failure',sessionId:runtime.session.id,message:'ECONNREFUSED'});
  assert.equal(runtime.state().connection.status,'error');
});

test('运行端报错但仍存活时保留断开能力，停止后可重新连接',async t=>{
  const {runtime,children}=await fixture(t);
  await runtime.connect('http://127.0.0.1:17881');await new Promise(done=>setImmediate(done));
  children[0].emit('message',{type:'failure',sessionId:runtime.session.id,message:'recoverable error'});
  assert.equal(runtime.state().connection.status,'error');
  assert.equal(runtime.state().connection.workerActive,true);
  assert.equal(runtime.state().connection.canDisconnect,true);
  await runtime.disconnect();assert.equal(runtime.state().connection.workerActive,false);
  await runtime.connect('http://127.0.0.1:17881');assert.equal(children.length,2);
});

test('自然语言指令只投递到活动运行端，暂停通过运行端确认', async t => {
  const {runtime,children} = await fixture(t);
  await assert.rejects(runtime.command({kind:'instruction',text:'跟我来'}),/连接/);
  await runtime.connect('http://127.0.0.1:17881'); await new Promise(resolve=>setImmediate(resolve));
  await runtime.command({kind:'instruction',text:'跟我来'});
  assert.equal(children[0].sent.at(-1).text,'跟我来');
  assert.equal(children[0].sent.at(-1).kind,'instruction');
  await runtime.command({kind:'pause'});
  children[0].emit('message',{type:'telemetry',sessionId:runtime.session.id,paused:true,health:20,food:20,position:{x:0,y:64,z:0},players:['TestPlayer']});
  assert.equal(runtime.state().connection.paused,true);
});

test('断开后旧运行端不能污染新会话，角色上下文按连接时快照', async t => {
  const {runtime,store,children,aiCalls} = await fixture(t);
  const character=store.saveCharacter({id:'test-character',name:'测试同伴',description:'说话简短。',revision:1,raw:{},assets:[]});
  store.selectCharacter(character.id);
  await runtime.connect('http://127.0.0.1:17881'); await new Promise(resolve=>setImmediate(resolve));
  const first={...runtime.session};
  await runtime.complete(first.token,[{role:'user',content:'测试'}]);
  assert.ok(JSON.stringify(aiCalls[0]).includes('测试同伴'));
  store.selectCharacter(null); await runtime.disconnect();
  await assert.rejects(runtime.complete(first.token,[{role:'user',content:'过期'}]),/会话|令牌/);
  await runtime.connect('http://127.0.0.1:17881'); await new Promise(resolve=>setImmediate(resolve));
  children[0].emit('message',{type:'failure',sessionId:first.id,message:'旧进程错误'});
  assert.equal(runtime.state().connection.status,'connected');
  assert.equal(runtime.state().connection.character,null);
});

test('停用模块与关闭宿主都能停止受管子进程', async t => {
  const {runtime,store,children} = await fixture(t);
  await runtime.connect('http://127.0.0.1:17881'); await new Promise(resolve=>setImmediate(resolve));
  await runtime.disconnect(); assert.equal(children[0].connected,false);
  store.setEnabled('mc-play',false);
  await assert.rejects(runtime.connect('http://127.0.0.1:17881'),/添加|启用/);
});

test('暂停、断开与掉线取消模型请求，恢复后也不接受旧回复', async t => {
  for(const stop of ['pause','disconnect','failure','offline','exit','request-close'])await t.test(stop,async t=>{
    const {runtime,children}=await fixture(t);
    await runtime.connect('http://127.0.0.1:17881');await new Promise(done=>setImmediate(done));
    let release,providerSignal;
    const delayed=new Promise(done=>{release=done;});
    runtime.ai.complete=async(_messages,options)=>{providerSignal=options.signal;await delayed;return{text:'old plan'};};
    const caller=new AbortController();
    const pending=runtime.complete(runtime.session.token,[{role:'user',content:'旧指令'}],{signal:caller.signal});
    const outcome=pending.then(value=>({value}),error=>({error}));
    try{
      if(stop==='pause'){await runtime.command({kind:'pause'});await runtime.command({kind:'resume'});}
      else if(stop==='disconnect')await runtime.disconnect();
      else if(stop==='exit')children[0].emit('exit',0);
      else if(stop==='request-close')caller.abort();
      else children[0].emit('message',{type:stop,sessionId:runtime.session.id,message:'fixture'});
      assert.equal(providerSignal?.aborted,true,'共用模型必须收到取消信号');
    }finally{release();}
    assert.equal((await outcome).error?.status,409,'旧回复不能重新成为有效计划');
  });
});

test('HTTP 接口要求启用模块，拒绝无效配置，保存和重启都不自动进服', async t => {
  const directory=await mkdtemp(join(tmpdir(),'workbench-minecraft-http-'));
  let spawned=0;
  let app=await createWorkbench({dataDir:directory,minecraftOptions:{spawnImpl:()=>{spawned++;throw new Error('不应启动');}}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const api=async(path,method='GET',value)=>{const response=await fetch(app.url+path,{method,...(value===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(value)})});return {status:response.status,value:await response.json()};};
  const base='/api/modules/mc-play';
  assert.equal((await api(base+'/state')).status,409);
  await api(base+'/enable','POST',{});
  const values={serverHost:'127.0.0.1',serverPort:'25565',playerName:'HttpBot',ownerName:'TestPlayer',authMode:'offline',gameVersion:''};
  assert.equal((await api(base+'/connection','PUT',values)).status,200);
  assert.equal((await api(base+'/connection','PUT',{...values,serverPort:'broken'})).status,400);
  assert.equal((await api(base+'/connection','PUT',{...values,script:'invalid'})).status,400);
  assert.equal((await api(base+'/state')).value.config.serverPort,'25565');
  assert.equal(spawned,0);
  await app.close();app=await createWorkbench({dataDir:directory});
  const state=(await api(base+'/state')).value;
  assert.equal(state.connection.status,'disconnected');assert.equal(state.config.playerName,'HttpBot');
});

test('运行端模型入口拒绝未授权与过期会话，公开状态不携带令牌', async t => {
  const directory=await mkdtemp(join(tmpdir(),'workbench-minecraft-token-'));
  let child;let init;
  const app=await createWorkbench({dataDir:directory,aiOptions:{codexRunner:async()=>({text:'await skip({})'})},minecraftOptions:{...await runtimeFixture(directory),spawnImpl:()=>{
    child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.connected=true;
    child.send=(value,callback)=>{callback?.();queueMicrotask(()=>{if(value.type==='init'){init=value;child.emit('message',{type:'online',sessionId:value.sessionId,username:'TokenBot',version:'1.20.1',paused:false});}if(value.type==='disconnect'){child.connected=false;child.emit('exit',0);}});};child.kill=()=>child.emit('exit',0);return child;
  }}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  async function request(path,method='GET',value,token){const response=await fetch(app.url+path,{method,headers:{...(value===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});return {status:response.status,value:await response.json()};}
  await request('/api/modules/mc-play/enable','POST',{});
  await request('/api/ai/config','PUT',{provider:'codex',enabled:true});
  assert.equal((await request('/api/modules/mc-play/connect','POST',{})).status,200);await new Promise(resolveReady=>setImmediate(resolveReady));
  const body={messages:[{role:'user',content:'测试'}]};
  assert.equal((await request('/internal/mc-play/ai/v1/chat/completions','POST',body,'wrong')).status,403);
  assert.equal((await request('/internal/mc-play/ai/v1/chat/completions','POST',body,init.aiToken)).status,200);
  assert.equal(JSON.stringify((await request('/api/modules/mc-play/state')).value).includes(init.aiToken),false);
  await request('/api/modules/mc-play/disable','POST',{});
  assert.equal(child.connected,false);
  assert.equal((await request('/internal/mc-play/ai/v1/chat/completions','POST',body,init.aiToken)).status,403);
});

test('运行端取消 HTTP 等待时会停止宿主中的模型进程',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'minecraft-http-cancel-'));
  let init,cancelled=false,entered;const started=new Promise(done=>{entered=done;});
  const app=await createWorkbench({dataDir:directory,aiOptions:{codexRunner:({onSpawn})=>new Promise(done=>{
    onSpawn({kill(){cancelled=true;done({text:'cancelled fixture'});}});entered();
  })},minecraftOptions:{...await runtimeFixture(directory),spawnImpl:()=>{
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.connected=true;
    child.send=(value,callback)=>{callback?.();queueMicrotask(()=>{if(value.type==='init'){init=value;child.emit('message',{type:'online',sessionId:value.sessionId,paused:false});}if(value.type==='disconnect'){child.connected=false;child.emit('exit',0);}});};
    child.kill=()=>child.emit('exit',0);return child;
  }}});
  t.after(async()=>{await app.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  const request=(path,value,method='POST')=>fetch(app.url+path,{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  await request('/api/modules/mc-play/enable',{});await request('/api/ai/config',{provider:'codex',enabled:true},'PUT');
  assert.equal((await request('/api/modules/mc-play/connect',{})).status,200);await new Promise(done=>setImmediate(done));
  const caller=new AbortController();
  const pending=fetch(app.url+'/internal/mc-play/ai/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+init.aiToken},body:JSON.stringify({messages:[{role:'user',content:'测试取消'}]}),signal:caller.signal}).catch(()=>null);
  await started;caller.abort();await pending;
  const deadline=Date.now()+2000;while(!cancelled&&Date.now()<deadline)await new Promise(done=>setTimeout(done,20));
  assert.equal(cancelled,true,'关闭请求必须取消实际宿主模型进程');
});
