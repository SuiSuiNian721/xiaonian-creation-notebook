import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';

const source = await import('../framework/companion-source.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};
  throw error;
});
const runtime = await import('../framework/companion.mjs').catch(error=>{
  if(error.code==='ERR_MODULE_NOT_FOUND')return {};
  throw error;
});

const upstreamMain = `import messages from "@proj-airi/i18n/locales";
function getServerChannelPort() {
\treturn env.SERVER_CHANNEL_PORT ? Number.parseInt(env.SERVER_CHANNEL_PORT) : 6121;
}
async function setupMainWindowElectronInvokes(params) {
}
setupAutoUpdater({
\t\t\tenabled: true,
});
const resources = process$1.resourcesPath;
async function setupExtensionHost(options) {
  const hostService = await setupExtensionHostServiceInternal(options);
}
const mainWindow = injeca.provide("windows:main", {
\t\tdependsOn: {
\t\t\teditorWindow,
  }
});
`;

test('上游源码转换保留完整入口，禁用更新并隔离端口与资源路径',()=>{
  assert.equal(typeof source.adaptAiriMain,'function');
  const result=source.adaptAiriMain(upstreamMain,{resourcesPath:'E:/AIRI/resources',serverChannelPort:43101});
  assert.match(result,/enabled: false/);
  assert.doesNotMatch(result,/env\.SERVER_CHANNEL_PORT/);
  assert.match(result,/43101/);
  assert.match(result,/E:\/AIRI\/resources/);
  assert.match(result,/workbenchBridge/);
  assert.match(result,/shutdown/);
  assert.match(result,/await workbenchBridge\.extensionHost\?\.dispose\(\)/);
  assert.match(result,/dependsOn: \{\n\s+pluginHost,/);
});

test('上游结构变化时明确拒绝，不能悄悄加载未适配主进程',()=>{
  assert.equal(typeof source.adaptAiriMain,'function');
  assert.throws(()=>source.adaptAiriMain('export {};',{resourcesPath:'E:/AIRI/resources',serverChannelPort:43101}),/结构|兼容/);
});

test('缺少 AIRI 安装时返回实际不可用状态',()=>{
  assert.equal(typeof source.inspectAiriInstall,'function');
  const state=source.inspectAiriInstall('Z:/missing-airi');
  assert.equal(state.available,false);
  assert.match(state.reason,/陪伴|运行组件/);
});

test('安装位置不可用时仍返回实际检查路径，供手动修正',()=>{
  const path=resolve('Z:/missing-airi');
  const state=source.inspectAiriInstall(path);
  assert.equal(state.available,false);
  assert.equal(state.installPath,path);
  assert.equal(source.inspectAiriInstall(null).available,false);
});

async function fixture(t,options={}){
  assert.equal(typeof runtime.Companion,'function');
  const directory=await mkdtemp(join(tmpdir(),'ai-future-companion-test-'));
  const events=[];
  const settings=new Map();
  const store={getSetting:key=>settings.get(key),setSetting:(key,value)=>settings.set(key,value),event:value=>events.push(value),module:()=>({enabled:true}),state:()=>({selectedCharacterId:null,characters:[]})};
  const companion=new runtime.Companion({store,dataDir:directory,inspect:()=>({available:true,version:'0.12.0-beta.5',installPath:'E:/AIRI'}),...options});
  t.after(async()=>{await companion.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true});});
  return {companion,directory,events,store};
}

test('HTTP 模式可读状态，但不能冒充已启动的桌面运行端',async t=>{
  const {companion}=await fixture(t);
  assert.equal(companion.state().status,'idle');
  assert.equal(companion.state().desktopAvailable,false);
  await assert.rejects(companion.start('http://127.0.0.1:43001'),/桌面/);
});

test('并发启动共用一次实际运行端，关闭释放运行端',async t=>{
  let launches=0,closed=0;
  const {companion}=await fixture(t,{host:{async start(){launches++;await new Promise(resolve=>setTimeout(resolve,15));return {ready:true};},state:()=>({ready:true}),async close(){closed++;}}});
  await Promise.all([companion.start('http://127.0.0.1:43001'),companion.start('http://127.0.0.1:43001')]);
  assert.equal(launches,1);
  assert.equal(companion.state().status,'running');
  await companion.close();
  assert.equal(closed,1);
});

test('运行端初始化失败保留明确错误，允许修正后重试',async t=>{
  let launches=0;
  const {companion}=await fixture(t,{host:{async start(){if(++launches===1)throw new Error('资源不可用');return {ready:true};},async close(){}}});
  await assert.rejects(companion.start('http://127.0.0.1:43001'),/资源不可用/);
  assert.equal(companion.state().status,'error');
  await companion.start('http://127.0.0.1:43001');
  assert.equal(companion.state().status,'running');
});

test('视图矩形拒绝无效或过大参数，不调用原生宿主',async t=>{
  let updates=0;
  const {companion}=await fixture(t,{host:{async start(){},viewport(){updates++;},async close(){}}});
  await companion.start('http://127.0.0.1:43001');
  assert.throws(()=>companion.viewport({visible:true,x:-1,y:0,width:100,height:100}),/视图/);
  assert.throws(()=>companion.viewport({visible:true,x:0,y:0,width:Infinity,height:100}),/视图/);
  companion.viewport({visible:true,x:2,y:3,width:500,height:400});
  companion.viewport({visible:false});
  assert.equal(updates,2);
});

test('原生退出后报告需重启，不能仍返回运行中',async t=>{
  let ended=false;
  const {companion}=await fixture(t,{host:{async start(){},state:()=>({ready:!ended,restartRequired:ended}),async close(){}}});
  await companion.start('http://127.0.0.1:43001');ended=true;
  assert.equal(companion.state().status,'stopped');
  await assert.rejects(companion.start('http://127.0.0.1:43001'),/重新打开工作台/);
});

test('工作台切换角色取消旧请求，并同步到原生卡片',async t=>{
  let role={id:'a',name:'角色 A'},synced;
  const {companion,store}=await fixture(t,{host:{async start(){},async syncCharacter(value){synced=value;},async close(){}}});
  store.state=()=>({selectedCharacterId:role.id,characters:[role]});
  await companion.start('http://127.0.0.1:43001');
  let activeSignal,entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const pending=companion.request(companion.token,signal=>new Promise(resolve=>{activeSignal=signal;entered();signal.addEventListener('abort',resolve,{once:true});}));
  await ready;
  role={id:'b',name:'角色 B'};await companion.syncCharacter();
  assert.equal(activeSignal.aborted,true);assert.equal(synced.id,'b');await pending;
});

test('初始化期间切换角色，在运行端就绪前校准为最后选择',async t=>{
  let role={id:'a',name:'角色 A'},release,entered,native;
  const ready=new Promise(resolve=>{entered=resolve;});
  const {companion,store}=await fixture(t,{host:{async start(options){native=options.bootstrap.character;entered();await new Promise(resolve=>{release=resolve;});},async syncCharacter(character){native=character;},async close(){}}});
  store.state=()=>({selectedCharacterId:role.id,characters:[role]});
  const start=companion.start('http://127.0.0.1:43001');await ready;
  role={id:'b',name:'角色 B'};await companion.syncCharacter();release();await start;
  assert.equal(native.id,'b');assert.equal(companion.state().status,'running');
});
