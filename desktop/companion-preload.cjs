const {contextBridge,ipcRenderer,webFrame,webUtils}=require('electron');
const {companionBranding}=require('./companion-branding.cjs');
const {installCompanionPresentation}=require('./companion-presentation.cjs');
const {installCompanionChat}=require('./companion-chat.cjs');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const bootstrap=ipcRenderer.sendSync('ai-future:companion:bootstrap');
const ipc={};
for(const name of ['send','sendSync','sendToHost','postMessage','invoke'])ipc[name]=(...args)=>ipcRenderer[name](...args);
ipc.on=(channel,listener)=>{ipcRenderer.on(channel,listener);return ()=>ipcRenderer.removeListener(channel,listener);};
ipc.once=(channel,listener)=>{ipcRenderer.once(channel,listener);return ()=>ipcRenderer.removeListener(channel,listener);};
ipc.removeListener=(...args)=>{ipcRenderer.removeListener(...args);return ipc;};
ipc.removeAllListeners=channel=>{ipcRenderer.removeAllListeners(channel);return ipc;};
contextBridge.exposeInMainWorld('electron',{ipcRenderer:ipc,webFrame:{insertCSS:css=>webFrame.insertCSS(css),setZoomFactor:value=>webFrame.setZoomFactor(value),setZoomLevel:value=>webFrame.setZoomLevel(value)},webUtils:{getPathForFile:file=>webUtils.getPathForFile(file)},process:{platform:process.platform,versions:process.versions,env:{}}});
contextBridge.exposeInMainWorld('platform',process.platform);
if(bootstrap)contextBridge.executeInMainWorld({func:config=>{
  const read=key=>{try{return JSON.parse(localStorage.getItem(key)||'{}');}catch{return {};}};
  if(config.theme)localStorage.setItem('vueuse-color-scheme',config.theme);
  localStorage.setItem('settings/connection/websocket-url','ws://127.0.0.1:'+config.serverChannelPort+'/ws');
  localStorage.setItem('settings/connection/websocket-auth-token',config.serverChannelToken||'');
  const providers=read('settings/providers/configured');
  providers['workbench-shared']={id:'workbench-shared',definitionId:'openai-compatible',config:{baseUrl:config.baseUrl,apiKey:config.token},status:'configured',configuredBy:'user'};
  localStorage.setItem('settings/providers/configured',JSON.stringify(providers));
  const added=read('settings/providers/added');added['workbench-shared']=true;localStorage.setItem('settings/providers/added',JSON.stringify(added));
  if(!localStorage.getItem('settings/consciousness/active-provider')){
    localStorage.setItem('settings/consciousness/active-provider','workbench-shared');
    localStorage.setItem('settings/consciousness/active-model',config.model);
    localStorage.setItem('settings/consciousness/active-custom-model',config.model);
  }
},args:[bootstrap]});
if(bootstrap)contextBridge.executeInMainWorld({func:companionBranding,args:[bootstrap,'install']});
if(bootstrap)contextBridge.executeInMainWorld({func:installCompanionPresentation,args:[{kind:bootstrap.kind,builtinModels:bootstrap.builtinModels,styles:readFileSync(join(__dirname,'../public-workbench/companion-native.css'),'utf8')}]});
if(bootstrap?.kind==='chat')contextBridge.executeInMainWorld({func:installCompanionChat,args:[{kind:bootstrap.kind,character:bootstrap.character,userProfile:bootstrap.userProfile,styles:readFileSync(join(__dirname,'../public-workbench/companion-chat.css'),'utf8')}]});
