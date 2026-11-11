require('./process-stdio.cjs').installStdioGuards();
const { app, BrowserWindow, Menu, dialog, shell,ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { ProcessLogWindows } = require('./process-log-window.cjs');
const {handleResourceWindowOpen,isWorkbenchClipboardWrite}=require('./external-resources.cjs');
const {createPathDialogs}=require('./path-picker.cjs');
const {installWorkbenchDownloads}=require('./downloads.cjs');
const {CompanionHost}=require('./companion-host.cjs');
const {WorkbenchImmersion}=require('./workbench-immersion.cjs');

const root = path.resolve(__dirname, '..');
const qaSuite = process.env.AI_FUTURE_WORKBENCH_QA_SUITE;
if(qaSuite==='companion'){
  app.whenReady().then(()=>import(pathToFileURL(path.join(root,'tools/qa-companion.mjs')).href)).catch(error=>{console.error(error);app.exit(1);});
  return;
}
if (['drawing','drawing-manager','launcher-split','process-log'].includes(qaSuite)) {
  import(pathToFileURL(path.join(root,'tools',`qa-${qaSuite}.mjs`)).href).catch(error => { console.error(error); app.exit(1); });
  return;
}
const qa = process.env.AI_FUTURE_WORKBENCH_QA === '1';
const qaDir = process.env.AI_FUTURE_WORKBENCH_QA_DIR || path.join(root,'qa',`workbench-${Date.now()}`);
const isolatedProfile = process.env.AI_FUTURE_WORKBENCH_PROFILE_DIR;
app.setName('小念的创作笔记');
app.setPath('userData', qa ? path.join(qaDir,'profile') : isolatedProfile ? path.resolve(isolatedProfile) : path.join(app.getPath('appData'),'AI-Future-Workbench'));
if (!qa && !app.requestSingleInstanceLock()) { app.quit(); return; }
if (qa) { app.commandLine.appendSwitch('disable-background-timer-throttling'); app.commandLine.appendSwitch('disable-renderer-backgrounding'); }
let window;
const pathDialogs=createPathDialogs({dialog,getWindow:()=>window});
let runtime;
let logWindows;
let companionHost;
let immersion;
let closing = false;
let exitPending = false;
let reloadPending = false;
let qaCloseDraft;
async function runDraftHook(name) {
  if (!window || window.isDestroyed()) return;
  let timer;
  try {
    await Promise.race([
      window.webContents.executeJavaScript(`window.${name} ? window.${name}() : Promise.resolve()`),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('草稿保存超时，请保留窗口后重试。')),8500);}),
    ]);
  } finally { clearTimeout(timer); }
}
async function quitWithDrafts() {
  if (exitPending || closing) return;
  exitPending=true;
  try {
    await runDraftHook('__workbenchPrepareExit');
    if(qa && qaCloseDraft) {
      const saved=JSON.parse(fs.readFileSync(path.join(qaDir,'data/card-studio/work/ui-drafts.json'),'utf8'));
      if(!Object.values(saved.entries).some(entry=>entry.value?.text===qaCloseDraft))throw new Error('窗口关闭前的聊天草稿未落盘。');
      qaWrite('lifecycle-result.json',{ok:true,nativeWindowClose:true,pendingDraftPersisted:true,at:new Date().toISOString()});
    }
    closing=true;
    logWindows?.closeAll();
    if(runtime) await runtime.close();
    runtime=undefined; app.quit();
  } catch(error) {
    closing=false;
    await runDraftHook('__workbenchCancelExit').catch(()=>{});
    if(qa){qaWrite('lifecycle-error.txt',error.stack || error.message);app.exit(1);}
    else dialog.showErrorBox('草稿尚未保存',`${error.message}\n\n工作台仍保持打开，请保存或复制当前输入后重试。`);
  } finally {exitPending=false;}
}
async function reloadWithDrafts() {
  if(reloadPending || closing || exitPending) return;
  reloadPending=true;
  try {await runDraftHook('__workbenchPrepareExit');window?.webContents.reload();}
  catch(error){await runDraftHook('__workbenchCancelExit').catch(()=>{});dialog.showErrorBox('暂时不能重新加载',`${error.message}\n\n已保留当前页面。`);}
  finally {reloadPending=false;}
}
function showWindow() { if (!window) return; if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
app.on('second-instance',showWindow);
function qaWrite(name,value) {
  fs.mkdirSync(qaDir,{recursive:true});
  fs.writeFileSync(path.join(qaDir,name), typeof value === 'string' ? value : JSON.stringify(value,null,2),'utf8');
}
app.whenReady().then(async () => {
  app.setAppUserModelId('ai.future.workbench');
  const { createWorkbench } = await import(pathToFileURL(path.join(root,'framework/server.mjs')).href);
  logWindows = new ProcessLogWindows({BrowserWindow, getBaseURL:() => runtime.url});
  const createCompanionHost=instanceId=>{
    const host=new CompanionHost({instanceId,getWindow:()=>window,qa,
      onContents:(contents,view)=>immersion?.attach(contents,{moduleId:'companion',isEligibleSource:()=>!host.disposed&&view.embedded&&host.activeWindow===view&&host.area.visible}),
      onError:error=>{fs.appendFileSync(path.join(app.getPath('userData'),'companion-errors.log'),String(error)+'\n','utf8');},
    });
    return host;
  };
  companionHost=createCompanionHost(null);
  runtime = await createWorkbench({
    dataDir:qa ? path.join(qaDir,'data') : path.join(app.getPath('userData'),'data'),port:0,
    drawingOptions:{downloadsDirectory:app.getPath('downloads')},
    companionOptions:{host:companionHost},
    instanceOptionsFactory:async({instanceId,moduleId})=>moduleId==='companion'?{companionOptions:{host:createCompanionHost(instanceId)}}:{},
    openArtifactDirectory:async directory => {const error=await shell.openPath(directory);if(error)throw new Error(error);},
    openComfyUI:async url => {const target=new URL(url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('ComfyUI 地址无效。');await shell.openExternal(target.href);},
    openMinecraftAuth:async () => {await shell.openExternal('https://www.microsoft.com/link');},
    openProcessLog:source => {logWindows.open(source);},
    chooseDirectory:pathDialogs.chooseDirectory,
    choosePath:pathDialogs.choosePath,
  });
  window = new BrowserWindow({
    width:1420,height:960,minWidth:780,minHeight:640,show:!qa,title:'小念的创作笔记',icon:path.join(root,'public-workbench/app.ico'),backgroundColor:'#f3eaf3',autoHideMenuBar:true,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:path.join(__dirname,'workbench-preload.cjs'),backgroundThrottling:!qa,offscreen:qa,autoplayPolicy:'user-gesture-required'},
  });
  const releaseDownloads=installWorkbenchDownloads({session:window.webContents.session,getBaseURL:()=>runtime.url,getDownloadsPath:()=>app.getPath('downloads')});
  app.once('will-quit',releaseDownloads);
  immersion=new WorkbenchImmersion({getWindow:()=>window,ipcMain});immersion.attach(window.webContents);
  window.webContents.setWindowOpenHandler(details => handleResourceWindowOpen(details,{baseURL:runtime.url,openExternal:url=>shell.openExternal(url),openLog:target=>logWindows.open(target),onError:error=>dialog.showErrorBox('无法打开资源页面',error.message)}));
  window.webContents.on('will-navigate',(event,target) => { if(new URL(target).origin !== new URL(runtime.url).origin) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((contents,permission,callback) => callback(!!contents && !contents.isDestroyed() && isWorkbenchClipboardWrite(runtime.url,contents.getURL(),permission)));
  window.webContents.on('before-input-event',(event,input)=>{
    if(input.type==='keyDown' && (input.key==='F5' || (input.control && input.key.toLowerCase()==='r'))) {event.preventDefault();void reloadWithDrafts();}
  });
  window.on('close',event=>{if(!closing){event.preventDefault();void quitWithDrafts();}});
  window.on('closed', () => { window = undefined; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'工作台',submenu:[{label:'显示工作台',click:showWindow},{type:'separator'},{label:'退出',role:'quit'}]},
    {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},{role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
    {label:'查看',submenu:[{label:'重新加载',accelerator:'CmdOrCtrl+R',click:reloadWithDrafts},{role:'resetZoom',label:'实际大小'},{role:'zoomIn',label:'放大'},{role:'zoomOut',label:'缩小'}]},
  ]));
  const initialRoute=!qa&&process.env.AI_FUTURE_WORKBENCH_INITIAL_ROUTE==='companion'?'#/module/companion':'';
  await window.loadURL(runtime.url+initialRoute);
  if (qa) {
    const { runQa } = await import(pathToFileURL(path.join(root,'tools/qa-workbench.mjs')).href);
    await runQa({window,runtime,qaDir,dialog});
    qaWrite('complete.json',{ok:true,at:new Date().toISOString()});
    qaCloseDraft='窗口关闭前的新输入 '+Date.now();
    const closeReadiness=await window.webContents.executeJavaScript(`(async()=>{
      const wait=async predicate=>{const end=Date.now()+20000;while(!predicate()){if(Date.now()>end)throw new Error('关闭验证页面载入超时');await new Promise(resolve=>setTimeout(resolve,50));}};
      location.hash='/module/cards';
      await wait(()=>!document.querySelector('#cards-content').hidden&&Boolean(document.querySelector('[data-edit-card]')));
      document.querySelector('[data-edit-card]').click();
      await wait(()=>Boolean(document.querySelector('#card-studio-frame')?.contentWindow?.document.querySelector('#chat-input'))&&!document.querySelector('#card-editor').hidden);
      const frame=document.querySelector('#card-studio-frame').contentWindow;
      const inputInitiallyDisabled=frame.document.querySelector('#chat-input').disabled;
      await wait(()=>frame.document.querySelector('#chat-input')?.disabled===false);
      frame.document.querySelector('#chat-input').value=${JSON.stringify(qaCloseDraft)};
      frame.document.querySelector('#chat-input').dispatchEvent(new frame.Event('input',{bubbles:true}));
      return {inputInitiallyDisabled,inputEnabledBeforeTyping:!frame.document.querySelector('#chat-input').disabled};
    })()`);
    qaWrite('lifecycle-readiness.json',closeReadiness);
    window.close();
  } else {
    showWindow();
    fs.writeFileSync(path.join(app.getPath('userData'),'last-start.json'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,url:runtime.url,appVersion:app.getVersion()},null,2),'utf8');
  }
}).catch(error => {
  if(qa) qaWrite('error.txt',error.stack || String(error));
  else {
    try { fs.mkdirSync(app.getPath('userData'),{recursive:true}); fs.writeFileSync(path.join(app.getPath('userData'),'startup-error.log'),error.stack || String(error),'utf8'); } catch {}
    dialog.showErrorBox('小念的创作笔记无法启动',`${error.message}\n\n启动记录保存在应用数据目录的 startup-error.log。`);
  }
  app.exit(1);
});
app.on('window-all-closed',() => app.quit());
app.on('before-quit',event => {
  if(!runtime || closing) return;
  event.preventDefault(); void quitWithDrafts();
});
