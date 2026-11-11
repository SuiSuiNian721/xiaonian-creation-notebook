import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { register } from 'tsx/esm/api';
import { setGlobalLogLevel, LogLevel } from '@guiiai/logg';
import { createSkinApplication } from './skin-application.mjs';

register();
setGlobalLogLevel(LogLevel.Error);

const { Mineflayer, wrapPlugin } = await import('./upstream/src/libs/mineflayer/index.ts');
const { CognitiveEngine } = await import('./upstream/src/cognitive/index.ts');
const { config } = await import('./upstream/src/composables/config.ts');
const { JavaScriptPlanner } = await import('./upstream/src/cognitive/conscious/js-planner.ts');
const { default: configureConnection } = await import('minecraft-protocol/src/client/tcp_dns.js');

if (process.argv.includes('--self-test')) {
  const planner = new JavaScriptPlanner();
  const globals = { event:{type:'system_alert',payload:{},source:{type:'system',id:'runtime-check'},timestamp:Date.now()},snapshot:{} };
  const result = await planner.evaluate('return 6 * 7', [], globals, async () => { throw new Error('自检不执行游戏动作'); });
  if (result.returnValue !== '42') throw new Error('AIRI 隔离执行器没有返回预期结果');
  console.log(JSON.stringify({ok:true,source:'AIRI',version:'0.15.1',cognitiveEngine:true,isolatedPlanner:true}));
  process.exit(0);
}

let sessionId;
let bot;
let brain;
let executor;
let timer;
let stopping = false;
let initialized = false;
let settings;
let snapshot;
let peerBotNames = new Set();
let identityRequest;
let skinApplication;
let skinRequest;

function report(type, value = {}) {
  if (process.connected) process.send({type,sessionId,...value}, () => {});
}
const messageOf = error => String(error?.message || error || '未知错误').slice(0,2000);

function updatePeers(names) {
  if(Array.isArray(names))peerBotNames=new Set(names.filter(name=>typeof name==='string'&&/^[A-Za-z0-9_]{1,16}$/.test(name)).map(name=>name.toLowerCase()));
}

function confirmIdentity(current) {
  return new Promise((resolveIdentity,reject)=>{
    const requestId=randomUUID();
    const timer=setTimeout(()=>{if(identityRequest?.requestId===requestId)identityRequest=null;reject(new Error('工作台尚未确认 Bot 身份，请重新连接。'));},15000);
    identityRequest={requestId,timer,resolve:resolveIdentity,reject};
    report('identity',{requestId,username:current.username,uuid:current.session?.selectedProfile?.id || current.uuid});
  });
}

// AIRI's cognitive bridge keeps its event contract. The workbench supplies IPC transport.
class WorkbenchClient {
  events = new EventEmitter();
  onEvent(type, listener) { this.events.on(type,listener); }
  offEvent(type, listener) { this.events.off(type,listener); }
  send(event) {
    if(event.type === 'spark:notify') report('notice',{text:[event.data.headline,event.data.note].filter(Boolean).join('：')});
    if(event.type === 'spark:emit') report('intent',{requestId:event.data.eventId,state:event.data.state,note:event.data.note});
  }
  dispatch(type, data) { this.events.emit(type,{type,data}); }
}
const client = new WorkbenchClient();

function telemetry() {
  if(!bot?.bot.entity || !brain) return;
  const current = bot.bot;
  const position = current.entity.position;
  const debug = brain.getDebugSnapshot();
  report('telemetry',{
    paused:brain.isPaused(),health:current.health,food:current.food,
    position:{x:position.x,y:position.y,z:position.z},
    players:Object.keys(current.players || {}).filter(name=>name !== current.username).slice(0,100),
    inventory:current.inventory.items().map(item=>({name:item.name,count:item.count})).slice(0,50),
    dimension:current.game?.dimension,gameMode:current.game?.gameMode,
    thinking:debug.isProcessing,queueLength:debug.queueLength,
    actionQueue:debug.actionQueue,
  });
}

async function start(message) {
  if(initialized) throw new Error('运行端已经初始化');
  initialized = true; sessionId = message.sessionId; settings = message.settings;
  updatePeers(message.peerBotNames);
  config.openai = {apiKey:message.aiToken,baseUrl:message.aiBaseUrl,model:'workbench-shared',reasoningModel:'workbench-shared'};
  config.bot = {username:settings.playerName,host:settings.serverHost,port:settings.serverPort,auth:settings.authMode,
    ...(settings.gameVersion ? {version:settings.gameVersion} : {}),
    masterUsername:settings.ownerName || undefined,
    profilesFolder:message.authDirectory,
    onMsaCode:code=>report('authentication',{url:code.verification_uri || 'https://www.microsoft.com/link',code:code.user_code,message:'请用机器人的微软账号完成登录。'}),
  };
  // minecraft-protocol resolves Microsoft profiles before invoking this connector.
  // Reserve the real name/UUID before opening the game socket, preserving its DNS/SRV routing.
  configureConnection(null,config.bot);
  const connect=config.bot.connect;
  config.bot.connect=current=>{
    if(stopping)return;
    // Automatic version discovery also calls this hook with an anonymous status client.
    if(!current.username){connect(current);return;}
    void confirmIdentity(current).then(()=>{if(!stopping)connect(current);}).catch(error=>{
      if(!stopping)report('failure',{message:messageOf(error)});
      void shutdown();
    });
  };
  config.debug = {mcp:false,server:false,viewer:false};
  const [{default:armor},{loader:autoEat},{plugin:collect},{pathfinder},{plugin:pvp},{plugin:tool}] = await Promise.all([
    import('mineflayer-armor-manager'),import('mineflayer-auto-eat'),import('mineflayer-collectblock'),
    import('mineflayer-pathfinder'),import('mineflayer-pvp'),import('mineflayer-tool'),
  ]);
  const skinPlugin={created:current=>{skinApplication=createSkinApplication(current.bot,{onObserved:profile=>report('skin-observed',{profile})});}};
  bot = await Mineflayer.asyncBuild({botConfig:config.bot,plugins:[skinPlugin,...[armor,autoEat,collect,pathfinder,pvp,tool].map(wrapPlugin)],reconnect:{enabled:false}});
  if(stopping){await bot.stop();return;}
  bot.bot.on('error',error=>report('failure',{message:messageOf(error)}));
  bot.bot.on('kicked',reason=>report('failure',{message:'服务器拒绝连接：'+(typeof reason==='string'?reason:JSON.stringify(reason)).slice(0,1000)}));
  bot.bot.on('end',reason=>{report('offline',{reason:String(reason||'服务器连接已关闭')});void shutdown();});
  bot.bot.on('message', (component,position) => {
    if(position === 'game_info') return;
    const value=component.toString();if(value.trim())report('chat',{text:value.slice(0,2000)});
  });
  await bot.loadPlugin(CognitiveEngine({
    airiClient:client,
    isPeerBot:username=>peerBotNames.has(username.toLowerCase()),
    onWorkbenchReady:services=>{
      brain=services.brain; executor=services.taskExecutor;
      brain.setPaused(true);
      for(const state of ['started','completed','failed']) executor.on('action:'+state,detail=>{
        report('action',{state,tool:detail.action.tool,params:detail.action.params,
          ...(state==='failed'?{message:messageOf(detail.error)}:{}),
          ...(state==='completed'?{result:typeof detail.result==='string'?detail.result.slice(0,2000):JSON.stringify(detail.result||null).slice(0,2000)}:{}),
        });
      });
      const enteredWorld=()=>{
        if(stopping)return;
        brain.setPaused(!message.aiEnabled);
        report('online',{username:bot.bot.username,uuid:bot.bot._client?.uuid || bot.bot._client?.session?.selectedProfile?.id,version:bot.bot.version,paused:brain.isPaused(),skinProtocol:1});
        const profile=skinApplication.current();if(profile)report('skin-observed',{profile});
        telemetry();timer=setInterval(telemetry,2000);
      };
      if(bot.ready)enteredWorld();else bot.bot.once('spawn',enteredWorld);
    },
  }));
}

async function command(message) {
  if(message.sessionId !== sessionId || !brain || !bot?.bot.entity) throw new Error('机器人尚未进入世界');
  if(message.kind === 'pause') {
    await brain.stopForWorkbench();telemetry();return;
  }
  if(message.kind === 'resume') {brain.setPaused(false);telemetry();return;}
  if(message.kind === 'instruction') {
    if(brain.isPaused()) throw new Error('请先恢复 AI 陪玩');
    client.dispatch('spark:command',{commandId:message.requestId,intent:'action',interrupt:'soft',priority:'high',guidance:{options:[{label:message.text,steps:[message.text]}]}});
    return;
  }
  if(!settings.ownerName && ['follow','come'].includes(message.kind)) throw new Error('请先填写你的游戏名，再重新连接');
  if(message.kind === 'follow') {
    if(!bot.bot.players[settings.ownerName]?.entity) throw new Error('当前视野内找不到 '+settings.ownerName);
    await executor.executeActionWithResult({tool:'followPlayer',params:{player_name:settings.ownerName,follow_dist:2}});return;
  }
  if(message.kind === 'come') {
    if(!bot.bot.players[settings.ownerName]?.entity) throw new Error('当前视野内找不到 '+settings.ownerName);
    void executor.executeActionWithResult({tool:'goToPlayer',params:{player_name:settings.ownerName,closeness:2}}).catch(error=>report('notice',{text:messageOf(error)}));return;
  }
  if(message.kind === 'chat') {bot.bot.chat(message.text);return;}
  throw new Error('不支持这个游戏操作');
}

async function applySkin(message) {
  if(stopping || !brain || !bot?.bot.entity || !skinApplication)throw new Error('机器人尚未进入世界。');
  if(skinRequest)throw new Error('正在等待上一次皮肤应用完成。');
  const request={id:message.requestId,controller:new AbortController()};skinRequest=request;
  try{return await skinApplication.apply(message.reset?{reset:true}:message.texture,{signal:request.controller.signal});}
  finally{if(skinRequest===request)skinRequest=null;}
}

async function shutdown() {
  if(stopping) return;
  stopping = true; clearInterval(timer);
  skinRequest?.controller.abort();skinApplication?.close();
  if(identityRequest){clearTimeout(identityRequest.timer);identityRequest.reject(new Error('连接已取消。'));identityRequest=null;}
  const emergency=setTimeout(()=>process.exit(0),5000);emergency.unref();
  try {
    if(brain) await brain.stopForWorkbench();
    const socket=bot?.bot?._client?.socket;
    const ended=!socket || socket.destroyed?Promise.resolve():new Promise(resolveEnd=>socket.once('close',resolveEnd));
    await bot?.stop();
    await Promise.race([ended,new Promise(resolveEnd=>setTimeout(resolveEnd,1000))]);
  }
  catch {}
  finally { report('closed');process.exit(0); }
}
process.on('message',message=>{
  if(!message || typeof message !== 'object')return;
  if(message.type === 'init'){
    if(initialized || stopping || typeof message.sessionId!=='string' || !message.sessionId)return;
    void start(message).catch(error=>{console.error(error.stack||error);report('failure',{message:messageOf(error),stack:error.stack});void shutdown();});
  }
  else if(!initialized || message.sessionId !== sessionId)return;
  else if(message.type === 'peers')updatePeers(message.names);
  else if(message.type === 'identity-result'){
    if(!identityRequest || message.requestId!==identityRequest.requestId)return;
    const pending=identityRequest;identityRequest=null;clearTimeout(pending.timer);
    if(message.ok)pending.resolve();else pending.reject(new Error(message.error||'这个 Bot 身份已被占用。'));
  }
  else if(message.type === 'disconnect')void shutdown();
  else if(message.type === 'skin')void applySkin(message).then(profile=>report('skin-result',{requestId:message.requestId,ok:true,profile}),error=>report('skin-result',{requestId:message.requestId,ok:false,error:messageOf(error)}));
  else if(message.type === 'skin-cancel' && message.requestId===skinRequest?.id)skinRequest.controller.abort();
  else if(message.type === 'command')void command(message).then(()=>report('command-result',{requestId:message.requestId,ok:true}),error=>report('command-result',{requestId:message.requestId,ok:false,error:messageOf(error)}));
});
process.on('disconnect',()=>void shutdown());
process.on('SIGTERM',()=>void shutdown());
process.on('SIGINT',()=>void shutdown());
process.on('uncaughtException',error=>{report('failure',{message:messageOf(error)});void shutdown();});
process.on('unhandledRejection',error=>{report('failure',{message:messageOf(error)});void shutdown();});
