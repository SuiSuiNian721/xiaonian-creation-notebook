import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchError, fields, text } from './contracts.mjs';
import { minecraftRuntimeLaunch } from './mc-runtime-launch.mjs';
import { MinecraftSkinSession } from './mc-skin-session.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ACTIVE = new Set(['connecting','connected','disconnecting']);
const MOD = 'mc-play';
const SOURCE = {version:'0.15.1',commit:'89ec1e953f2e3b6f529d1f387d19bf5678ec6814',license:'MIT'};

export function minecraftConnection(value) {
  const serverHost = text(value.serverHost || '127.0.0.1','服务器地址',253).toLowerCase().replace(/\.$/,'');
  if(!isIP(serverHost) && !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(serverHost)) throw new WorkbenchError(400,'服务器地址应为主机名或 IP，不包含 http://、端口或路径。');
  const portValue = String(value.serverPort || '25565');
  if(!/^\d{1,5}$/.test(portValue) || Number(portValue)<1 || Number(portValue)>65535) throw new WorkbenchError(400,'游戏端口应为 1 到 65535 的整数。');
  const authMode = value.authMode || 'offline';
  if(!['offline','microsoft'].includes(authMode)) throw new WorkbenchError(400,'请选择离线登录或微软账号登录。');
  const playerName = text(value.playerName || 'AiriCompanion','机器人玩家名',254);
  if(authMode === 'offline' ? !/^[A-Za-z0-9_]{1,16}$/.test(playerName) : !/^[^\s\x00-\x1f\x7f]{1,254}$/.test(playerName)) throw new WorkbenchError(400,'离线玩家名应为 1 到 16 位英文字母、数字或下划线；微软登录可填写登录标识。');
  const ownerName = text(value.ownerName || '','你的游戏名',16,{empty:true});
  if(ownerName && !/^[A-Za-z0-9_]{1,16}$/.test(ownerName)) throw new WorkbenchError(400,'你的游戏名应为 1 到 16 位英文字母、数字或下划线。');
  const gameVersion = text(value.gameVersion === 'auto' ? '' : value.gameVersion || '','游戏版本',32,{empty:true});
  if(gameVersion && !/^\d+\.\d+(?:\.\d+)?$/.test(gameVersion)) throw new WorkbenchError(400,'游戏版本请填写例如 1.21.1，或留空自动识别。');
  return {serverHost,serverPort:Number(portValue),playerName,ownerName,authMode,gameVersion};
}

export class MinecraftCompanion {
  constructor({store,dataDir,sharedAI,spawnImpl=spawn,runtimeRoot,nodePath,componentProvider,coordination,skinOptions={}}) {
    this.store=store;this.dataDir=join(dataDir,MOD);this.ai=sharedAI;this.spawn=spawnImpl;
    this.coordination=coordination;
    this.componentProvider=runtimeRoot?null:componentProvider;this.nodePath=nodePath;
    const packaged=process.resourcesPath && join(process.resourcesPath,'airi-minecraft');
    this.root=runtimeRoot || (packaged && existsSync(join(packaged,'worker.mjs')) ? packaged : join(root,'integrations/airi-minecraft'));
    const bundled=join(this.root,'runtime',process.platform==='win32'?'node.exe':'node');
    this.node=nodePath || (existsSync(bundled) ? bundled : !process.versions.electron ? process.execPath : process.env.AI_FUTURE_NODE || (process.platform==='win32'?'C:\\Program Files\\nodejs\\node.exe':'node'));
    this.session=null;this.child=null;this.closed=false;this.connectTimer=null;this.stopPromise=null;this.startPromise=null;
    this.pending=new Map();this.aiRequests=new Set();this.history=store.getSetting('mc-play.history') || [];
    this.connection={status:'disconnected',paused:false,character:null};
    this.skin=new MinecraftSkinSession({store,dataDir,...skinOptions,connection:()=>this.connection,session:()=>this.session,
      send:(message,callback)=>{if(!this.child?.connected)throw new Error('游戏连接已关闭。');this.child.send(message,callback);},record:(kind,message)=>this.record(kind,message)});
    this.diagnostic=null;
  }
  runtimePaths(acquiredComponent) {
    const component=this.componentProvider?(acquiredComponent || this.componentProvider.resolve(MOD)):null;
    const runtimeRoot=this.componentProvider?component?.path:this.root;
    if(!runtimeRoot)return null;
    const componentNode=component?.origin==='existing' && component.nodePath || join(runtimeRoot,'runtime',process.platform==='win32'?'node.exe':'node');
    return {root:runtimeRoot,node:this.nodePath || (this.componentProvider?componentNode:this.node),...(component?.version?{version:component.version}:{})};
  }
  runtime() {
    const paths=this.child && this.session?.paths || this.runtimePaths();
    if(!paths)return {...SOURCE,available:false,missingComponents:[{id:MOD,name:'MC 陪玩组件'}],reason:'请先安装 MC 陪玩组件。',diagnostic:this.diagnostic};
    const missingComponents=[
      {id:'worker',name:'MC 陪玩工作进程 worker.mjs',path:join(paths.root,'worker.mjs')},
      {id:'tsx',name:'tsx TypeScript 运行库',path:join(paths.root,'node_modules/tsx/package.json')},
      {id:'isolated-vm',name:'isolated-vm 沙盒运行库',path:join(paths.root,'node_modules/isolated-vm/isolated-vm.js')},
      {id:'node',name:'Node.js 运行程序',path:paths.node},
    ].filter(component=>!existsSync(component.path)).map(({path,...component})=>component);
    const available=missingComponents.length===0;
    return {...SOURCE,...(paths.version?{version:paths.version}:{}),available,missingComponents,...(available?{}:{reason:'缺少 '+missingComponents.map(component=>component.name).join('、')+'。请安装或重新安装 MC 陪玩组件。'}),diagnostic:this.diagnostic};
  }
  state() {
    const workerActive=!!(this.child||this.startPromise||this.stopPromise);
    return {runtime:this.runtime(),config:this.store.module(MOD).config,connection:{...structuredClone(this.connection),workerActive,canDisconnect:workerActive&&this.connection.status!=='disconnecting'},skin:this.skin.state(),history:structuredClone(this.history),aiEnabled:this.ai.config(MOD).enabled};
  }
  record(kind,message,details={}) {
    const entry={id:randomUUID(),at:new Date().toISOString(),kind,message:String(message).slice(0,4000),sessionId:this.session?.id||null,characterId:this.session?.character?.id||null,...details};
    this.history.push(entry);this.history=this.history.slice(-150);this.store.setSetting('mc-play.history',this.history);
    return entry;
  }
  configure(value) {
    fields(value,['serverHost','serverPort','playerName','ownerName','authMode','gameVersion']);
    const config=minecraftConnection(value);
    this.store.saveConfig(MOD,Object.fromEntries(Object.entries(config).map(([key,val])=>[key,String(val)])));
    return this.state();
  }
  async connect(appUrl) {
    if(this.closed) throw new WorkbenchError(409,'工作台正在关闭。');
    if(!this.store.module(MOD).enabled) throw new WorkbenchError(409,'请先添加 MC 陪玩模块。');
    if(ACTIVE.has(this.connection.status) || this.child || this.startPromise || this.stopPromise) throw new WorkbenchError(409,'已有连接正在运行，请先断开再连接。');
    const runtime=this.runtime();if(!runtime.available) throw new WorkbenchError(503,runtime.reason);
    const settings=minecraftConnection(this.store.module(MOD).config);
    const selected=this.store.getSetting('selectedCharacterId');
    const character=selected ? this.store.character(selected) : null;
    const paused=!this.ai.config(MOD).enabled;
    const session={id:randomUUID(),token:randomBytes(32).toString('hex'),settings,character,startedAt:new Date().toISOString()};
    session.identityLease=this.coordination?.claimMinecraft(settings,session.id);
    this.session=session;
    this.connection={status:'connecting',paused,character:character?{id:character.id,name:character.name,revision:character.revision}:null,
      serverHost:settings.serverHost,serverPort:settings.serverPort,playerName:settings.playerName,ownerName:settings.ownerName,gameVersion:settings.gameVersion,startedAt:session.startedAt};
    const starting=this.startConnection(appUrl,session);this.startPromise=starting;
    try{return await starting;}finally{if(this.startPromise===starting)this.startPromise=null;}
  }
  async startConnection(appUrl,session) {
    const {settings,character}=session;
    let lease,child,releasePromise,released=false;
    const release=()=>{
      if(!released){released=true;session.unsubscribePeers?.();session.identityLease?.release();}
      return releasePromise ||= Promise.resolve().then(()=>lease?.release());
    };
    try {
      session.peerBotNames=[];
      session.unsubscribePeers=session.identityLease?.subscribe(names=>{
        session.peerBotNames=names;
        if(this.session===session && child && this.child===child && child.connected){
          try{child.send({type:'peers',sessionId:session.id,names},error=>{if(error&&this.session===session&&this.child===child){this.failure('无法更新同服 Bot 名单：'+error.message);void this.terminateChild(child);}});}
          catch(error){if(this.session===session&&this.child===child){this.failure('无法更新同服 Bot 名单：'+error.message);void this.terminateChild(child);}}
        }
      });
      if(this.componentProvider)lease=await this.componentProvider.acquire(MOD,MOD+':'+session.id);
      if(this.closed || this.session!==session)throw new WorkbenchError(409,'连接已取消。');
      session.paths=this.runtimePaths(lease);
      await mkdir(join(this.dataDir,'auth'),{recursive:true});
      if(this.closed || this.session!==session)throw new WorkbenchError(409,'连接已取消。');
      const launch=minecraftRuntimeLaunch({runtimeRoot:session.paths.root,nodePath:session.paths.node,cwd:this.dataDir});
      child=this.spawn(launch.command,launch.args,{...launch.options,stdio:['ignore','pipe','pipe','ipc']});
      this.child=child;
      let resolveStopped;session.stopped=new Promise(done=>{resolveStopped=done;});
      let stderr='';child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-5000);});
      child.stdout?.on('data',()=>{});
      child.on('message',message=>{if(this.child===child && this.session===session)this.receive(message);});
      let finished=false;
      const finish=(code,signal)=>{
        if(finished)return;finished=true;
        if(this.child===child){
          this.cancelAI();
          this.skin.disconnect();
          this.child=null;clearTimeout(this.connectTimer);
          for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new WorkbenchError(409,'游戏连接已关闭。'));}this.pending.clear();
          if(this.connection.status==='disconnecting' || code===0 && this.connection.status!=='error') this.connection={...this.connection,status:'disconnected',authentication:undefined};
          else if(this.connection.status!=='error')this.failure('MC 陪玩运行端已退出。'+(stderr?' '+stderr.slice(-1200):signal?' '+signal:''));
          this.record('connection',this.connection.status==='error'?'运行端已停止。':'已断开世界。');
        }
        void release().catch(error=>{this.record('error','无法释放 MC 陪玩组件：'+error.message);}).finally(resolveStopped);
      };
      const onError=error=>{
        if(this.child!==child)return;
        this.failure(error.message);
        if(!child.pid)finish(null,null);else void this.terminateChild(child);
      };
      child.on('error',onError);child.once('exit',finish);child.once('close',finish);
      child.send({type:'init',sessionId:session.id,settings,peerBotNames:session.peerBotNames,authDirectory:join(this.dataDir,'auth'),aiBaseUrl:appUrl+'/internal/mc-play/ai/v1/',aiToken:session.token,aiEnabled:this.ai.config(MOD).enabled},error=>{if(error)onError(error);});
      this.connectTimer=setTimeout(()=>{if(this.child===child && this.connection.status==='connecting'){this.failure('连接超时，请检查世界是否已开放、地址、端口、版本与登录方式。');void this.terminateChild(child);}},settings.authMode==='microsoft'?180000:45000);
      this.record('connection','正在连接世界。');this.store.event({moduleId:MOD,characterId:character?.id||null,kind:'minecraft.connecting',message:'已请求连接 Minecraft 世界。'});
    } catch(error) {
      if(child){void this.terminateChild(child);}else await release();
      if(this.closed || this.session!==session)throw new WorkbenchError(409,'连接已取消。');
      this.failure(error.message);throw new WorkbenchError(503,'无法启动 MC 陪玩运行端：'+error.message);
    }
    return this.state();
  }
  failure(message) {
    this.cancelAI();
    this.skin.disconnect();
    clearTimeout(this.connectTimer);
    this.connection={...this.connection,status:'error',error:String(message).slice(0,2000),authentication:undefined};
    this.record('error',message);
  }
  receive(message) {
    if(!message || typeof message!=='object' || message.sessionId!==this.session?.id)return;
    if(this.connection.status==='disconnecting')return;
    if(this.skin.receive(message))return;
    if(message.type==='identity' || message.type==='online') {
      if(!['connecting','connected'].includes(this.connection.status))return;
      let error;
      try{this.session.identityLease?.updateIdentity({playerName:message.username,uuid:message.uuid});}catch(cause){error=cause;}
      if(message.type==='identity'){
        const child=this.child,session=this.session;
        try{child?.send({type:'identity-result',sessionId:session.id,requestId:message.requestId,ok:!error,...(error?{error:error.message}:{})},cause=>{if(cause&&this.child===child&&this.session===session){this.failure(cause.message);void this.terminateChild(child);}});}
        catch(cause){error=cause;}
      }
      if(error){this.failure(error.message);void this.terminateChild(this.child);return;}
      if(message.type==='identity')return;
      clearTimeout(this.connectTimer);
      this.connection={...this.connection,status:'connected',error:undefined,authentication:undefined,playerName:String(message.username||this.connection.playerName),gameVersion:String(message.version||''),paused:!!message.paused,skinProtocol:message.skinProtocol===1?1:0};
      this.record('connection','机器人已进入世界。');this.store.event({moduleId:MOD,characterId:this.session.character?.id||null,kind:'minecraft.connected',message:'Minecraft 运行端报告已进入世界。'});
      this.skin.connected();
    } else if(message.type==='telemetry' && this.connection.status==='connected') {
      const {paused,health,food,position,players,inventory,dimension,gameMode,thinking,queueLength,actionQueue}=message;
      if(paused)this.cancelAI();
      Object.assign(this.connection,{paused:!!paused,health,food,position,players,inventory,dimension,gameMode,thinking:!!thinking,queueLength,actionQueue});
    } else if(message.type==='failure')this.failure(message.message || '游戏运行端出错。');
    else if(message.type==='offline'){this.cancelAI();this.skin.disconnect();this.connection={...this.connection,status:'disconnected',authentication:undefined};this.record('connection',message.reason||'世界连接已关闭。');}
    else if(message.type==='authentication'){this.connection.authentication={url:message.url,code:message.code,message:message.message};}
    else if(message.type==='chat')this.record('chat',message.text||'');
    else if(message.type==='notice')this.record('notice',message.text||'');
    else if(message.type==='action') {
      this.connection.action={tool:message.tool,state:message.state};
      this.record('action',`${message.tool} · ${{started:'开始',completed:'完成',failed:'失败'}[message.state]||message.state}`,{tool:message.tool,state:message.state,...(message.message?{error:message.message}:{}),...(message.result?{result:message.result}:{})});
    } else if(message.type==='command-result'){
      const pending=this.pending.get(message.requestId);if(!pending)return;
      this.pending.delete(message.requestId);clearTimeout(pending.timer);
      if(message.ok)pending.resolve({accepted:true});else pending.reject(new WorkbenchError(409,message.error||'运行端拒绝了这个操作。'));
    }
  }
  async command(value) {
    fields(value,['kind','text']);
    if(!['instruction','follow','come','pause','resume','chat'].includes(value.kind))throw new WorkbenchError(400,'请选择有效的陪玩操作。');
    if(this.connection.status!=='connected' || !this.child?.connected)throw new WorkbenchError(409,'请先连接 Minecraft 世界。');
    if(['instruction','resume'].includes(value.kind) && !this.ai.config(MOD).enabled)throw new WorkbenchError(409,'请先在陪玩接入配置或全局设置中启用 AI。');
    if(value.kind==='instruction' && this.connection.paused)throw new WorkbenchError(409,'AI 陪玩已暂停，请先点击恢复。');
    const content=['instruction','chat'].includes(value.kind)?text(value.text,'指令内容',value.kind==='chat'?256:4000):undefined;
    if(value.kind==='pause')this.cancelAI();
    const requestId=randomUUID();const child=this.child;const session=this.session;
    const result=await new Promise((resolveResult,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);reject(new WorkbenchError(504,'运行端尚未确认操作，请先查看实际状态再重试。'));},10000);
      this.pending.set(requestId,{resolve:resolveResult,reject,timer});
      child.send({type:'command',sessionId:session.id,requestId,kind:value.kind,...(content?{text:content}:{})},error=>{if(error){const pending=this.pending.get(requestId);if(pending){this.pending.delete(requestId);clearTimeout(timer);reject(new WorkbenchError(503,'无法向运行端发送操作。'));}}});
    });
    this.record('instruction',content || ({follow:'跟随我',come:'来到我身边',pause:'暂停并停止动作',resume:'恢复 AI 陪玩'}[value.kind]));
    return {...result,state:this.state()};
  }
  cancelAI() {for(const controller of this.aiRequests)controller.abort();}
  async complete(token,messages,{signal}={}) {
    const session=this.session;
    const expected=Buffer.from(session?.token||'');const actual=Buffer.from(String(token||''));
    if(!session || this.connection.status!=='connected' || expected.length!==actual.length || !timingSafeEqual(expected,actual))throw new WorkbenchError(403,'Minecraft 会话令牌无效或连接已关闭。');
    if(!this.store.module(MOD).enabled || this.connection.paused)throw new WorkbenchError(409,'MC 陪玩已停用或暂停。');
    if(!Array.isArray(messages) || messages.some(item=>!item || typeof item.content!=='string'))throw new WorkbenchError(400,'Minecraft AI 消息格式无效。');
    const persona=session.character ? `\n\n角色身份：${JSON.stringify({name:session.character.name,description:session.character.description,raw:session.character.raw}).slice(0,64000)}\n用该角色的身份和语气参与游戏。保留 Minecraft 规划与工具格式要求，游戏中的发言默认使用简体中文。` : '\n\n游戏中的发言默认使用简体中文。';
    const list=messages.map(message=>({...message}));
    if(list[0]?.role==='system')list[0].content+=persona;
    else list.unshift({role:'system',content:persona.trim()});
    const controller=new AbortController();const cancel=()=>controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)controller.abort();
    this.aiRequests.add(controller);
    try {
      if(controller.signal.aborted)throw new WorkbenchError(409,'Minecraft AI 请求已取消。');
      const result=await this.ai.complete(list,{moduleId:MOD,signal:controller.signal});
      if(controller.signal.aborted || this.session!==session || this.connection.status!=='connected' || this.connection.paused)throw new WorkbenchError(409,'Minecraft 会话已结束或暂停，旧回复已丢弃。');
      return result;
    } finally {signal?.removeEventListener('abort',cancel);this.aiRequests.delete(controller);}
  }
  async terminateChild(child) {
    if(child!==this.child)return;
    child.kill();
  }
  async disconnect() {
    this.cancelAI();
    this.skin.disconnect();
    if(this.stopPromise)return this.stopPromise;
    const child=this.child;clearTimeout(this.connectTimer);
    if(!child){
      const stopped=this.session?.stopped;this.session=null;this.connection={...this.connection,status:'disconnected',authentication:undefined};
      this.stopPromise=Promise.all([this.startPromise?.catch(()=>{}),stopped]).then(()=>this.state()).finally(()=>{this.stopPromise=null;});
      return this.stopPromise;
    }
    this.connection={...this.connection,status:'disconnecting',authentication:undefined};
    this.stopPromise=(async()=>{
      const timer=setTimeout(()=>{void this.terminateChild(child);},6500);
      try{
        if(child.connected){try{child.send({type:'disconnect',sessionId:this.session.id},error=>{if(error)void this.terminateChild(child);});}catch{void this.terminateChild(child);}}
        else void this.terminateChild(child);
        await this.session.stopped;
      }finally{clearTimeout(timer);}
      return this.state();
    })().finally(()=>{this.stopPromise=null;});
    return this.stopPromise;
  }
  async close() {this.closed=true;this.skin.close();await this.disconnect();}
}
