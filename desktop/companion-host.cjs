const electron=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {registerHooks}=require('node:module');
const {createServer}=require('node:net');
const {EventEmitter}=require('node:events');
const {randomBytes,randomUUID}=require('node:crypto');
const {nativeCharacterContext,nativeLifeActions,nativeDeliver,nativeConfirmReply}=require('./companion-life.cjs');
const {builtinCompanionModels}=require('./companion-models.cjs');
const {registerHost,releaseHost,createModuleHooks,createIpcScope,createEventScope,createShortcutScope}=require('./companion-isolation.cjs');

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

async function until(predicate,timeout=35000){
  const end=Date.now()+timeout;
  while(!predicate()){
    if(Date.now()>end)throw new Error('陪伴组件初始化超时，请查看运行记录后重启工作台。');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}

class CompanionHost {
  constructor({getWindow,qa=false,onError=()=>{},onContents=()=>{},instanceId=null}={}){
    this.getWindow=getWindow;this.qa=qa;this.onError=onError;this.windows=new Map();this.appEvents=new EventEmitter();this.shortcuts=new Set();this.trays=new Set();
    this.instanceId=instanceId;this.hostId=randomUUID();
    this.area={visible:false};this.activeWindow=null;this.started=false;this.disposed=false;this.pending=null;this.errors=[];
    this.diagnostics=[];
    this.onContents=onContents;this.model={available:false,id:null,name:''};
  }
  state(){return {ready:this.started,restartRequired:this.disposed,visible:this.area.visible,activeView:this.activeWindow?.kind||'stage',model:this.model,windows:[...this.windows.values()].filter(window=>!window.isDestroyed()).map(window=>({id:window.id,view:window.kind,title:window.getTitle(),embedded:window.embedded}))};}
  start(options){
    if(this.started)return Promise.resolve(this.state());
    if(this.pending)return this.pending;
    if(this.disposed)return Promise.reject(new Error('陪伴运行端已结束，请重新打开工作台。'));
    this.pending=this.initialize(options).catch(async error=>{await this.close().catch(closeError=>this.capture(closeError));throw error;}).finally(()=>{this.pending=null;});return this.pending;
  }
  async initialize({install,dataDir,bootstrap}){
    this.install=install;this.dataDir=dataDir;this.bootstrap=bootstrap;this.serverChannelPort=await freePort();
    this.bootstrap.builtinModels=builtinCompanionModels();
    this.rootWindow=this.getWindow();this.rootListeners=[];
    for(const event of ['focus','blur','show','hide','minimize','restore']){
      const listener=()=>{for(const window of this.windows.values())if(window.embedded&&!window.isDestroyed()){this.notifyLifecycle(window);if(['minimize','restore'].includes(event))window.emit(event);}};
      this.rootWindow.on(event,listener);this.rootListeners.push([event,listener]);
    }
    fs.mkdirSync(path.join(dataDir,'browser'),{recursive:true});
    fs.mkdirSync(path.join(dataDir,'native'),{recursive:true});
    const channelFile=path.join(dataDir,'native/server-channel-config.json');
    let channel;
    if(fs.existsSync(channelFile))channel=JSON.parse(fs.readFileSync(channelFile,'utf8'));
    else {channel={hostname:'127.0.0.1',authToken:randomBytes(32).toString('hex'),tlsConfig:null};fs.writeFileSync(channelFile,JSON.stringify(channel,null,2),'utf8');}
    this.bootstrap.serverChannelToken=channel.authToken||'';
    this.session=electron.session.fromPath(path.join(dataDir,'browser'));
    const brandPath=path.join(__dirname,'../public-workbench/app-icon.png');
    this.bootstrap.brandLogo='data:image/png;base64,'+fs.readFileSync(brandPath).toString('base64');
    this.brandIcon=electron.nativeImage.createFromPath(brandPath).resize({width:32,height:32});
    this.ipcScope=createIpcScope(electron.ipcMain,contents=>this.owns(contents));
    this.processScope=createEventScope(process);
    this.powerScope=createEventScope(electron.powerMonitor);
    this.screenScope=createEventScope(electron.screen);
    this.shortcutScope=createShortcutScope(electron.globalShortcut,()=>!this.disposed&&[...this.windows.values()].some(window=>this.canFocus(window)&&window.isFocused()));
    this.bootstrapListener=(event)=>{const owned=[...this.windows.values()].find(window=>window.webContents===event.sender);if(owned)event.returnValue={...this.bootstrap,kind:owned.kind,serverChannelPort:this.serverChannelPort};};
    this.presentationListener=(event,value)=>{
      if(![...this.windows.values()].some(window=>window.kind==='stage'&&window.webContents===event.sender))return;
      if(!value||typeof value.available!=='boolean'||(value.available&&(typeof value.id!=='string'||!value.id.startsWith('display-model-')||typeof value.name!=='string')))return;
      this.model={available:value.available,id:value.available?value.id.slice(0,180):null,name:value.available?value.name.slice(0,200):''};
    };
    this.ipcScope.api.on('ai-future:companion:bootstrap',this.bootstrapListener);
    this.ipcScope.api.on('ai-future:companion:presentation',this.presentationListener);
    registerHost(this);
    const {readAiriArchiveFile,adaptAiriMain}=await import(pathToFileURL(path.join(__dirname,'../framework/companion-source.mjs')).href);
    const modules=createModuleHooks({hostId:this.hostId,archiveURL:pathToFileURL(install.archive).href+'/',mainURL:pathToFileURL(install.mainPath).href,
      shimURL:pathToFileURL(path.join(__dirname,'companion-electron.mjs')).href,processURL:pathToFileURL(path.join(__dirname,'companion-process.mjs')).href,
      loadMain:()=>adaptAiriMain(readAiriArchiveFile(install.archive,'out/main/index.js').toString('utf8'),{resourcesPath:install.resourcesPath,serverChannelPort:this.serverChannelPort}),
    });
    this.hooks=registerHooks(modules.hooks);
    try {
      const upstream=await import(modules.mainURL);
      this.bridge=upstream.workbenchBridge;
      await until(()=>!!this.bridge.controls&&[...this.windows.values()].some(window=>window.kind==='stage'&&window.webContents.getURL()&&!window.webContents.isLoading()));
      this.started=true;
      await this.syncCharacter(bootstrap.character);
      await this.open('stage');
      return this.state();
    } catch(error){await this.close();throw error;}
  }
  owns(contents){return !!contents&&[...this.windows.values()].some(window=>window.webContents===contents&&!contents.isDestroyed());}
  canFocus(window){return !this.disposed&&!window.isDestroyed()&&(window.embedded?this.activeWindow===window&&this.area.visible&&window.view.getVisible():electron.BaseWindow.prototype.isVisible.call(window));}
  open(kind,route){
    this.opening=(this.opening||Promise.resolve()).catch(()=>{}).then(()=>this.openNext(kind,route));
    return this.opening;
  }
  async openNext(kind,route){
    if(this.disposed)throw new Error('陪伴实例已经关闭。');
    if(!this.bridge?.controls)throw new Error('陪伴组件尚未完成初始化。');
    if(kind==='desktop'){
      const stage=[...this.windows.values()].find(window=>window.kind==='stage');
      if(!stage)throw new Error('角色舞台尚未载入。');
      this.detach(stage);return;
    }
    this.embeddingRequest=true;
    try{await this.bridge.controls[kind]?.(route);}finally{this.embeddingRequest=false;}
  }
  viewport(area){
    this.area={...this.area,...area};
    if(area.theme&&this.theme!==area.theme){
      this.theme=area.theme;if(this.bootstrap)this.bootstrap.theme=area.theme;
      for(const window of this.windows.values())if(!window.webContents.isDestroyed())void window.webContents.executeJavaScript(`localStorage.setItem('vueuse-color-scheme',${JSON.stringify(area.theme)});window.dispatchEvent(new StorageEvent('storage',{key:'vueuse-color-scheme',newValue:${JSON.stringify(area.theme)},storageArea:localStorage}));document.documentElement.classList.toggle('dark',${area.theme==='dark'});`).catch(()=>{});
    }
    if(!this.activeWindow?.embedded||this.activeWindow.webContents.isDestroyed())return;
    this.activeWindow.view.setVisible(!!area.visible);
    if(area.visible)this.layout();
    this.activeWindow.webContents.setBackgroundThrottling(!area.visible);
    this.notifyLifecycle(this.activeWindow);
  }
  layout(){
    const host=this.getWindow();
    if(!host||host.isDestroyed()||!this.activeWindow)return;
    const bounds=host.getContentBounds();
    const {x=0,y=0,width=0,height=0}=this.area;
    this.activeWindow.view.setBounds({x:Math.max(0,Math.round(x)),y:Math.max(0,Math.round(y)),width:Math.max(0,Math.min(Math.round(width),bounds.width-Math.round(x))),height:Math.max(0,Math.min(Math.round(height),bounds.height-Math.round(y)))});
  }
  activate(window){
    if(this.disposed||window.isOnboarding)return;
    if(window.kind==='auxiliary'){
      if(this.area.visible&&!this.qa)electron.BaseWindow.prototype.show.call(window);return;
    }
    const host=this.getWindow();if(!host||host.isDestroyed())return;
    if(this.activeWindow&&this.activeWindow!==window&&this.activeWindow.embedded&&!this.activeWindow.webContents.isDestroyed())this.activeWindow.view.setVisible(false);
    electron.BaseWindow.prototype.hide.call(window);
    window.embedded=true;
    host.contentView.addChildView(window.view);
    this.activeWindow=window;
    window.view.setVisible(!!this.area.visible);this.layout();
    window.webContents.setBackgroundThrottling(!this.area.visible);
    this.notifyLifecycle(window);
    void window.webContents.insertCSS('* { -webkit-app-region: no-drag !important; }').then(key=>{window.workbenchCSS=key;}).catch(()=>{});
  }
  detach(window){
    window.embedded=false;
    window.contentView.addChildView(window.view);
    const bounds=electron.BaseWindow.prototype.getContentBounds.call(window);
    window.view.setBounds({x:0,y:0,width:bounds.width,height:bounds.height});window.view.setVisible(true);
    if(window.workbenchCSS){void window.webContents.removeInsertedCSS(window.workbenchCSS).catch(()=>{});window.workbenchCSS=null;}
    if(!this.qa){electron.BaseWindow.prototype.show.call(window);window.focus();}
  }
  hideAll(){
    this.area.visible=false;
    for(const window of this.windows.values())if(!window.isDestroyed()){
      window.view.setVisible(false);electron.BaseWindow.prototype.hide.call(window);this.notifyLifecycle(window);
    }
  }
  notifyLifecycle(window){
    const visible=window.embedded&&window.view.getVisible?.()===true;
    const focused=visible&&(window.isFocused?.()===true);
    if(window.reportedVisible!==visible){window.reportedVisible=visible;window.emit?.(visible?'show':'hide');}
    if(window.reportedFocused!==focused){window.reportedFocused=focused;window.emit?.(focused?'focus':'blur');}
  }
  async syncCharacter(character){
    if(this.bootstrap)this.bootstrap.character=character;
    const stage=[...this.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());
    if(!stage)return;
    await stage.webContents.executeJavaScript(`(async()=>{
      const end=Date.now()+15000;let pinia;
      while(!(pinia=document.querySelector('#app')?.__vue_app__?.config.globalProperties?.$pinia)||!pinia._s.has('airi-card')){if(Date.now()>end)throw new Error('角色资料尚未准备好。');await new Promise(r=>setTimeout(r,50));}
      const cards=pinia._s.get('airi-card');await cards.initialize();
      const sessions=pinia._s.get('chat-session'),chat=pinia._s.get('chat');
      if(sessions?.activeSessionId){chat?.cancelPendingSends(sessions.activeSessionId);sessions.bumpSessionGeneration(sessions.activeSessionId);}
      const character=${JSON.stringify(character)};
      const key='ai-future/workbench-character-cards';let mapping={};try{mapping=JSON.parse(localStorage.getItem(key)||'{}');}catch{}
      if(!character){const previous=localStorage.getItem('ai-future/native-card-id')||'default';if(cards.getCard(previous))await cards.activateCard(previous);return;}
      if(!Object.values(mapping).includes(cards.activeCardId))localStorage.setItem('ai-future/native-card-id',cards.activeCardId);
      const data=character.raw?.data||character.raw||{},text=key=>typeof data[key]==='string'?data[key]:'',previous=mapping[character.id],base=cards.getCard(previous)||cards.activeCard||{};
      const description=character.description||data.description||'';
      const updates={...JSON.parse(JSON.stringify(base)),name:character.name,description,personality:text('personality'),scenario:text('scenario'),systemPrompt:text('system_prompt')||('你是'+character.name+'。\\n'+description+'\\n'+text('personality')),greetings:[text('first_mes'),...(Array.isArray(data.alternate_greetings)?data.alternate_greetings:[])].filter(item=>typeof item==='string'&&item)};
      let id=previous;
      if(id&&cards.getCard(id))await cards.updateCard(id,updates);else{id=await cards.addCard(updates,'import');mapping[character.id]=id;localStorage.setItem(key,JSON.stringify(mapping));}
      await cards.activateCard(id);
      if(sessions){await sessions.ensureCurrentSession();}
    })()`,true);
    await this.publishIdentity({character:character?{id:character.id,name:character.name,avatar:character.avatar||''}:null});
  }
  async publishIdentity(value){
    await Promise.all([...this.windows.values()].filter(window=>!window.webContents.isDestroyed()).map(window=>window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('workbench:companion-identity',{detail:${JSON.stringify(value)}}));`)));
  }
  async syncUserProfile(profile){
    if(this.bootstrap)this.bootstrap.userProfile=profile;
    await this.publishIdentity({userProfile:profile});
  }
  async characterContext(){
    const stage=[...this.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());
    if(!stage)return {managed:false};
    return stage.webContents.executeJavaScript(`(${nativeCharacterContext.toString()})()`);
  }
  async actions(value){
    const stage=[...this.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());
    if(!stage)return [];
    return stage.webContents.executeJavaScript(`(${nativeLifeActions.toString()})(${JSON.stringify(value)})`);
  }
  async deliver(value){
    const stage=[...this.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());
    if(!stage)return {delivered:false,status:'skipped',reason:'native-stage-unavailable'};
    return stage.webContents.executeJavaScript(`(${nativeDeliver.toString()})(${JSON.stringify(value)})`);
  }
  async confirmReply(value){
    const stage=[...this.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());
    if(!stage)return false;
    return stage.webContents.executeJavaScript(`(${nativeConfirmReply.toString()})(${JSON.stringify(value)})`);
  }
  capture(error){this.errors.push(String(error));this.onError(error);}
  async close(){
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      this.disposed=true;this.viewport({visible:false});
      const contents=[...this.windows.values()].map(window=>window.webContents);
      let timer;
      try{if(this.bridge)await Promise.race([this.bridge.shutdown(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('陪伴原生服务退出超时。')),8000);})]);}
      finally{
        clearTimeout(timer);
        for(const window of this.windows.values()){
          if(!window.webContents.isDestroyed())window.webContents.close();
          if(!window.isDestroyed())window.destroy();
        }
        this.shortcutScope?.dispose();
        for(const tray of this.trays)if(!tray.isDestroyed())tray.destroy();
        this.ipcScope?.dispose();this.processScope?.dispose();this.powerScope?.dispose();this.screenScope?.dispose();
        for(const [event,listener] of this.rootListeners||[])this.rootWindow?.removeListener(event,listener);
        this.hooks?.deregister();
        releaseHost(this);this.appEvents.removeAllListeners();
        this.started=false;
        // close() schedules destruction; wait before allowing the same profile to reopen.
        const destroyed=Promise.all(contents.filter(value=>!value.isDestroyed()).map(value=>new Promise(resolve=>value.once('destroyed',resolve))));
        try{await Promise.race([destroyed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('陪伴页面退出超时。')),5000);})]);}
        finally{clearTimeout(timer);}
      }
    })();return this.closing;
  }
}
module.exports={CompanionHost};
