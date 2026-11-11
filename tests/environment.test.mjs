import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbench } from '../framework/server.mjs';

const minecraft = await import('../framework/environment-minecraft.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const environment = await import('../framework/environment.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

const announcement = Buffer.from('[MOTD]念念的世界[/MOTD][AD]51234[/AD]');
const interfaces = { Ethernet:[{address:'192.168.10.2',family:'IPv4',internal:false}] };
class Socket extends EventEmitter {
  memberships=[];closed=false;sends=0;
  bind(port,address,callback) {this.port=port;this.address=address;queueMicrotask(callback);}
  addMembership(group,address) {this.memberships.push([group,address]);}
  close(callback) {this.closed=true;queueMicrotask(()=>{this.emit('close');callback?.();});}
  send() {this.sends++;throw new Error('发现世界不能发送数据包');}
}

test('MC 公告使用真实单播来源和有效端口，忽略损坏、过长和无效来源',()=>{
  assert.equal(typeof minecraft.parseMinecraftAnnouncement,'function','提供严格的公告解析器');
  const parsed=minecraft.parseMinecraftAnnouncement(announcement,{address:'192.168.10.3'},interfaces);
  assert.deepEqual(parsed.values,{serverHost:'192.168.10.3',serverPort:'51234'});
  assert.equal(parsed.label,'念念的世界');
  assert.equal(minecraft.parseMinecraftAnnouncement(Buffer.concat([announcement,Buffer.from('\r\n')]),{address:'192.168.10.3'},interfaces).values.serverPort,'51234');
  assert.equal(minecraft.parseMinecraftAnnouncement(announcement,{address:'192.168.10.2'},interfaces).values.serverHost,'127.0.0.1');
  for(const packet of ['[AD]0[/AD]','[MOTD]x[/MOTD][AD]65536[/AD]','[MOTD]x[/MOTD][AD]25565[/AD]tail','x'.repeat(1500)]) assert.equal(minecraft.parseMinecraftAnnouncement(Buffer.from(packet),{address:'192.168.10.3'},interfaces),null);
  for(const address of ['0.0.0.0','255.255.255.255','224.0.2.60','invalid']) assert.equal(minecraft.parseMinecraftAnnouncement(announcement,{address},interfaces),null);
});

test('CGNAT 与校园公网网卡也能发现本机和同网世界',()=>{
  const network={Campus:[{address:'100.64.10.2',family:'IPv4',internal:false}]};
  assert.equal(minecraft.parseMinecraftAnnouncement(announcement,{address:'100.64.10.2'},network)?.values.serverHost,'127.0.0.1');
  const campus={Campus:[{address:'202.120.10.2',family:'IPv4',internal:false}]};
  assert.equal(minecraft.parseMinecraftAnnouncement(announcement,{address:'202.120.10.3'},campus)?.values.serverHost,'202.120.10.3');
});

test('MC 发现只监听公告，去重并在到期或取消后释放 socket',async()=>{
  assert.equal(typeof minecraft.discoverMinecraftWorlds,'function','提供限时发现');
  const socket=new Socket();
  const pending=minecraft.discoverMinecraftWorlds({durationMs:25,interfaces,createSocketImpl:()=>socket});
  await new Promise(resolve=>setImmediate(resolve));
  socket.emit('message',announcement,{address:'192.168.10.3'});
  socket.emit('message',announcement,{address:'192.168.10.3'});
  socket.emit('message',Buffer.from('[MOTD]另一世界[/MOTD][AD]54321[/AD]'),{address:'192.168.10.4'});
  const result=await pending;
  assert.equal(result.candidates.length,2);assert.equal(socket.closed,true);assert.equal(socket.sends,0);
  assert.equal(socket.port,4445);assert.ok(socket.memberships.some(([group])=>group==='224.0.2.60'));
  const controller=new AbortController(),cancelledSocket=new Socket();
  const cancelled=minecraft.discoverMinecraftWorlds({signal:controller.signal,durationMs:1000,interfaces,createSocketImpl:()=>cancelledSocket});
  controller.abort();await assert.rejects(cancelled,/取消|abort/i);assert.equal(cancelledSocket.closed,true);
});

test('MC 无可用网卡及监听失败返回可重试原因，不伪造世界',async()=>{
  assert.equal(typeof minecraft.discoverMinecraftWorlds,'function');
  const socket=new Socket();
  const pending=minecraft.discoverMinecraftWorlds({durationMs:1000,interfaces,createSocketImpl:()=>socket});
  socket.emit('error',new Error('EADDRINUSE'));
  const result=await pending;
  assert.deepEqual(result.candidates,[]);assert.ok(result.warnings.length);assert.equal(socket.closed,true);
});

test('真实 UDP 公告经过发现器返回世界候选，结束后端口释放',async t=>{
  let receiver,ready;
  const listening=new Promise(resolve=>ready=resolve);
  const pending=minecraft.discoverMinecraftWorlds({durationMs:120,createSocketImpl:options=>{
    receiver=createSocket(options);const bind=receiver.bind.bind(receiver);
    // 使用临时端口，避免干扰 Minecraft 客户端自己的 4445 监听。
    receiver.bind=(_port,address,callback)=>bind(0,address,()=>{callback();ready(true);});
    return receiver;
  }});
  if (!await Promise.race([listening,pending.then(()=>false)])) {const result=await pending;assert.ok(result.warnings.length);t.skip('当前环境无法创建 UDP 监听');return;}
  let port;
  try {port=receiver.address().port;} catch {
    const result=await pending;assert.ok(result.warnings.length);t.skip('当前网卡不支持局域网公告监听');return;
  }
  const sender=createSocket('udp4');
  try {await new Promise((resolve,reject)=>sender.send(announcement,port,'127.0.0.1',error=>error?reject(error):resolve()));}
  finally {sender.close();}
  const result=await pending;assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].values.serverPort,'51234');
  assert.throws(()=>receiver.address(),/not running|closed|未运行/i);
});

test('共用发现缓存合并并发请求，重扫刷新且关闭取消未完成扫描',async()=>{
  assert.equal(typeof environment.EnvironmentDiscovery,'function','提供共用发现管理器');
  let calls=0,release;const blocked=new Promise(resolve=>release=resolve);
  const discovery=new environment.EnvironmentDiscovery({roots:[],scanLocal:async({signal})=>{calls++;if(calls===1)await blocked;signal.throwIfAborted();return {candidates:[],warnings:[],partial:false};}});
  const first=discovery.scan({moduleId:'comfyui'}),second=discovery.scan({moduleId:'comfyui'});
  release();await Promise.all([first,second]);assert.equal(calls,1);
  await discovery.scan({moduleId:'comfyui'});assert.equal(calls,1);
  await discovery.scan({moduleId:'comfyui',refresh:true});assert.equal(calls,2);
  let captured;
  const stopped=new environment.EnvironmentDiscovery({roots:[],scanLocal:({signal})=>new Promise((resolve,reject)=>{captured=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const pending=stopped.scan({moduleId:'qq'});await new Promise(resolve=>setImmediate(resolve));stopped.close();
  await assert.rejects(pending);assert.equal(captured.aborted,true);discovery.close();
});

test('已有 Python 环境变量沿用为明确候选来源，不执行解释器',async()=>{
  let captured;
  const env={AI_FUTURE_SKIN_PYTHON:'E:\\SkinPython\\python.exe',AI_FUTURE_COMFY_PYTHON:'E:\\ComfyPython\\python.exe'};
  const discovery=new environment.EnvironmentDiscovery({roots:[],env,scanLocal:async options=>{captured=options;return{candidates:[],partial:false,warnings:[]};}});
  await discovery.scan({moduleId:'mc-skin'});
  assert.ok(captured.hints.includes(env.AI_FUTURE_SKIN_PYTHON));assert.ok(captured.hints.includes(env.AI_FUTURE_COMFY_PYTHON));discovery.close();
});

test('发现接口只读、要求模块启用；选择扫描目录不保存配置或初始化QQ账号',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'environment-host-'));let scans=0,choices=0,modelCalls=0;
  const app=await createWorkbench({dataDir,environmentOptions:{roots:[],scanLocal:async()=>{scans++;return{candidates:[{id:'comfy',kind:'comfyui',path:'E:\\ComfyUI',label:'ComfyUI',values:{comfyPath:'E:\\ComfyUI'},selectable:true}],warnings:[],partial:false};}},
    chooseDirectory:async()=>{choices++;return dataDir;},aiOptions:{codexRunner:async()=>{modelCalls++;throw new Error('扫描不得调用模型');}}});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(app.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});return{status:response.status,...await response.json()};};
  assert.equal((await api('/api/environment/scan',{moduleId:'comfyui'})).status,409);
  await api('/api/modules/comfyui/enable',{});const before=await api('/api/state');
  const found=await api('/api/environment/scan',{moduleId:'comfyui'});
  assert.equal(found.status,200);assert.equal(found.candidates.length,1);assert.equal(found.canChooseDirectory,true);assert.equal(scans,1);
  await api('/api/environment/scan',{moduleId:'comfyui'});assert.equal(scans,1);
  await api('/api/environment/scan',{moduleId:'comfyui',refresh:true});assert.equal(scans,2);
  const selected=await api('/api/environment/choose-directory',{moduleId:'comfyui'});assert.equal(selected.directory,dataDir);assert.equal(choices,1);
  const after=await api('/api/state');assert.deepEqual(after.modules,before.modules);assert.equal(modelCalls,0);
  await api('/api/modules/qq/enable',{});await api('/api/environment/scan',{moduleId:'qq'});
  assert.equal((await readdir(dataDir)).includes('qq'),false);
  assert.equal((await api('/api/environment/scan',{moduleId:'comfyui',token:'bad'})).status,400);
  assert.equal((await api('/api/environment/scan',{moduleId:'comfyui',refresh:'yes'})).status,400);
  assert.equal((await api('/api/environment/scan')).status,405);
  assert.equal((await api('/api/environment/scan',{moduleId:'cards'})).status,400);
  assert.equal((await api('/api/environment/scan',{moduleId:'comfyui',directory:'//localhost/share'})).status,400);
});
