import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const integration=resolve('integrations/airi-minecraft');
const mode=process.argv[2]||'chat';
const reports=[],signals=[],commands=[];const timers=new Map();
let opened=0,probes=0,paused=false,toggles=0,stopped=0,cognitiveOptions;
const processStub=new EventEmitter();Object.assign(processStub,{argv:[],connected:true,send(message,callback){reports.push(message);callback?.();},exit(){this.connected=false;}});
const gameBot=new EventEmitter();Object.assign(gameBot,{username:'SelfBot',version:'1.20.1',players:{},health:20,food:20,game:{},inventory:{items:()=>[]},chat:message=>commands.push(message)});
const bot={bot:gameBot,username:'SelfBot',ready:false,onTick(){},stop:async()=>{stopped++;},loadPlugin:async plugin=>plugin.created(bot)};
const brain={setPaused:value=>{paused=value;},isPaused:()=>paused,togglePaused:()=>{toggles++;return paused=!paused;},stopForWorkbench:async()=>{paused=true;stopped++;},getDebugSnapshot:()=>({isProcessing:false,queueLength:0,actionQueue:[]}),init(){}};
const executor=new EventEmitter();Object.assign(executor,{setMineflayer(){},initialize:async()=>{},executeActionWithResult:async value=>commands.push(value)});
const services={brain,taskExecutor:executor,eventBus:{emit:event=>signals.push(event)},perceptionPipeline:{init(){}},reflexManager:{init(){}},airiBridge:{init(){}},minecraftContextService:{init(){}},ruleEngine:{}};
const config={};
const context=vm.createContext({console,process:processStub,Buffer,URL,AbortController,queueMicrotask,setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timers.set(timer,{fn,ms});return timer;},clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer);},setInterval:()=>0,clearInterval(){}});
const modules=new Map();
async function synthetic(id,exports){const module=new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context,identifier:id});await module.link(()=>{});await module.evaluate();modules.set(id,module);return module;}
async function loadSource(id,source){const module=new vm.SourceTextModule(source,{context,identifier:id,importModuleDynamically:specifier=>lookup(specifier)});await module.link(lookup);await module.evaluate();return module;}
function lookup(specifier){const module=modules.get(specifier);if(!module)throw new Error('Missing fixture dependency '+specifier);return module;}
const connect=client=>{if(!client.username){probes++;return;}opened++;client.socket={destroyed:true};gameBot.entity={position:{x:0,y:64,z:0}};queueMicrotask(()=>{bot.ready=true;gameBot.emit('spawn');});};
await synthetic('node:events',{EventEmitter});
await synthetic('node:crypto',{randomUUID});
await synthetic('tsx/esm/api',{register(){}});
await synthetic('@guiiai/logg',{setGlobalLogLevel(){},LogLevel:{Error:0}});
await synthetic('minecraft-protocol/src/client/tcp_dns.js',{default(_client,options){options.connect=connect;}});
await synthetic('./upstream/src/libs/mineflayer/index.ts',{Mineflayer:{asyncBuild:async({botConfig,plugins})=>{
  const protocolClient=Object.assign(new EventEmitter(),{username:'SelfBot',uuid:'12345678-1234-1234-1234-123456789abc'});gameBot._client=protocolClient;(botConfig.connect||connect)(protocolClient);
  for(const plugin of plugins)await plugin.created?.(bot);
  // Auto-version uses the same connector for a status client that has no player identity.
  (botConfig.connect||connect)({});return bot;
}},wrapPlugin:value=>value});
await synthetic('./upstream/src/composables/config.ts',{config});
await synthetic('../composables/config',{config});
await synthetic('./upstream/src/cognitive/conscious/js-planner.ts',{JavaScriptPlanner:class {}});
for(const [name,key] of [['mineflayer-armor-manager','default'],['mineflayer-auto-eat','loader'],['mineflayer-collectblock','plugin'],['mineflayer-pathfinder','pathfinder'],['mineflayer-pvp','plugin'],['mineflayer-tool','plugin']])await synthetic(name,{[key]:()=>{}});
await synthetic('../debug',{DebugService:{getInstance:()=>({onCommand(){}})}});
await synthetic('../debug/mcp-repl-server',{McpReplServer:class {}});
await synthetic('../libs/mineflayer',{ChatMessageHandler:class {constructor(name){this.name=name;}isBotMessage(name){return this.name===name;}}});
await synthetic('./container',{createAgentContainer:client=>{
  client.onEvent('spark:command',event=>commands.push(event));return {resolve:name=>services[name]};
}});
const cognitive=await loadSource('cognitive',stripTypeScriptTypes(await readFile(resolve(integration,'upstream/src/cognitive/index.ts'),'utf8')));
await synthetic('./upstream/src/cognitive/index.ts',{CognitiveEngine:options=>{cognitiveOptions=options;return cognitive.namespace.CognitiveEngine(options);}});
const settle=async()=>{for(let i=0;i<5;i++)await new Promise(done=>setImmediate(done));};
const send=message=>processStub.emit('message',message);
const say=(username,message)=>{gameBot.emit('message',{toString:()=>`<${username}> ${message}`},'chat');gameBot.emit('chat',username,message);};
try{
  modules.set('./skin-application.mjs',await loadSource('skin-application',await readFile(resolve(integration,'skin-application.mjs'),'utf8')));
  await loadSource('worker',await readFile(resolve(integration,'worker.mjs'),'utf8'));
  send({type:'init',sessionId:'current',settings:{serverHost:'localhost',serverPort:25565,playerName:'SelfBot',authMode:'offline'},authDirectory:'fixture',aiBaseUrl:'http://fixture/',aiToken:'fixture',aiEnabled:true,peerBotNames:['PeerBot']});
  await settle();assert.equal(opened,0,'游戏登录连接必须先通过身份复核');assert.equal(probes,1,'自动版本的状态探测无需玩家身份');
  assert.equal(reports.filter(message=>message.type==='identity').length,1,'状态探测不能覆盖登录身份请求');
  const identity=reports.find(message=>message.type==='identity');assert.ok(identity);assert.equal(identity.uuid,'12345678-1234-1234-1234-123456789abc');
  send({type:'identity-result',sessionId:'stale',requestId:identity.requestId,ok:true});await settle();assert.equal(opened,0,'旧会话批准不能连接');
  send({type:'identity-result',sessionId:'current',requestId:'wrong',ok:true});await settle();assert.equal(opened,0,'错误请求批准不能连接');
  if(mode!=='chat'){
    if(mode==='denied')send({type:'identity-result',sessionId:'current',requestId:identity.requestId,ok:false,error:'身份已被占用'});
    else if(mode==='timeout'){
      const [timer,entry]=[...timers].find(([,entry])=>entry.ms===15000);clearTimeout(timer);timers.delete(timer);entry.fn();
    }else if(mode==='cancel')send({type:'disconnect',sessionId:'current'});
    else throw new Error('Unknown fixture mode '+mode);
    await settle();assert.equal(processStub.connected,false);assert.equal(opened,0);
    send({type:'identity-result',sessionId:'current',requestId:identity.requestId,ok:true});await settle();assert.equal(opened,0,'失败或取消后的迟到批准不能进入世界');
    if(mode!=='cancel')assert.ok(reports.some(message=>message.type==='failure'));
  }else{
  send({type:'identity-result',sessionId:'current',requestId:identity.requestId,ok:true});await settle();assert.equal(opened,1);assert.ok(reports.some(message=>message.type==='online'&&message.uuid===identity.uuid));
  say('PeerBot','你好');say('peerbot','!pause');assert.equal(signals.length,0);assert.equal(toggles,0);
  assert.equal(reports.filter(message=>message.type==='chat').length,2,'被隔离的同伴聊天仍可见');
  say('HumanPlayer','帮我收集木头');say('HumanBot','我是真人');assert.equal(signals.length,2,'不能按名称后缀猜测玩家是否为 Bot');
  say('HumanPlayer','!pause');assert.equal(toggles,1);
  send({type:'peers',sessionId:'stale',names:['HumanPlayer']});say('PeerBot','仍应忽略');assert.equal(signals.length,2);
  send({type:'peers',sessionId:'current',names:['NewPeer']});say('PeerBot','已经离开工作台');say('newpeer','!pause');assert.equal(signals.length,3);assert.equal(toggles,1);
  send({type:'command',sessionId:'current',requestId:'resume',kind:'resume'});await settle();
  send({type:'command',sessionId:'current',requestId:'instruction',kind:'instruction',text:'帮我建造'});await settle();assert.ok(commands.some(value=>value?.type==='spark:command'));
  assert.equal(reports.find(message=>message.type==='online').skinProtocol,1);
  send({type:'skin',sessionId:'stale',requestId:'old-skin',reset:true});await settle();assert.ok(!commands.includes('/skin clear'));
  send({type:'skin',sessionId:'current',requestId:'clear-skin',reset:true});await settle();assert.ok(commands.includes('/skin clear'));
  assert.ok(!reports.some(message=>message.type==='skin-result'&&message.requestId==='clear-skin'));
  gameBot._client.emit('player_info',{action:{add_player:true},data:[{uuid:identity.uuid,player:{properties:[]}}]});await settle();
  assert.ok(reports.some(message=>message.type==='skin-result'&&message.requestId==='clear-skin'&&message.ok&&message.profile.hash===null));
  send({type:'init',sessionId:'stale'});await settle();assert.equal(processStub.connected,true,'重复或旧的初始化不能停止当前会话');
  const before=stopped;send({type:'disconnect',sessionId:'stale'});await settle();assert.equal(stopped,before);assert.equal(processStub.connected,true);
  send({type:'disconnect',sessionId:'current'});await settle();assert.equal(processStub.connected,false);assert.ok(cognitiveOptions);
  }
  console.log('MC_BOTS_WORKER_OK');
}finally{for(const timer of timers.keys())clearTimeout(timer);}
