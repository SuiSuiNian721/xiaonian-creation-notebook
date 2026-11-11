import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const script=fileURLToPath(import.meta.url),root=resolve(dirname(script),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function browser(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.setPath('userData',process.env.COMPUTE_RECOVERY_PROFILE);app.disableHardwareAcceleration();app.on('window-all-closed',()=>{});await app.whenReady();
  const publicRoot=join(root,'public-workbench'),server=createServer(async(req,res)=>{
    try{
      if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/drawing.css"></head><body><main id="root" style="padding:24px"></main></body></html>');return;}
      const path=resolve(publicRoot,'.'+new URL(req.url,'http://fixture').pathname);if(!path.startsWith(publicRoot+sep))throw Error('path');
      res.setHeader('content-type',extname(path)==='.js'?'text/javascript':extname(path)==='.css'?'text/css':'application/octet-stream');res.end(await readFile(path));
    }catch{res.writeHead(404);res.end();}
  });await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}}),errors=[];
  const js=async source=>{
    const result=await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (0,eval)(${JSON.stringify(source)})};}catch(error){return {ok:false,error:error.stack||String(error)};}})()`);
    if(!result.ok)throw Error(result.error+'\nRenderer source: '+source+'\n'+await window.webContents.executeJavaScript("document.querySelector('#root').innerText"));
    return result.value;
  },wait=async source=>{const until=Date.now()+5000;while(Date.now()<until){if(await js(source))return;await new Promise(done=>setTimeout(done,25));}throw Error('DOM wait: '+source);};
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`),submit=()=>js("document.querySelector('#drawing-generate-form').requestSubmit();void 0");
  const screenshot=async name=>{if(process.env.COMPUTE_RECOVERY_OUTPUT){await js('document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))))');await new Promise(done=>setTimeout(done,150));await mkdir(process.env.COMPUTE_RECOVERY_OUTPUT,{recursive:true});await writeFile(join(process.env.COMPUTE_RECOVERY_OUTPUT,name),(await window.webContents.capturePage()).toPNG());}};
  try{
    await window.loadURL('http://127.0.0.1:'+server.address().port);
    await js(`(async()=>{
      const {mount}=await import('/drawing-view.js');window.controller=new AbortController();window.calls=[];window.created=[];window.drafts=new Map();window.ui={moduleTabs:{}};
      const workflows=['workflow-a','workflow-b'].map(id=>({id,name:id,fields:[{key:'1:text',input:'text',label:'text',group:'prompt',type:'text',multiline:true,value:'first prompt'}]}));
      window.state={connection:{connected:true},workflows,jobs:[],defaultPreviewMethod:'none'};
      window.ctx={signal:controller.signal,ui,state:{modules:[],events:[],selectedCharacterId:'original-character'},drafts:{read:(key,fallback)=>drafts.has(key)?structuredClone(drafts.get(key)):fallback,write:(key,value)=>drafts.set(key,structuredClone(value))},notify:()=>{},action:async(button,job)=>{if(button.disabled)return;button.disabled=true;try{return await job();}finally{button.disabled=false;}},api:async(path,options={})=>{
        if(path.endsWith('/state'))return structuredClone(state);if(path.endsWith('/preview-options'))return{perPrompt:true,models:{status:'available',decoders:[]}};
        if(path.includes('/workflows/')){if(path.endsWith('/'+window.holdWorkflow))await new Promise((done,reject)=>{window.releaseWorkflow=done;window.rejectWorkflow=()=>reject(Error('读取工作流失败'));});return structuredClone(workflows.find(item=>path.endsWith('/'+item.id)));}
        if(path.endsWith('/jobs')){const body=structuredClone(options.body);calls.push(body);const old=created.find(item=>item.requestId===body.requestId);if(old){const matches=JSON.stringify(old.values)===JSON.stringify(body.values)&&old.workflowId===body.workflowId&&old.previewMethod===body.previewMethod&&old.characterId===body.characterId;if(!matches)throw Object.assign(Error('参数冲突'),{status:409});return structuredClone(old);}
          const job={...body,id:'job-'+created.length,workflowName:body.workflowId,status:'queued',images:[],createdAt:new Date().toISOString()};created.push(job);state.jobs.push(job);if(window.holdReply)await new Promise(done=>{window.releaseReply=done;});throw Object.assign(Error('响应连接丢失'),{status:503});
        }throw Error('Unexpected API '+path);
      }};window.remount=async()=>{controller.abort();window.controller=new AbortController();ctx.signal=controller.signal;ctx.ui={moduleTabs:{},drawingWorkflow:'workflow-b'};await mount(document.querySelector('#root'),ctx);};await mount(document.querySelector('#root'),ctx);
    })()`);
    await submit();await wait("document.querySelector('#drawing-feedback').textContent.includes('响应连接丢失')");
    assert.match(await js("document.querySelector('#generate-image').textContent"),/核对上次任务/);
    await js("window.holdWorkflow='workflow-b';document.querySelector('#drawing-workflow').value='workflow-b';document.querySelector('#drawing-workflow').dispatchEvent(new Event('change'));void 0");await wait('!!window.releaseWorkflow');
    assert.equal(await js("document.querySelector('#drawing-new-request').disabled"),true,'工作流 B 读取期间，新建也必须禁用');
    assert.equal(await js("document.querySelector('#generate-image').disabled"),true);
    await js("document.querySelector('#drawing-new-request').onclick();document.querySelector('#drawing-generate-form').requestSubmit();void 0");
    assert.equal(await js('calls.length'),1,'提交函数也应拦截加载中的旧工作流');
    await js('window.holdWorkflow=null;releaseWorkflow();void 0');await wait("document.querySelector('#drawing-workflow').value==='workflow-b'&&!document.querySelector('#generate-image').disabled");
    await js("document.querySelector('[data-parameter]').value='changed prompt';document.querySelector('[data-parameter]').dispatchEvent(new Event('input'));document.querySelector('#drawing-preview-method').value='auto';ctx.state.selectedCharacterId='changed-character';void 0");
    await screenshot('drawing-pending-recovery.png');await js('remount()');await submit();
    await wait("document.querySelector('#drawing-feedback').textContent.includes('已核对')");
    const recovered=await js('({calls,created})');assert.equal(recovered.created.length,1);assert.deepEqual(recovered.calls[1],recovered.calls[0]);
    assert.equal(await js("document.querySelector('[data-parameter]').value"),'changed prompt');
    await js('window.holdReply=true;void 0');await submit();await wait('calls.length===3');
    await click('[data-tab=records]');await wait("!document.querySelector('#generate-image')");await click('[data-tab=overview]');await wait("!!document.querySelector('#generate-image')");
    await js('window.holdReply=false;releaseReply();void 0');await wait("!document.querySelector('#generate-image').disabled");
    await click('#drawing-new-request');await wait('calls.length===4');
    const explicit=await js('({calls,created})');assert.equal(explicit.created.length,3);assert.notEqual(explicit.calls[2].requestId,explicit.calls[3].requestId);assert.equal(explicit.calls[3].values['1:text'],'changed prompt');
    await js("window.releaseWorkflow=null;window.holdWorkflow='workflow-a';document.querySelector('#drawing-workflow').value='workflow-a';document.querySelector('#drawing-workflow').dispatchEvent(new Event('change'));void 0");await wait('!!window.releaseWorkflow');
    assert.equal(await js("document.querySelector('#drawing-new-request').disabled"),true);
    await js('window.holdWorkflow=null;rejectWorkflow();void 0');await wait("document.querySelector('#drawing-feedback').textContent.includes('读取工作流失败')");
    assert.equal(await js("document.querySelector('#drawing-workflow').value"),'workflow-b','读取失败时选择与已加载表单恢复一致');
    assert.equal(await js("document.querySelector('#drawing-new-request').disabled"),false);
    await click('#drawing-new-request');await wait('calls.length===5');assert.equal(await js('calls[4].workflowId'),'workflow-b');
    await js("window.releaseWorkflow=null;window.holdWorkflow='workflow-a';document.querySelector('#drawing-workflow').value='workflow-a';document.querySelector('#drawing-workflow').dispatchEvent(new Event('change'));void 0");await wait('!!window.releaseWorkflow');
    await js('window.cancelledWorkflowReject=rejectWorkflow;window.holdWorkflow=null;void 0');
    await click('[data-tab=records]');await wait("!document.querySelector('#generate-image')");await click('[data-tab=overview]');await wait("document.querySelector('#drawing-workflow')?.value==='workflow-a'&&!document.querySelector('#generate-image').disabled");
    await js('cancelledWorkflowReject();Promise.resolve()');
    assert.equal(await js("document.querySelector('#drawing-workflow').value"),'workflow-a','过期读取失败不能回滚新的页面');
    assert.equal(await js("document.querySelector('#drawing-new-request').disabled"),false);
    await click('#drawing-new-request');await wait('calls.length===6');assert.equal(await js('calls[5].workflowId'),'workflow-a');
    await js('controller.abort();void 0');
    await js(`(async()=>{const {mount}=await import('/mc-play-view.js');window.controller=new AbortController();window.disconnected=false;window.mcState={runtime:{available:true},config:{playerName:'Fixture'},connection:{status:'error',workerActive:true,canDisconnect:true,error:'worker still alive'},history:[],aiEnabled:true};mount(document.querySelector('#root'),{signal:controller.signal,ui:{moduleTabs:{}},state:{modules:[],events:[]},drafts:{read:(_key,value)=>value,write(){},reconcile(){}},api:async(path)=>{if(path.endsWith('/disconnect')){disconnected=true;mcState.connection={status:'disconnected',workerActive:false,canDisconnect:false};}return structuredClone(mcState);}});})()`);
    await wait("!!document.querySelector('#mc-disconnect')");
    assert.equal(await js("document.querySelector('#mc-disconnect').disabled"),false);assert.equal(await js("document.querySelector('#mc-connect').disabled"),true);
    await screenshot('mc-error-disconnect.png');await click('#mc-disconnect');await wait('disconnected');
    assert.equal(await js("document.querySelector('#mc-connect').disabled"),false);assert.equal(await js("document.querySelector('#mc-disconnect').disabled"),true);
    await js('controller.abort();void 0');
    await js(`(async()=>{const {mountTrainingPipeline}=await import('/training-pipeline.js');window.controller=new AbortController();window.workflow={id:'cancelled-work',mode:'tag',state:'blocked',stage:'tag',cancelRequestedAt:new Date().toISOString(),steps:[],tasks:{},error:'提交结果待核对'};const ctx={signal:controller.signal,drafts:{read:(_key,value)=>structuredClone(value),write(){}},state:{modules:[]},ui:{},notify(){},api:async(path)=>{if(path.endsWith('/cancel'))workflow.state='cancelled';if(path.includes('/api/ai/'))return{effective:{enabled:true}};return{jobs:[structuredClone(workflow)]};}};window.pipelineView=mountTrainingPipeline(document.querySelector('#root'),ctx,{mode:'tag',getConfig:()=>({}),setConfig(){},openParameters(){}});await pipelineView.refresh();})()`);
    assert.equal(await js("!!document.querySelector('[data-pipeline-action=resume]')"),false);
    assert.equal(await js("document.querySelector('[data-pipeline-action=cancel]').textContent"),'继续取消');
    await click('[data-pipeline-action=cancel]');await click('[data-pipeline-action=confirm-cancel]');await wait("document.querySelector('#tagging-detail .status-chip').textContent==='已取消'");
    await js('controller.abort();void 0');
    await js(`(async()=>{const {mount}=await import('/skin-studio.js');window.controller=new AbortController();const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfJkAAAAASUVORK5CYII=';const job={id:'skin-local',name:'本地成果',version:1,model:'slim',status:'completed',warning:'皮肤已保存到工作台，但额外作品目录归档失败。可下载 PNG 和分层图，另存到作品目录。',files:{'skin.png':png,'layers.png':png,'manifest.json':'/manifest.json','preview.html':'/preview.html'}};mount(document.querySelector('#root'),{signal:controller.signal,ui:{mcSkin:{name:'',instruction:'',model:'slim',eyeTemplate:'eye_A',references:[],selectedJobId:job.id}},state:{modules:[],events:[]},api:async()=>({runtime:{available:true},jobs:[job],templates:[]})});})()`);
    await wait("document.querySelector('#skin-feedback').textContent.includes('归档失败')");
    assert.equal(await js("document.querySelector('#skin-downloads').hidden"),false);assert.equal(await js("document.querySelector('#skin-approve').disabled"),false);
    await screenshot('skin-archive-warning.png');
    assert.deepEqual(errors,[]);await js('controller.abort();void 0');
    console.log('COMPUTE_RECOVERY_UI_RESULT '+JSON.stringify({recoveredOriginalSnapshot:true,persistedAcrossRemount:true,explicitNewRequest:true,aliveWorkerDisconnect:true,cancelRecovery:true,skinArchiveWarningAndDownload:true,errors}));
  }finally{window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--compute-recovery-electron'))browser().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error);createRequire(import.meta.url)('electron').app.exit(1);});
else test('真实 Electron 核对绘图原快照、明确新建请求，并能断开报错后仍存活的 MC worker',{skip:!electron,timeout:45000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'compute-recovery-electron-')),env={...process.env,COMPUTE_RECOVERY_PROFILE:directory};delete env.ELECTRON_RUN_AS_NODE;
  try{const child=spawn(electron,[script,'--compute-recovery-electron'],{cwd:root,env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/COMPUTE_RECOVERY_UI_RESULT/);}
  finally{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
