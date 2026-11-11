import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const electron=process.env.AI_FUTURE_ELECTRON||'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
async function run() {
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');app.setPath('userData',join(process.env.COMPLETION_UI_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const root=resolve(fileURLToPath(new URL('../public-workbench',import.meta.url)));
  const server=createServer(async(req,res)=>{try{const target=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+sep))throw new Error('path');res.setHeader('content-type',extname(target)==='.js'?'text/javascript':extname(target)==='.css'?'text/css':'text/html');res.end(await readFile(target));}catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source);const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  try {
    window.webContents.session.webRequest.onBeforeRequest({urls:['http://127.0.0.1:'+server.address().port+'/app.js']},(_details,callback)=>callback({cancel:true}));
    await window.loadURL('http://127.0.0.1:'+server.address().port+'/index.html');
    await js(`(async()=>{
      document.body.innerHTML='<main style="padding:28px;max-width:1000px;margin:auto"><section class="panel glass" id="completion-root"></section></main>';
      const {mountWorkflowCompletion}=await import('/drawing-completion-view.js');window.qaController=new AbortController();window.qaCalls=[];window.qaReports=[];
      const dependency={id:'dep',kind:'model',filename:'base.safetensors',category:'checkpoints',status:'missing',service:{status:'missing'},local:{status:'missing',identity:'unverified',files:[]},issues:[],candidates:[]};
      window.qaReport={id:'report',name:'工作流',status:'completed',scope:'local',comfyPath:'C:\\ComfyUI',dependencies:[dependency],warnings:[],budget:{requests:0,hashBytes:0},ai:{calls:0}};
      window.qaCandidate={id:'candidate',platform:'huggingface',filename:'base.safetensors',version:'a'.repeat(40),source:'https://huggingface.co/author/model',url:'https://huggingface.co/author/model/resolve/main/base.safetensors',sha256:'b'.repeat(64),license:'apache-2.0',storage:{downloadBytes:1024,incrementalBytes:1024,temporaryPeakBytes:2048,destination:'C:\\ComfyUI\\models\\checkpoints\\base.safetensors'}};
      window.qaCtx={signal:qaController.signal,ui:{},notify:message=>{throw new Error(message);},action:async(button,job)=>{button.disabled=true;try{return await job();}finally{button.disabled=false;}},navigateModule:async(...args)=>qaCalls.push({navigation:args}),api:async(path,options={})=>{qaCalls.push({path,...options});if(path.endsWith('/search')){qaReport.dependencies[0].candidates=[qaCandidate];qaReport.dependencies[0].status='candidate';return structuredClone(qaReport);}if(path.endsWith('/downloads'))return {tasks:[{id:'download-one',status:'queued'}]};if(path.endsWith('/copy'))return {document:{},name:'副本',path:'C:\\data\\copy.json'};return structuredClone(qaReport);}};
      await mountWorkflowCompletion(document.querySelector('#completion-root'),qaCtx,{name:'fixture',document:{'1':{class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'base.safetensors'}}}});
    })()`);
    assert.equal(await js("qaCalls.filter(call=>call.method==='POST').length"),1);
    await js("document.querySelector('[data-completion-search]').click();void 0");
    await new Promise(done=>setTimeout(done,30));
    assert.equal(await js("document.querySelector('[data-completion-candidate]').checked"),false);
    assert.equal(await js("qaCalls.filter(call=>call.path.endsWith('/downloads')).length"),0);
    await js("document.querySelector('[data-completion-candidate]').focus();document.querySelector('[data-completion-candidate]').click();void 0");
    assert.equal(await js("document.activeElement.hasAttribute('data-completion-candidate')"),true,'选择后保留键盘焦点');
    await js("document.querySelector('[data-completion-download]').click();void 0");await new Promise(done=>setTimeout(done,20));
    const submitted=await js("qaCalls.find(call=>call.path.endsWith('/downloads')).body");assert.equal(submitted.selections.length,1);assert.equal(submitted.selections[0].candidateId,'candidate');
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    const output=process.env.COMPLETION_UI_OUTPUT;if(output){mkdirSync(output,{recursive:true});const paint=async()=>{await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await new Promise(done=>setTimeout(done,100));};await paint();writeFileSync(join(output,'drawing-completion-light.png'),(await window.webContents.capturePage()).toPNG());await js("document.documentElement.dataset.theme='dark';void 0");await paint();writeFileSync(join(output,'drawing-completion-dark.png'),(await window.webContents.capturePage()).toPNG());}
    await js("qaController.abort();void 0");assert.deepEqual(errors,[]);console.log('DRAWING_COMPLETION_UI_PASS fixture candidates and download submission only');
  } finally {window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));app.quit();}
}
if(process.env.COMPLETION_UI_CHILD==='1')run().catch(error=>{console.error(error);process.exit(1);});
else test('绘图补全在真实DOM中显式查询、勾选和下载，保持焦点与桌面布局',{skip:!existsSync(electron),timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'completion-ui-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await new Promise((done,reject)=>{const env={...process.env,COMPLETION_UI_CHILD:'1',COMPLETION_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(import.meta.url)],{env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(new Error(output));},50000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0&&output.includes('DRAWING_COMPLETION_UI_PASS')?done():reject(new Error(output));});});
});
