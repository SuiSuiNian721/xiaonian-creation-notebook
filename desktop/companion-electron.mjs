import real from 'electron';
import {join} from 'node:path';
import {companionBranding} from './companion-branding.cjs';
import {hostForURL} from './companion-isolation.cjs';

const host=hostForURL(import.meta.url);
const context=()=>host;
const native=real.BaseWindow.prototype;
const bind=(target,key)=>typeof target[key]==='function'?target[key].bind(target):target[key];
const ignored=new Set(['setName','setAppUserModelId','setAsDefaultProtocolClient','removeAsDefaultProtocolClient','setLoginItemSettings','setAboutPanelOptions']);

export const app=new Proxy(real.app,{get(target,key){
  const host=context();
  if(key==='isPackaged')return true;
  if(key==='getVersion')return ()=>host.install.version;
  if(key==='getName')return ()=>'小念的创作笔记';
  if(key==='getAppPath')return ()=>host.install.archive;
  if(key==='getPath')return name=>['userData','sessionData','logs','cache'].includes(name)?join(host.dataDir,name==='userData'?'native':name):target.getPath(name);
  if(key==='setPath')return ()=>{};
  if(key==='requestSingleInstanceLock')return ()=>true;
  if(key==='releaseSingleInstanceLock')return ()=>{};
  if(key==='quit'||key==='exit')return ()=>{void host.close().catch(error=>host.capture(error));};
  if(['on','once','addListener','prependListener','prependOnceListener','removeListener','removeAllListeners','off','emit','listeners','rawListeners','listenerCount','eventNames'].includes(key))return host.appEvents[key].bind(host.appEvents);
  if(key==='commandLine')return new Proxy(target.commandLine,{get:(command,method)=>method==='appendSwitch'?()=>{}:bind(command,method)});
  if(ignored.has(key))return ()=>{};
  return bind(target,key);
}});

export class BrowserWindow extends real.BaseWindow {
  constructor(options={}){
    super({...options,title:companionBranding(options.title),icon:context().brandIcon,show:false});
    this.host=context();
    this.kind=options.title==='AIRI'?'stage':options.title==='Chat'?'chat':options.title==='Settings'?'settings':options.title==='AIRI Editor'?'editor':'auxiliary';
    this.isOnboarding=options.title==='Welcome to AIRI';
    this.embedded=false;
    this.view=new real.WebContentsView({webPreferences:{...options.webPreferences,preload:join(import.meta.dirname,'companion-preload.cjs'),session:this.host.session,partition:undefined,backgroundThrottling:true,offscreen:false}});
    this.view.setBackgroundColor(options.transparent?'#00000000':options.backgroundColor||'#ffffff');
    this.webContents=this.view.webContents;
    const windowId=this.id;
    this.host.windows.set(windowId,this);
    this.host.onContents(this.webContents,this);
    this.contentView.addChildView(this.view);
    this.view.setBounds({x:0,y:0,width:options.width||800,height:options.height||600});
    this.webContents.once('did-finish-load',()=>this.emit('ready-to-show'));
    this.webContents.on('render-process-gone',(_,details)=>this.host.capture('陪伴页面进程退出：'+details.reason));
    this.webContents.on('preload-error',(_,file,error)=>this.host.capture('陪伴预加载失败：'+error.message));
    this.webContents.on('console-message',event=>{if(event.level==='error'||/Uncaught|Error|failed/i.test(event.message)){this.host.diagnostics.push({view:this.kind,message:event.message.slice(0,1000)});if(this.host.diagnostics.length>30)this.host.diagnostics.shift();}});
    this.on('resize',()=>{if(!this.embedded){const bounds=native.getContentBounds.call(this);this.view.setBounds({x:0,y:0,width:bounds.width,height:bounds.height});}});
    this.on('closed',()=>{
      if(!this.webContents.isDestroyed())this.webContents.close();this.host.windows.delete(windowId);
      if(this.host.activeWindow===this){
        this.host.activeWindow=null;
        if(!this.host.disposed){const stage=[...this.host.windows.values()].find(window=>window.kind==='stage'&&!window.webContents.isDestroyed());if(stage)this.host.activate(stage);}
      }
    });
    queueMicrotask(()=>this.host.appEvents.emit('browser-window-created',{},this));
  }
  loadURL(...args){return this.webContents.loadURL(...args);}
  loadFile(...args){return this.webContents.loadFile(...args);}
  setTitle(title){return native.setTitle.call(this,companionBranding(title));}
  show(){this.host.activate(this);}
  showInactive(){if(this.embedded)this.host.activate(this);else if(this.host.area.visible&&!this.host.disposed&&!this.host.qa)native.showInactive.call(this);}
  hide(){if(this.embedded){this.view.setVisible(false);this.host.notifyLifecycle(this);}else native.hide.call(this);}
  focus(){if(!this.host.canFocus(this))return;if(this.embedded){const root=this.host.getWindow();if(!this.host.qa)root.focus();this.webContents.focus();this.host.notifyLifecycle(this);}else native.focus.call(this);}
  isFocused(){return this.embedded?this.host.activeWindow===this&&this.host.area.visible&&(this.host.qa||this.host.getWindow().isFocused()):native.isFocused.call(this);}
  isMinimized(){return this.embedded?this.host.getWindow().isMinimized():native.isMinimized.call(this);}
  isVisible(){return this.embedded?this.view.getVisible():native.isVisible.call(this);}
  getBounds(){
    if(!this.embedded)return native.getBounds.call(this);
    const host=this.host.getWindow().getContentBounds(),area=this.host.area;
    return {x:host.x+(area.x||0),y:host.y+(area.y||0),width:area.width||450,height:area.height||600};
  }
  getContentBounds(){return this.embedded?this.getBounds():native.getContentBounds.call(this);}
  setBounds(...args){if(!this.embedded)return native.setBounds.apply(this,args);}
  setSize(...args){if(!this.embedded)return native.setSize.apply(this,args);}
  setPosition(...args){if(!this.embedded)return native.setPosition.apply(this,args);}
  getSize(){const bounds=this.getBounds();return [bounds.width,bounds.height];}
  getContentSize(){const bounds=this.getContentBounds();return [bounds.width,bounds.height];}
  getPosition(){const bounds=this.getBounds();return [bounds.x,bounds.y];}
  static getAllWindows(){return [...context().windows.values()].filter(window=>!window.isDestroyed());}
  static fromId(id){return context().windows.get(id)||null;}
  static fromWebContents(contents){return this.getAllWindows().find(window=>window.webContents===contents)||null;}
  static getFocusedWindow(){return this.getAllWindows().find(window=>window.isFocused())||null;}
}

export const session=new Proxy(real.session,{get:(target,key)=>key==='defaultSession'?context().session:bind(target,key)});
export const Menu=new Proxy(real.Menu,{get:(target,key)=>key==='setApplicationMenu'?()=>{}:bind(target,key)});
export const globalShortcut=host.shortcutScope.api;
export const ipcMain=host.ipcScope.api;
export const powerMonitor=host.powerScope.api;
export const screen=host.screenScope.api;
export class Tray extends real.Tray {
  constructor(...args){super(context().brandIcon||args[0],...args.slice(1));context().trays.add(this);}
  setToolTip(text){return super.setToolTip(companionBranding(text));}
}
export const {Notification,desktopCapturer,nativeImage,shell,systemPreferences,dialog,webContents,ipcRenderer,contextBridge,webFrame,webUtils}=real;
export default {...real,app,BrowserWindow,session,Menu,Tray,globalShortcut,ipcMain,powerMonitor,screen};
