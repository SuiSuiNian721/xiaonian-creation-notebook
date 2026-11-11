import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron'),directory=process.env.SHELL_RECOVERY_TEST_DIR;
  app.setPath('userData',join(directory,'electron'));app.on('window-all-closed',()=>{});await app.whenReady();
  const backend=await createWorkbench({dataDir:join(directory,'data')});
  const api=async(path,body)=>{const response=await fetch(backend.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();};
  await api('/api/modules/voice/enable',{});await api('/api/modules/companion-lite/enable',{});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const errors=[],checks=[],js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),current='.instance-panel:not([hidden])';
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const wait=async(source)=>{const deadline=Date.now()+15000;while(Date.now()<deadline){if(await js(source))return;await pause(40);}throw new Error('等待超时 '+source);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const skipTour=async()=>{await pause(100);await js("document.querySelector('[data-module-tour]:popover-open [data-tour-skip]')?.click();void 0");};
  const check=async(name,operation)=>{try{await operation();checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:error.message});}};
  const shot=async name=>{if(!process.env.SHELL_RECOVERY_OUTPUT)return;mkdirSync(process.env.SHELL_RECOVERY_OUTPUT,{recursive:true});await pause(200);writeFileSync(join(process.env.SHELL_RECOVERY_OUTPUT,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  try{
    await window.loadURL(backend.url);await wait("document.querySelector('h1')?.textContent==='我的工作台'");
    await js(`(()=>{const original=window.fetch;window.__restoreFetch=()=>window.fetch=original;window.fetch=(url,options)=>String(url)==='/api/instances'?original(url,options).then(response=>new Promise(resolve=>{window.__releaseInstances=()=>resolve(response)})):original(url,options);location.hash='/module/companion';})()`);
    await wait('Boolean(window.__releaseInstances)');await js("location.hash='/home';void 0");await wait("document.querySelector('h1')?.textContent==='我的工作台'");
    await js('window.__restoreFetch();window.__releaseInstances();void 0');await pause(350);
    await check('迟到的模块读取不能覆盖首页',async()=>{assert.equal(await js("document.querySelector('#instance-content').hidden"),true);assert.equal(await js("document.querySelectorAll('[data-module-tour]:popover-open').length"),0);});
    await js("location.hash='/module/voice';void 0");await wait(`Boolean(document.querySelector('${current} #studio-text'))`);await skipTour();
    const first=await js(`document.querySelector('${current}').dataset.instanceId`);
    await js(`(()=>{const panel=document.querySelector('${current}');panel.querySelector('#studio-text').value='实例 A 草稿';const frame=document.createElement('iframe');frame.dataset.shellTestFrame='';panel.append(frame);frame.contentWindow.__testState='iframe 状态应保留';window.__testFrame=frame;})()`);
    await click('[data-instance-new]');await wait(`document.querySelector('${current}')?.dataset.instanceId!=='${first}'&&Boolean(document.querySelector('${current} #studio-text'))`);await skipTour();
    const second=await js(`document.querySelector('${current}').dataset.instanceId`);
    await check('当前实例标签只关联自己的表单',async()=>{const bad=await js(`(()=>{const panel=document.querySelector('${current}');return [...panel.querySelectorAll('label[for]')].filter(label=>!label.control||!panel.contains(label.control)).map(label=>label.htmlFor);})()`);assert.deepEqual(bad,[]);assert.equal(await js("document.querySelectorAll('#studio-text').length"),1);});
    await js(`(()=>{const original=window.fetch;window.__restoreCloseFetch=()=>window.fetch=original;window.fetch=(url,options)=>String(url)==='/api/instances/${second}'&&options?.method==='PATCH'?original(url,options).then(response=>new Promise(resolve=>{window.__releaseClose=()=>resolve(response)})):original(url,options);})()`);
    await click(`[data-instance-close="${second}"]`);await wait('Boolean(window.__releaseClose)');await js("location.hash='/home';void 0");await wait("document.querySelector('h1')?.textContent==='我的工作台'");
    await js('window.__restoreCloseFetch();window.__releaseClose();void 0');await pause(250);
    await check('离开后迟到的关闭标签不能重新打开模块',async()=>assert.equal(await js("document.querySelector('#instance-content').hidden"),true));
    await js("location.hash='/module/voice';void 0");await wait(`Boolean(document.querySelector('${current} #studio-text'))`);
    await click(`[data-instance-select="${first}"]`);await wait(`document.querySelector('${current}')?.dataset.instanceId==='${first}'`);
    await check('切回实例保留表单与 iframe 运行状态',async()=>{assert.equal(await js(`document.querySelector('${current} #studio-text').value`),'实例 A 草稿');assert.equal(await js("window.__testFrame.contentWindow?.__testState"),'iframe 状态应保留');});
    await click('[data-instance-manage]');await wait(`Boolean(document.querySelector('[data-record="${first}"] [data-stop]'))`);await click(`[data-record="${first}"] [data-stop]`);
    await wait(`document.querySelector('[data-record="${first}"]')?.textContent.includes('已停止')&&document.querySelector('[data-record="${first}"] [data-stop]')?.disabled`);await js("document.querySelector('.instance-dialog').close();void 0");
    await check('停止当前实例有状态和直接恢复操作',async()=>{assert.equal((await api('/api/instances/'+first)).instance.status,'stopped');assert.ok(await js("document.querySelector('[data-instance-resume]')?.textContent.includes('打开实例')"));});await shot('instance-stopped');
    await js("location.hash='/home';void 0");await wait("document.querySelector('h1')?.textContent==='我的工作台'");await js("location.hash='/module/voice';void 0");await wait("document.querySelector('#main-content').getAttribute('aria-busy')==='false'");
    await check('返回模块不会自动重启刚停止的实例',async()=>{assert.equal((await api('/api/instances/'+first)).instance.status,'stopped');assert.ok(await js("Boolean(document.querySelector('[data-instance-resume]'))"));await click('[data-instance-resume]');await wait(`document.querySelector('${current}')?.dataset.instanceId==='${first}'`);assert.equal((await api('/api/instances/'+first)).instance.status,'running');});
    await js("location.hash='/settings';void 0");await wait("Boolean(document.querySelector('[data-theme-choice]'))");await click('#theme-toggle');await pause(300);
    await check('顶栏切换后同步设置主题选择',async()=>{assert.equal(await js("document.querySelector('[data-theme-choice][aria-pressed=true]').dataset.themeChoice"),await js('document.documentElement.dataset.theme'));});await shot('theme-synchronized');
    assert.deepEqual(errors,[]);console.log('SHELL_RECOVERY_RESULT '+JSON.stringify(checks));assert.equal(checks.filter(item=>!item.ok).length,0,JSON.stringify(checks.filter(item=>!item.ok)));
  }finally{window.destroy();await backend.close();}
}
if(process.argv.includes('--shell-recovery-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('工作台导航、实例表单、停止恢复和主题状态回归',{skip:!electron,timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'workbench-shell-recovery-')),env={...process.env,SHELL_RECOVERY_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--shell-recovery-electron'],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);assert.match(output,/SHELL_RECOVERY_RESULT/);
});
