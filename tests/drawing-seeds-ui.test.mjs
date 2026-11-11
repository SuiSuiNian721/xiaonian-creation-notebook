import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {resolve,join,sep,extname} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const electron=process.env.AI_FUTURE_ELECTRON||'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe';
const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');app.disableHardwareAcceleration();app.setPath('userData',join(process.env.DRAWING_SEEDS_UI_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const root=resolve(fileURLToPath(new URL('../public-workbench',import.meta.url)));
  const server=createServer(async(req,res)=>{try{const target=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+sep))throw new Error('path');res.setHeader('content-type',extname(target)==='.js'?'text/javascript':extname(target)==='.css'?'text/css':'text/html');res.end(await readFile(target));}catch{res.writeHead(404);res.end();}});await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source),errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const wait=async source=>{for(let i=0;i<100;i++){if(await js(`Boolean(${source})`))return;await pause(40);}throw new Error('界面等待超时: '+source+' '+await js('document.body.innerText.slice(-1500)'));};
  const click=selector=>js(`{const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center'});node.click();}void 0`);
  const set=(selector,value)=>js(`{const node=document.querySelector(${JSON.stringify(selector)});node.value=${JSON.stringify(value)};node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
  const jobs=()=>js("qaCalls.filter(call=>call.path.endsWith('/jobs')).map(call=>call.body)");
  try{
    window.webContents.session.webRequest.onBeforeRequest({urls:['http://127.0.0.1:'+server.address().port+'/app.js']},(_details,callback)=>callback({cancel:true}));await window.loadURL('http://127.0.0.1:'+server.address().port+'/index.html');
    await js(`(async()=>{
      document.body.innerHTML='<main style="padding:28px;max-width:1360px;margin:auto" id="drawing-root"></main>';
      const {mount}=await import('/drawing-view.js');const {Drafts}=await import('/drafts.js');const {installSearchableSelects}=await import('/searchable-select.js');window.qaController=new AbortController();installSearchableSelects(document,{signal:qaController.signal});window.qaCalls=[];window.qaRejectJob=false;
      // The source graph has positive text at 12, negative text at 5, image seed at 7,
      // rewrite seed at 14 and the explicit rewrite switch at 17. Values are sanitized.
      const field=(node,input,type,value,label,section,extra={})=>({key:node+':'+input,nodeId:node,input,label:input,group:'Raw English Node',type,value,...extra,presentation:{label,section,description:label+'用于控制对应的绘图步骤。',seed:false,...extra.presentation}});
      const fields=[field('5','text','text','模糊、文字水印','负面提示词','prompts',{multiline:true}),field('12','value','text','窗边的蓝色陶瓷杯','正面提示词','prompts',{multiline:true}),field('7','seed','number',20261020,'绘图种子','sampling',{min:0,max:Number.MAX_SAFE_INTEGER,step:1,presentation:{seed:true}}),field('7','steps','number',25,'采样步数','sampling',{min:1,max:100,step:1}),field('7','sampler_name','select','euler','采样器','sampling',{choices:['euler','er_sde']}),field('7','scheduler','select','simple','调度器','sampling',{choices:['simple','normal']}),field('14','seed','number',42,'提示词改写种子','rewrite',{min:0,max:Number.MAX_SAFE_INTEGER,step:1,presentation:{seed:true,enabledWhen:[{key:'17:switch',equals:true}]}}),field('17','switch','boolean',true,'提示词改写','rewrite'),field('15','string_b','text','','空文本判断值','advanced',{multiline:true}),field('10','预设','select','自定义','尺寸预设','size',{choices:['自定义','横图']}),field('10','随机模式','boolean',false,'随机尺寸','size'),field('10','自定义宽','number',1024,'宽度','size',{min:64,max:8192,step:64,presentation:{enabledWhen:[{key:'10:预设',equals:'自定义'},{key:'10:随机模式',equals:false}]}}),field('10','自定义高','number',1024,'高度','size',{min:64,max:8192,step:64,presentation:{enabledWhen:[{key:'10:预设',equals:'自定义'},{key:'10:随机模式',equals:false}]}}),field('10','批次数量','number',1,'尺寸节点批次数量','advanced',{presentation:{hidden:true}})];
      window.qaWorkflow={id:'active',name:'提示词与种子验证',fields,document:{nodes:[{id:7,type:'KSampler',widgets_values:[20261020,'fixed',25,2.5,'er_sde','simple',1]},{id:14,type:'TextGenerateQwen35MTP',widgets_values:['','preset',4096,1,20,0.95,0,1,1.5,true,42,'fixed','auto']}]}};
      window.qaOther={id:'other',name:'其他工作流',fields:[]};window.qaState={connection:{connected:true},workflows:[qaWorkflow,qaOther],jobs:[{id:'fixture-job',workflowName:'种子显示（界面测试）',status:'completed',createdAt:'2026-11-10T00:00:00.000Z',seeds:[{key:'7:seed',label:'采样种子',value:20261020},{key:'14:seed',label:'提示词改写种子',value:42}]}],defaultPreviewMethod:'auto'};
      window.qaCtx={signal:qaController.signal,drafts:new Drafts(),ui:{moduleTabs:{drawing:'overview'},drawingWorkflow:'active'},state:{modules:[{id:'comfyui',enabled:true}],events:[]},notify:message=>{throw new Error(message);},navigate:()=>{},navigateModule:()=>{},action:async(_button,job)=>job(),api:async(path,options={})=>{qaCalls.push({path,...structuredClone(options)});if(path.endsWith('/state'))return structuredClone(qaState);if(path.endsWith('/preview-options'))return {perPrompt:true};if(path.endsWith('/jobs')){if(qaRejectJob)throw new Error('模拟响应中断');return {id:'job',status:'queued'};}if(path.includes('/workflows/'))return structuredClone(path.endsWith('/active')?qaWorkflow:qaOther);return {};}};
      qaWorkflow.fields.find(field=>field.key==='10:批次数量').step=1;
      qaCtx.drafts.write('drawing:active',{'10:批次数量':1.5});
      await mount(document.querySelector('#drawing-root'),qaCtx);
    })()`);
    assert.equal(await js("document.querySelector('[data-parameter=\"12:value\"]').labels[0].textContent"),'正面提示词');
    assert.equal(await js("document.querySelector('[data-parameter=\"5:text\"]').labels[0].textContent"),'负面提示词');
    assert.equal(await js("document.querySelector('[data-parameter=\"15:string_b\"]').closest('details')!==null"),true,'内部空文本判断不占用提示词区');
    assert.equal(await js("document.querySelector('[data-parameter=\"10:批次数量\"]')"),null,'未连接的尺寸批次数量不显示');
    assert.equal(await js("[...document.querySelectorAll('#drawing-parameters [data-help]')].some(node=>/[A-Za-z_]/.test(node.dataset.help))"),false,'说明不回显英语节点名或字段名');
    assert.equal(await js("document.querySelector('[data-parameter=\"7:scheduler\"]').selectedOptions[0].textContent"),'simple','调度器保留 ComfyUI 原名称');
    assert.equal(await js("document.querySelector('[data-parameter=\"7:sampler_name\"]').selectedOptions[0].textContent"),'euler','采样算法保留常用英文名称');
    assert.equal(await js("document.querySelector('#connect-comfy').textContent"),'重新连接');
    await click('[data-job-seeds] summary');assert.equal(await js("document.querySelector('[data-job-seeds]').open"),true);assert.match(await js("document.querySelector('[data-job-seeds]').textContent"),/20261020/);
    await js("qaState.jobs[0].warning='仅用于界面校验';void 0");await click('#refresh-drawing');assert.equal(await js("document.querySelector('[data-job-seeds]').open"),true,'刷新任务卡片后保留已展开的种子');
    await click('#generate-image');await wait("qaCalls.filter(call=>call.path.endsWith('/jobs')).length===1&&!document.querySelector('#generate-image').disabled");
    const fixed=(await jobs())[0];assert.equal(fixed.values['7:seed'],20261020);assert.equal(fixed.values['14:seed'],42);assert.equal(fixed.values['10:批次数量'],1);assert.equal(fixed.values['7:scheduler'],'simple');assert.equal(await js("qaCtx.drafts.read('drawing:active',{})['10:批次数量']"),1.5,'隐藏字段的无效旧草稿也只在提交时回退');
    await js("document.querySelector('[data-seed-mode=\"7:seed\"]').focus();void 0");window.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});await wait("document.querySelector('[data-seed-mode=\"7:seed\"]').value==='random'");
    assert.equal(await js("document.querySelector('[data-parameter=\"7:seed\"]').matches(':disabled')"),true);
    await set('[data-seed-mode="14:seed"]','random');await click('[data-parameter="17:switch"]');
    assert.equal(await js("document.querySelector('[data-seed-mode=\"14:seed\"]').matches(':disabled')"),true,'关闭改写后其种子方式暂停生效');
    await click('#generate-image');await wait("qaCalls.filter(call=>call.path.endsWith('/jobs')).length===2&&!document.querySelector('#generate-image').disabled");
    const first=(await jobs())[1];assert.notEqual(first.values['7:seed'],fixed.values['7:seed']);assert.equal(first.values['14:seed'],42,'停用改写不随机消耗其种子');
    await click('[data-parameter="17:switch"]');await js('qaRejectJob=true;void 0');await click('#generate-image');await wait("document.querySelector('#drawing-feedback').textContent.includes('模拟响应中断')");
    const second=(await jobs())[2];assert.notEqual(first.values['7:seed'],second.values['7:seed']);assert.notEqual(second.values['14:seed'],42);assert.ok(Number.isSafeInteger(second.values['7:seed']));assert.equal(Object.hasOwn(second,'seedModes'),false);
    await set('[data-seed-mode="7:seed"]','fixed');await set('[data-parameter="7:seed"]','88');await js('qaRejectJob=false;void 0');await click('#generate-image');await wait("document.querySelector('#drawing-pending-notice').hidden");assert.deepEqual((await jobs())[3],second,'核对旧任务不会重新抽取任一随机种子');
    await set('[data-seed-mode="7:seed"]','random');await set('#drawing-workflow','other');await wait("!document.querySelector('[data-seed-mode]')");await set('#drawing-workflow','active');await wait("document.querySelector('[data-seed-mode=\"7:seed\"]')");assert.equal(await js("document.querySelector('[data-seed-mode=\"7:seed\"]').value"),'random');assert.equal(await js("qaCtx.drafts.read('drawing:seed-modes:active',{})['14:seed']"),'random');
    await set('[data-parameter="10:自定义宽"]','0');await set('[data-parameter="10:预设"]','横图');assert.equal(await js("document.querySelector('[data-parameter=\"10:自定义宽\"]').matches(':disabled')"),true);
    await click('#generate-image');await wait("qaCalls.filter(call=>call.path.endsWith('/jobs')).length===5&&!document.querySelector('#generate-image').disabled");assert.equal((await jobs())[4].values['10:自定义宽'],1024,'停用的无效宽度提交原图有效值');
    await set('[data-parameter="10:预设"]','自定义');assert.equal(await js("document.querySelector('[data-parameter=\"10:自定义宽\"]').value"),'0','重新启用后仍保留尚未修正的原草稿');assert.equal(await js("document.querySelector('[data-parameter=\"10:自定义宽\"]').matches(':disabled')"),false);await set('[data-parameter="10:自定义宽"]','1024');
    await set('[data-seed-mode="14:seed"]','fixed');await set('[data-parameter="14:seed"]','-1');await click('[data-parameter="17:switch"]');await click('#generate-image');await wait("qaCalls.filter(call=>call.path.endsWith('/jobs')).length===6&&!document.querySelector('#generate-image').disabled");assert.equal((await jobs())[5].values['14:seed'],42,'关闭改写后无效种子不会阻断生成');
    await click('[data-parameter="17:switch"]');assert.equal(await js("document.querySelector('[data-parameter=\"14:seed\"]').value"),'-1');await click('#generate-image');assert.match(await js("document.querySelector('[data-parameter=\"14:seed\"]').validationMessage"),/小于/);assert.equal((await jobs()).length,6);await set('[data-parameter="14:seed"]','42');
    await set('[data-parameter="7:steps"]','0');await click('#generate-image');assert.match(await js("document.querySelector('[data-parameter=\"7:steps\"]').validationMessage"),/至少|小于|不低于/);assert.equal((await jobs()).length,6,'无效数字不会发送任务');await set('[data-parameter="7:steps"]','25');assert.equal(await js("document.querySelector('[data-parameter=\"7:steps\"]').checkValidity()"),true);
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    const output=process.env.DRAWING_SEEDS_UI_OUTPUT;if(output){mkdirSync(output,{recursive:true});const capture=async name=>{await js('window.scrollTo(0,0);new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await pause(150);window.webContents.debugger.attach('1.3');try{const {cssContentSize}=await window.webContents.debugger.sendCommand('Page.getLayoutMetrics');const image=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}});writeFileSync(join(output,name),Buffer.from(image.data,'base64'));}finally{window.webContents.debugger.detach();}};await capture('drawing-seeds-light.png');await js("document.documentElement.dataset.theme='dark';void 0");await capture('drawing-seeds-dark.png');}
    await js('qaController.abort();void 0');assert.deepEqual(errors,[]);console.log('DRAWING_SEEDS_UI_PASS isolated actual-graph semantics; no GPU jobs');
  }finally{window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));app.quit();}
}
if(process.env.DRAWING_SEEDS_UI_CHILD==='1')run().catch(error=>{console.error(error);process.exit(1);});
else test('正负提示词、两类固定随机种子、完整重试快照和条件参数在桌面可用',{skip:!existsSync(electron),timeout:60000},async t=>{const directory=await mkdtemp(join(tmpdir(),'drawing-seeds-ui-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});await new Promise((done,reject)=>{const env={...process.env,DRAWING_SEEDS_UI_CHILD:'1',DRAWING_SEEDS_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(import.meta.url)],{env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(new Error(output));},50000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0&&output.includes('DRAWING_SEEDS_UI_PASS')?done():reject(new Error(output));});});});
