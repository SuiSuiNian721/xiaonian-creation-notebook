import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkbenchStore } from '../framework/store.mjs';
import { MinecraftCompanion } from '../framework/mc-play.mjs';

const appUrl='http://127.0.0.1:17881';
const nextTurn=()=>new Promise(done=>setImmediate(done));
function deferred(){let resolveResult;const promise=new Promise(done=>{resolveResult=done;});return {promise,resolve:resolveResult};}

async function fixture(t,{installed=true,acquireGate,releaseGate,spawnError,automaticExit=true,origin='managed',componentNodePath,options={}}={}){
  const directory=await mkdtemp(join(tmpdir(),'mc-optional-components-'));
  const component=join(directory,'component');
  for(const [name,content] of [['worker.mjs',''],['node_modules/tsx/package.json','{}'],['node_modules/isolated-vm/isolated-vm.js',''],['runtime/'+(process.platform==='win32'?'node.exe':'node'),'']]){
    const path=join(component,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content);
  }
  const store=new WorkbenchStore(directory);store.setEnabled('mc-play',true);
  store.saveConfig('mc-play',{serverHost:'127.0.0.1',serverPort:'25565',playerName:'ComponentBot',authMode:'offline'});
  const leases=[];const children=[];
  const provider={selected:installed?component:null,resolve(id){assert.equal(id,'mc-play');return this.selected?{path:this.selected,origin,version:'test',nodePath:componentNodePath}:null;},async acquire(id,owner){
    assert.equal(id,'mc-play');assert.equal(typeof owner,'string');assert.ok(owner.length>0);
    const lease={path:this.selected,releases:0};leases.push(lease);await acquireGate?.promise;
    return {path:lease.path,origin,nodePath:componentNodePath,version:'test',release(){lease.releases++;return releaseGate?.promise;}};
  }};
  const runtime=new MinecraftCompanion({store,dataDir:directory,sharedAI:{config:()=>({enabled:true})},componentProvider:provider,spawnImpl:(node,args,spawnOptions)=>{
    if(spawnError)throw new Error(spawnError);
    const child=new EventEmitter();Object.assign(child,{pid:4000+children.length,exitCode:null,signalCode:null,connected:true,node,args,options:spawnOptions,kills:0,sent:[],stdout:new EventEmitter(),stderr:new EventEmitter()});
    child.finish=(code=0,signal=null)=>{child.connected=false;child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);child.emit('close',code,signal);};
    child.send=(message,callback)=>{child.sent.push(message);callback?.();if(message.type==='disconnect'&&automaticExit)queueMicrotask(()=>child.finish());};
    child.kill=()=>{child.kills++;if(automaticExit)queueMicrotask(()=>child.finish(null,'SIGTERM'));return true;};
    children.push(child);return child;
  },...options});
  t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.finish();await runtime.close();store.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {runtime,provider,leases,children,component,directory};
}

test('缺少 MC 可选组件时只提示安装，安装后立即采用组件内的 worker 与 Node',async t=>{
  const {runtime,provider,component,children,leases}=await fixture(t,{installed:false});
  assert.equal(runtime.state().runtime.available,false);
  assert.match(runtime.state().runtime.reason,/安装.*MC|MC.*安装/);
  assert.doesNotMatch(runtime.state().runtime.reason,/桌面包/);
  await assert.rejects(runtime.connect(appUrl),{status:503});assert.equal(children.length,0);assert.equal(leases.length,0);
  provider.selected=component;assert.equal(runtime.state().runtime.available,true);
  await runtime.connect(appUrl);
  assert.equal(children[0].node,join(component,'runtime',process.platform==='win32'?'node.exe':'node'));
  assert.equal(children[0].args[1],join(component,'worker.mjs'));assert.equal(leases[0].releases,0);
  await runtime.disconnect();assert.equal(leases[0].releases,1);
});

test('复用外部 existing 组件允许采用已验证 Node 路径，managed 组件仍要求自己的 Node',async t=>{
  for(const origin of ['existing','managed'])await t.test(origin,async t=>{
    const {runtime,component,children}=await fixture(t,{origin,componentNodePath:process.execPath});
    await rm(join(component,'runtime',process.platform==='win32'?'node.exe':'node'));
    if(origin==='existing'){
      assert.equal(runtime.runtime().available,true);await runtime.connect(appUrl);assert.equal(children[0].node,process.execPath);await runtime.disconnect();
    }else{assert.equal(runtime.runtime().available,false);await assert.rejects(runtime.connect(appUrl),{status:503});assert.equal(children.length,0);}
  });
});

test('组件校验期间阻止并发连接，只获取一次租约并启动一次',async t=>{
  const gate=deferred();const {runtime,leases,children}=await fixture(t,{acquireGate:gate});
  const first=runtime.connect(appUrl);
  try{await assert.rejects(runtime.connect(appUrl),{status:409});assert.equal(leases.length,1);assert.equal(children.length,0);}
  finally{gate.resolve();}
  await first;assert.equal(children.length,1);await runtime.disconnect();assert.equal(leases[0].releases,1);
});

test('关闭时尚未完成的组件校验返回后只释放租约，不启动运行端',async t=>{
  const gate=deferred();const {runtime,leases,children}=await fixture(t,{acquireGate:gate});
  const pending=runtime.connect(appUrl);const outcome=pending.then(value=>({value}),error=>({error}));
  const closing=runtime.close();gate.resolve();await closing;
  assert.equal((await outcome).error?.status,409);assert.equal(children.length,0);assert.equal(leases[0].releases,1);
});

test('自然退出后关闭宿主仍等待异步租约释放完成',async t=>{
  const gate=deferred();const {runtime,children,leases}=await fixture(t,{releaseGate:gate});
  await runtime.connect(appUrl);children[0].finish();await nextTurn();assert.equal(leases[0].releases,1);
  let closed=false;const closing=runtime.close().then(()=>{closed=true;});
  try{await nextTurn();assert.equal(closed,false,'组件仍在释放时不能提前结束宿主关闭');}
  finally{gate.resolve();await closing;}
});

test('spawn 抛错时释放未启动组件租约，并保留明确启动错误',async t=>{
  const {runtime,leases,children}=await fixture(t,{spawnError:'启动被系统拒绝'});
  await assert.rejects(runtime.connect(appUrl),/启动被系统拒绝/);
  assert.equal(children.length,0);assert.equal(leases[0].releases,1);assert.equal(runtime.state().connection.status,'error');
});

test('没有 PID 的启动 error 释放租约且 close 回调不会重复释放',async t=>{
  const {runtime,children,leases}=await fixture(t);await runtime.connect(appUrl);
  const child=children[0];child.pid=undefined;child.emit('error',new Error('ENOENT'));
  await nextTurn();assert.equal(runtime.state().connection.status,'error');assert.equal(leases[0].releases,1);
  child.emit('close',-2,null);assert.equal(leases[0].releases,1);assert.equal(runtime.child,null);
});

test('活动进程的错误与断线消息不会提前释放，exit 和旧回调至多释放一次',async t=>{
  for(const type of ['error','failure','offline'])await t.test(type,async t=>{
    const {runtime,children,leases}=await fixture(t,{automaticExit:false});await runtime.connect(appUrl);const child=children[0];
    if(type==='error')child.emit('error',new Error('IPC 发送失败'));
    else child.emit('message',{type,sessionId:runtime.session.id,message:'fixture'});
    assert.equal(leases[0].releases,0);assert.equal(runtime.child,child);
    await assert.rejects(runtime.connect(appUrl),{status:409});child.finish(1);await nextTurn();
    assert.equal(leases[0].releases,1);child.emit('exit',1);child.emit('error',new Error('旧事件'));assert.equal(leases[0].releases,1);
  });
});

test('IPC 已断开时仍终止实际进程，等到退出后才释放组件租约',async t=>{
  const {runtime,children,leases}=await fixture(t,{automaticExit:false});await runtime.connect(appUrl);const child=children[0];child.connected=false;
  const stopping=runtime.disconnect();assert.equal(child.kills,1);assert.equal(leases[0].releases,0);assert.equal(runtime.child,child);
  child.finish();await stopping;assert.equal(leases[0].releases,1);assert.equal(runtime.child,null);
});

test('连接和停止超时只请求终止，进程真正退出前保留租约',async t=>{
  for(const kind of ['connect','disconnect'])await t.test(kind,async t=>{
    const {runtime,children,leases}=await fixture(t,{automaticExit:false});
    t.mock.timers.enable({apis:['setTimeout']});await runtime.connect(appUrl);const child=children[0];
    let stopping;if(kind==='disconnect')stopping=runtime.disconnect();
    t.mock.timers.tick(kind==='connect'?45000:6500);await Promise.resolve();
    assert.equal(child.kills,1);assert.equal(leases[0].releases,0);assert.equal(runtime.child,child);
    child.finish();await stopping;await nextTurn();assert.equal(leases[0].releases,1);
  });
});

test('显式 runtimeRoot 保持独立注入；显式 nodePath 可覆盖可选组件的 Node',async t=>{
  const {runtime,provider,component,children,leases}=await fixture(t,{options:{nodePath:process.execPath}});
  await runtime.connect(appUrl);assert.equal(children[0].node,process.execPath);await runtime.disconnect();assert.equal(leases[0].releases,1);
  const explicit=new MinecraftCompanion({store:runtime.store,dataDir:runtime.dataDir,sharedAI:runtime.ai,runtimeRoot:component,nodePath:process.execPath,componentProvider:{resolve(){throw new Error('不应解析');},acquire(){throw new Error('不应获取');}},spawnImpl:runtime.spawn});
  try{assert.equal(explicit.runtime().available,true);await explicit.connect(appUrl);assert.equal(children[1].args[1],join(component,'worker.mjs'));await explicit.disconnect();}
  finally{await explicit.close();}
  assert.equal(provider.selected,component);
});

test('真实 Node 子进程的 IPC 断开和退出完成后才归还组件租约', {timeout:5000},async t=>{
  const ready=deferred();let child;
  const {runtime,component,leases}=await fixture(t,{options:{nodePath:process.execPath,spawnImpl:(...args)=>{
    child=spawn(...args);child.on('message',message=>{if(message.type==='online')ready.resolve();});return child;
  }}});
  await writeFile(join(component,'worker.mjs'),`process.on('message',message=>{if(message.type==='init')process.send({type:'online',sessionId:message.sessionId,username:'LeaseFixture',version:'1.21.1',paused:false});if(message.type==='disconnect')process.exit(0);});`);
  await runtime.connect(appUrl);await ready.promise;
  assert.ok(child.pid>0);assert.equal(runtime.state().connection.status,'connected');assert.equal(leases[0].releases,0);
  await runtime.disconnect();assert.equal(child.exitCode,0);assert.equal(leases[0].releases,1);assert.equal(runtime.child,null);
});
