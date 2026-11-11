import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createWorkbench} from '../framework/server.mjs';
const electron=process.env.AI_FUTURE_ELECTRON||'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';

async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron'),directory=process.env.UX_NAVIGATION_DIR;
  app.setPath('userData',join(directory,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const backend=await createWorkbench({dataDir:join(directory,'data')});
  const api=async(path,body={},method='POST')=>{const response=await fetch(backend.url+path,{method,headers:{'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;};
  await api('/api/modules/drawing/enable');await api('/api/modules/comfyui/enable');
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const current='.instance-panel:not([hidden])',click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const wait=async source=>{for(let i=0;i<150;i++){if(await js(`Boolean(${source})`))return;await pause(40);}throw new Error('等待失败：'+source+'\n'+await js('document.body.innerText'));};
  const skip=async()=>{await pause(150);await js("document.querySelector('[data-module-tour]:popover-open [data-tour-skip]')?.click();void 0");};
  try{
    await window.loadURL(backend.url+'#/module/drawing');await wait(`document.querySelector('${current} #tab-workflows')`);await skip();
    await click(current+' #tab-workflows');await wait(`document.querySelector('${current} #workflow-file')`);
    await js(`(()=>{const original=window.fetch;window.fetch=(input,options)=>new URL(typeof input==='string'?input:input.url,location.href).pathname.endsWith('/api/modules/drawing/workflows/inspect')?Promise.resolve(Response.json({available:true,valid:false,nodeCount:1,missingModels:[{nodeId:'1',classType:'CheckpointLoaderSimple',input:'ckpt_name',value:'验证缺失模型.safetensors',detail:'模型不在可选列表中'}]})):original(input,options);const input=document.querySelector('${current} #workflow-file'),transfer=new DataTransfer();transfer.items.add(new File(['{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"验证缺失模型.safetensors"}}}'],'待导入工作流.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('${current} [data-inspection-resource]')`);
    const drawingId=await js(`document.querySelector('${current}').dataset.instanceId`);
    await api(`/instances/${drawingId}/api/modules/drawing/config`,{values:{comfyPath:'C:\\Selected Comfy',serviceUrl:'http://127.0.0.1:8191'}},'PUT');
    const {instance:otherLauncher}=await api('/api/instances',{moduleId:'comfyui',name:'其他环境'});
    await api(`/instances/${otherLauncher.id}/api/modules/drawing/config`,{values:{comfyPath:'C:\\Other Comfy',serviceUrl:'http://127.0.0.1:8192'}},'PUT');
    await click(current+' [data-inspection-resource]');await wait(`document.querySelector('${current} #model-filename')`);await skip();
    assert.equal(await js(`document.querySelector('${current} #model-filename').value`),'验证缺失模型.safetensors');
    assert.match(await js(`document.querySelector('${current} #manager-local-scope').textContent`),/Selected Comfy/,'资源下载必须使用来源绘图实例的环境');
    const launcherId=await js(`document.querySelector('${current}').dataset.instanceId`);assert.notEqual(launcherId,otherLauncher.id);
    await click(current+' #manager-drawing');await wait(`location.hash==='#/module/drawing'`);
    await wait(`document.querySelector('${current} #inspection-recheck')`);
    assert.equal(await js(`document.querySelector('${current}').dataset.instanceId`),drawingId);
    assert.match(await js(`document.querySelector('${current} #workflow-inspection').textContent`),/待导入工作流|验证缺失模型/);
    await click(current+' #tab-overview');await wait(`document.querySelector('${current} #open-launcher')`);
    await click(current+' #open-launcher');await wait(`location.hash==='#/module/comfyui'&&document.querySelector('${current} #tab-runtime')`);
    assert.equal(await js(`document.querySelector('${current}').dataset.instanceId`),launcherId);
    await click(current+' #tab-runtime');await wait(`document.querySelector('${current} #runtime-drawing')`);
    await click(current+' #runtime-drawing');await wait(`location.hash==='#/module/drawing'&&document.querySelector('${current} #open-launcher')`);
    assert.equal(await js(`document.querySelector('${current}').dataset.instanceId`),drawingId);
    const otherState=await api(`/instances/${otherLauncher.id}/api/state`,{},'GET');
    assert.equal(otherState.modules.find(module=>module.id==='drawing').config.comfyPath,'C:\\Other Comfy');
    console.log('UX_NAVIGATION_OK pending workflow inspection retained');
  }finally{window.destroy();await backend.close();}
}
if(process.argv.includes('--ux-navigation-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('资源准备往返保留真实 app 中待导入工作流与检查结果',{skip:!existsSync(electron),timeout:45000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ux-navigation-')),env={...process.env,UX_NAVIGATION_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--ux-navigation-electron'],{env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/UX_NAVIGATION_OK/);
});
