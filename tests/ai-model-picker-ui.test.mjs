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
import {WorkbenchError} from '../framework/contracts.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron'),directory=process.env.MODEL_PICKER_TEST_DIR;
  app.setPath('userData',join(directory,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  let unavailable=false,catalogCalls=0,inferences=0;
  const backend=await createWorkbench({dataDir:join(directory,'data'),aiOptions:{
    modelCatalog:async()=>{catalogCalls++;if(unavailable)throw new WorkbenchError(503,'模型列表暂不可用');return [{id:'gpt-alpha',label:'GPT Alpha'},{id:'gpt-beta',label:'GPT Beta'}];},
    codexRunner:async()=>{inferences++;throw new Error('选择模型不应发起推理');}
  }});
  const api=async(path,body,method=body===undefined?'GET':'POST')=>{const response=await fetch(backend.url+path,{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();};
  await api('/api/ai/config',{provider:'codex',model:'gpt-alpha',enabled:true},'PUT');await api('/api/modules/drawing/enable',{});
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}}),errors=[];
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(label,source)=>{const end=Date.now()+15000;while(Date.now()<end){if(await js(`Boolean(${source})`))return;await pause(40);}throw new Error(label+'超时 '+errors.join('\n'));};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const set=(selector,value)=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const screenshot=async name=>{if(process.env.MODEL_PICKER_OUTPUT){mkdirSync(process.env.MODEL_PICKER_OUTPUT,{recursive:true});await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');writeFileSync(join(process.env.MODEL_PICKER_OUTPUT,name),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());}};
  const panel='.instance-panel:not([hidden]) ',model=panel+'#drawing-ai-model';
  try{
    await window.loadURL(backend.url+'#/settings');await wait('全局表单',`document.querySelector('#ai-model')`);
    assert.equal(await js(`document.querySelector('#ai-model').tagName`),'SELECT','桥接模型只能选择');
    await wait('GPT 目录',`document.querySelector('#ai-model option[value="gpt-beta"]')`);
    await set('#ai-model','gpt-beta');await click('#shared-ai-form [type="submit"]');await wait('全局保存',`document.querySelector('#ai-feedback')?.textContent==='共用连接已保存。'`);
    assert.equal((await api('/api/ai/config')).model,'gpt-beta');
    await js(`location.hash='/module/drawing';void 0`);await wait('模块入口',`document.querySelector('${panel}[data-module-ai-control]')`);
    await pause(150);await js(`document.querySelector('[data-module-tour]:popover-open [data-tour-skip]')?.click();void 0`);
    await click(panel+'[data-module-ai-control]');await wait('模块表单',`document.querySelector('${model}')`);
    const instance=await js(`document.querySelector('.instance-panel:not([hidden])').dataset.instanceId`),path='/instances/'+instance+'/api/ai/modules/drawing/config';
    await set(panel+'#drawing-ai-mode','module');await wait('模块 GPT 目录',`document.querySelector('${model} option[value="gpt-alpha"]')`);
    assert.equal(await js(`document.querySelector('${model}').value`),'');assert.match(await js(`document.querySelector('${model} option[value=""]').textContent`),/跟随全局.*gpt-beta/);
    await set(model,'gpt-alpha');await click(panel+'[data-ai-editor] [type="submit"]');await wait('模块保存',`document.querySelector('${panel}#drawing-ai-feedback')?.textContent.startsWith('模块接入已保存')`);
    assert.equal((await api(path)).effective.model,'gpt-alpha');assert.equal((await api('/api/ai/config')).model,'gpt-beta');
    await js(`document.querySelector('${model}').focus();void 0`);assert.equal(await js(`document.activeElement.id`),'drawing-ai-model');
    await screenshot('module-gpt-picker.png');
    await set(model,'');await click(panel+'[data-ai-editor] [type="submit"]');await wait('恢复继承',`document.querySelector('${panel}#drawing-ai-feedback')?.textContent.startsWith('模块接入已保存')&&!document.querySelector('${panel}[data-ai-editor] [type="submit"]').disabled`);
    assert.equal((await api(path)).effective.model,'gpt-beta');
    await set(panel+'#drawing-ai-provider','openai');assert.equal(await js(`document.querySelector('${model}').tagName`),'INPUT');await set(model,'local-model');
    await set(panel+'#drawing-ai-provider','codex');assert.equal(await js(`document.querySelector('${model}').value`),'local-model','切换方式保留尚未重新选择的旧值');
    assert.equal(await js(`document.querySelector('${model} option[value="local-model"]').disabled`),true);
    await click(panel+'[data-ai-close]');await api(path,{mode:'module',connection:{model:'gpt-legacy'}},'PUT');assert.equal((await api(path)).connection.model,'gpt-legacy');
    // A fresh page drops only this test's unsaved browser draft; persisted older values survive catalog failure.
    unavailable=true;await new Promise(resolve=>{window.webContents.once('did-finish-load',resolve);window.reload();});await wait('重载模块',`document.querySelector('${panel}[data-module-ai-control]')`);
    await click(panel+'[data-module-ai-control]');await wait('目录错误',`document.querySelector('${panel}[data-model-retry]:not([hidden])')`);
    assert.equal(await js(`document.querySelector('${model}').value`),'gpt-legacy');await screenshot('model-catalog-error.png');
    unavailable=false;await click(panel+'[data-model-retry]');await wait('重试恢复',`document.querySelector('${model} option[value="gpt-beta"]')`);
    assert.equal(await js(`document.querySelector('${model}').value`),'gpt-legacy');assert.equal(inferences,0);assert.ok(catalogCalls>=3);assert.deepEqual(errors,[]);
    console.log('MODEL_PICKER_RESULT global,module,inheritance,persistence,keyboard,provider-switch,legacy,error,retry,no-inference');
  }finally{window.destroy();await backend.close();}
}
if(process.argv.includes('--models-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('GPT 模型选择：真实 Electron 全局与模块保存、继承、错误重试及旧配置保留',{skip:!electron,timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'workbench-model-picker-')),env={...process.env,MODEL_PICKER_TEST_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--models-electron'],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,output);assert.match(output,/MODEL_PICKER_RESULT/);
});
