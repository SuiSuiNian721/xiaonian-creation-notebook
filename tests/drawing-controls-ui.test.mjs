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
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.DRAWING_CONTROLS_UI_DIR,'profile'));app.on('window-all-closed',()=>{});await app.whenReady();
  const root=resolve(fileURLToPath(new URL('../public-workbench',import.meta.url)));
  const server=createServer(async(req,res)=>{try{const target=resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));if(!target.startsWith(root+sep))throw new Error('path');res.setHeader('content-type',extname(target)==='.js'?'text/javascript':extname(target)==='.css'?'text/css':'text/html');res.end(await readFile(target));}catch{res.writeHead(404);res.end();}});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1440,height:1100,webPreferences:{offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source),errors=[];
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const wait=async source=>{for(let i=0;i<120;i++){if(await js(`Boolean(${source})`))return;await pause(40);}throw new Error('界面等待超时: '+source+' '+await js('document.body.innerText.slice(-1800)'));};
  const click=selector=>js(`{const target=document.querySelector(${JSON.stringify(selector)});target.scrollIntoView({block:'center'});target.click();}void 0`);
  const set=async(selector,value)=>js(`{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
  const upload=selector=>js(`{const files=new DataTransfer();files.items.add(new File([new Uint8Array([137,80,78,71])],'参考图.png',{type:'image/png'}));const input=document.querySelector(${JSON.stringify(selector)});input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
  try{
    window.webContents.session.webRequest.onBeforeRequest({urls:['http://127.0.0.1:'+server.address().port+'/app.js']},(_details,callback)=>callback({cancel:true}));
    await window.loadURL('http://127.0.0.1:'+server.address().port+'/index.html');
    await js(`(async()=>{
      document.body.innerHTML='<main style="padding:28px;max-width:1360px;margin:auto" id="drawing-root"></main>';
      const {mount}=await import('/drawing-view.js');const {Drafts}=await import('/drafts.js');const {installSearchableSelects}=await import('/searchable-select.js');
      window.qaController=new AbortController();installSearchableSelects(document,{signal:qaController.signal});window.qaCalls=[];window.qaRejectJob=false;window.qaDelayUpload=false;window.qaDelayWorkflow=false;window.qaRejectWorkflow=false;window.qaStarting=false;window.qaRejectOpen=false;window.qaNavigations=[];
      const field=(node,input,type,value,extra={})=>({key:node+':'+input,nodeId:node,input,label:input,group:node==='3'?'角色 LoRA':'绘图参数',type,value,...extra});
      const fields=[field('1','text','string','一位坐在窗边的角色',{multiline:true}),field('2','width','number',1024,{min:64,max:8192,step:64}),field('2','height','number',1536,{min:64,max:8192,step:64}),field('2','steps','number',24,{min:1,step:1}),field('2','seed','number',42,{step:1}),field('3','lora_name','select','人物/小汐.safetensors',{choices:['人物/小汐.safetensors','风格/柔光.safetensors']}),field('3','strength_model','number',0.8,{step:0.05}),field('3','strength_clip','number',0.7,{step:0.05}),field('4','image','select','已有参考.png',{image:true,choices:['已有参考.png','uploaded/参考图.png']}),field('5','filename_prefix','string','ComfyUI')];
      window.qaWorkflows={zero:{id:'zero',name:'固定参数工作流',fields:[]},portrait:{id:'portrait',name:'角色绘图 · 模拟工作流',fields,controls:{lora:{available:true,choices:['人物/小汐.safetensors','风格/柔光.safetensors']},reference:{available:true,maxImages:3}}},other:{id:'other',name:'另一个工作流',fields:[field('1','text','string','其他提示词',{multiline:true})]}};
      window.qaPortrait=structuredClone(qaWorkflows.portrait);window.qaState={connection:{connected:true},workflows:Object.values(qaWorkflows),jobs:[],defaultPreviewMethod:'auto'};
      qaState.preferences={outputPath:'C:/工作台/角色绘图',defaultOutputPath:'C:/工作台/角色绘图',customOutputPath:'',openBrowser:false};window.qaBrowserOpens=0;
      window.qaCtx={signal:qaController.signal,drafts:new Drafts(),ui:{moduleTabs:{drawing:'overview'},drawingWorkflow:'zero'},state:{modules:[{id:'comfyui',enabled:true}],events:[],selectedCharacterId:'character-one'},notify:message=>{throw new Error(message);},navigate:()=>{},navigateModule:(id,options)=>qaNavigations.push({id,...options}),action:async(button,job)=>{if(button.disabled)return;button.disabled=true;try{return await job();}finally{if(button.isConnected)button.disabled=false;}},api:async(path,options={})=>{
        qaCalls.push({path,...structuredClone({...options,signal:undefined})});
        if(path.endsWith('/mcp/tools'))return {tools:[]};
        if(path==='/api/ai/config')return {mcpEnabled:false};
        if(path==='/api/paths/choose')return {path:'C:/我的作品',cancelled:false};
        if(path.endsWith('/preferences')){if(Object.hasOwn(options.body,'outputPath')){qaState.preferences.customOutputPath=options.body.outputPath;qaState.preferences.outputPath=options.body.outputPath||qaState.preferences.defaultOutputPath;}if(Object.hasOwn(options.body,'openBrowser'))qaState.preferences.openBrowser=options.body.openBrowser;return structuredClone(qaState.preferences);}
        if(path.endsWith('/open-service')){if(window.qaDelayOpen)await new Promise(done=>window.qaFinishOpen=done);if(qaRejectOpen)throw new Error('模拟启动失败');if(qaStarting){qaState.connection.connected=false;qaState.startup={status:'waiting'};return {starting:true,browserManaged:true,openBrowser:options.body.openBrowser};}qaState.connection.connected=true;qaWorkflows.portrait=structuredClone(qaPortrait);if(options.body.openBrowser)qaBrowserOpens++;return {url:'http://127.0.0.1:8188',browserManaged:true,openBrowser:options.body.openBrowser,opened:options.body.openBrowser};}
        if(path.endsWith('/state'))return structuredClone(qaState);
        if(path.includes('/jobs/')&&['hide','restore'].includes(path.split('/').at(-1))){
          const parts=path.split('/'),id=parts.at(-2),operation=parts.at(-1);
          if(window.qaRejectRemoval)throw new Error('模拟移除失败');
          window.qaHiddenJobs||=new Map();
          if(operation==='hide'){qaHiddenJobs.set(id,qaState.jobs.find(job=>job.id===id));qaState.jobs=qaState.jobs.filter(job=>job.id!==id);}else{qaState.jobs.push(qaHiddenJobs.get(id));qaHiddenJobs.delete(id);}
          return {id,hidden:operation==='hide'};
        }
        if(path.endsWith('/connect')){qaState.connection.connected=true;qaWorkflows.portrait=structuredClone(qaPortrait);return structuredClone(qaState);}
        if(path.endsWith('/preview-options'))return {perPrompt:true};
        if(path.endsWith('/jobs')){if(qaRejectJob)throw new Error('模拟提交响应中断');return {id:'job',status:'queued'};}
        if(path.endsWith('/uploads')){if(qaDelayUpload)await new Promise(done=>window.qaFinishUpload=done);return {image:'uploaded/参考图.png'};}
        if(path.endsWith('/assistant'))return {workflow:{candidate:{}},explanation:'候选已生成',text:'候选已生成'};
        if(path.endsWith('/workflows/scan')){if(window.qaDelayScan)await new Promise(done=>window.qaFinishScan=done);return {files:[{key:'qwen',name:'Qwen_二次元改图.json'},{key:'moss',name:'MOSS_绘图.json'},{key:'anima',name:'Anima_放大.json'},...(window.qaNewExport?[{key:'new-export',name:'小璃_MOSS_.json'}]:[])],directories:['C:/工作流','C:/Users/念念/Downloads']};}
        if(path.endsWith('/workflows/inspect-file'))return {valid:true,available:true,warnings:[]};
        if(path.endsWith('/workflows/open'))return {id:'portrait'};
        if(path.endsWith('/workflows/inspect'))return {valid:true,available:true,warnings:[]};
        if(path.endsWith('/workflows/import'))return {id:'portrait'};
        if(path.includes('/workflows/')){if(qaDelayWorkflow)await new Promise(done=>window.qaFinishWorkflow=done);if(qaRejectWorkflow)throw new Error('模拟工作流加载失败');return structuredClone(qaWorkflows[path.split('/').at(-1)]);}
        return {};
      }};
      await mount(document.querySelector('#drawing-root'),qaCtx);
    })()`);
    assert.equal(await js("document.querySelector('#generate-image').disabled"),false,'合法的零字段工作流也可以生成');
    assert.equal(await js("document.querySelector('#drawing-open-browser').checked"),false);
    assert.equal(await js("document.querySelector('#connect-comfy')"),null,'连接与启动合并为一个入口');
    for(const selector of ['#open-comfy','#drawing-open-browser','#open-model-downloads','#open-launcher'])assert.equal(await js(`!!document.querySelector('.module-header-actions ${selector}')`),true,'服务控制放在顶部');
    await js('qaStarting=true;qaState.connection.connected=false;void 0');
    await click('#tab-workflows');await wait("document.querySelector('#workflow-file')");
    assert.equal(await js("document.querySelector('#open-comfy').textContent"),'启动 ComfyUI');
    await js('window.qaDelayOpen=true;void 0');await click('#open-comfy');await wait('window.qaFinishOpen');
    assert.equal(await js("document.querySelector('#open-comfy').textContent"),'正在启动 ComfyUI…','请求尚未返回时就显示启动中');
    assert.equal(await js("document.querySelector('#drawing-connection').textContent"),'ComfyUI 正在启动…');
    assert.equal(await js("document.querySelector('#drawing-feedback').textContent"),'ComfyUI 正在启动…');
    assert.equal(await js("document.querySelector('#open-comfy').getAttribute('aria-busy')"),'true');
    await click('#open-comfy');assert.equal(await js("qaCalls.filter(call=>call.path.endsWith('/open-service')).length"),1,'等待期间不会重复提交启动');
    await js('qaDelayOpen=false;qaFinishOpen();void 0');await wait("qaState.startup?.status==='waiting'");
    await click('#tab-records');await wait("document.querySelector('#tab-records').getAttribute('aria-selected')==='true'");
    assert.equal(await js("document.querySelector('#open-comfy').disabled"),true,'切换页签不取消启动等待，也不允许重复启动');
    assert.equal(await js("document.querySelector('#drawing-connection').textContent"),'ComfyUI 正在启动…','轮询与切页保留启动反馈');
    await js("qaStarting=false;qaState.connection.connected=true;qaState.startup={status:'ready'};void 0");
    await wait("!document.querySelector('#open-comfy').disabled&&document.querySelector('#drawing-feedback').textContent==='ComfyUI 已连接。'");
    assert.equal(await js("document.querySelector('#tab-records').getAttribute('aria-selected')"),'true','启动完成保留当前页签');
    await click('#open-model-downloads');await click('#open-launcher');
    assert.deepEqual(await js('qaNavigations'),[{id:'comfyui',tab:'resources',section:'downloads'},{id:'comfyui',tab:'runtime'}]);
    await js('qaRejectOpen=true;qaState.connection.connected=false;void 0');await click('#tab-workflows');await wait("document.querySelector('#workflow-file')");await click('#open-comfy');await wait("document.querySelector('#drawing-feedback').textContent==='模拟启动失败'&&!document.querySelector('#open-comfy').disabled");
    assert.equal(await js("document.querySelector('#drawing-connection').textContent"),'ComfyUI 启动失败');
    assert.equal(await js("document.querySelector('#open-comfy').getAttribute('aria-busy')"),'false');
    await js('qaRejectOpen=false;void 0');await click('#tab-overview');await wait("document.querySelector('#generate-image')");
    await click('#open-comfy');await wait("qaCalls.some(call=>call.path.endsWith('/open-service'))&&!document.querySelector('#open-comfy').disabled");
    assert.equal(await js('qaBrowserOpens'),0);
    await click('#drawing-open-browser');await wait("qaState.preferences.openBrowser&&!document.querySelector('#drawing-open-browser').disabled");await click('#open-comfy');await wait("qaBrowserOpens===1&&!document.querySelector('#open-comfy').disabled");
    assert.equal(await js("document.querySelector('#drawing-open-browser').checked"),true,'重绘页面保留浏览器选择');
    await click('.drawing-output-settings>summary');
    assert.equal(await js("document.querySelector('#drawing-output-path').placeholder"),'C:/工作台/角色绘图');
    await click('.drawing-output-settings [data-path-field]');await wait("document.querySelector('#drawing-output-path').value==='C:/我的作品'");
    await click('.drawing-output-settings [type="submit"]');await wait("qaState.preferences.outputPath==='C:/我的作品'");
    await set('#drawing-output-path','C:/手填目录');await click('.drawing-output-settings [type="submit"]');await wait("qaState.preferences.outputPath==='C:/手填目录'");
    await click('[data-reset-output]');await wait("qaState.preferences.outputPath==='C:/工作台/角色绘图'");
    if(process.env.DRAWING_CONTROLS_UI_OUTPUT){mkdirSync(process.env.DRAWING_CONTROLS_UI_OUTPUT,{recursive:true});await js('window.scrollTo(0,0);void 0');await pause(100);writeFileSync(join(process.env.DRAWING_CONTROLS_UI_OUTPUT,'drawing-output-browser.png'),(await window.webContents.capturePage()).toPNG());}
    await click('#generate-image');await wait("qaCalls.some(call=>call.path.endsWith('/jobs'))");
    assert.equal(await js("Object.hasOwn(qaCalls.find(call=>call.path.endsWith('/jobs')).body,'adjustments')"),false,'没有附加参数时保留旧请求形状');
    await set('#drawing-workflow','portrait');await wait("document.querySelector('[data-parameter=\"3:lora_name\"]')");
    assert.equal(await js("document.querySelector('[data-parameter=\"3:lora_name\"]').closest('details')"),null,'LoRA 名称不能藏在高级参数里');
    assert.equal(await js("document.querySelector('[data-parameter=\"3:strength_model\"]').closest('details')"),null,'LoRA 权重直接显示');
    assert.equal(await js("document.querySelector('[data-parameter=\"3:lora_name\"]').hasAttribute('data-searchable')"),true);
    await set('[data-size-preset]','832x1216');
    assert.equal(await js("document.querySelector('[data-parameter=\"2:width\"]').value"),'832');
    assert.equal(await js("document.querySelector('[data-parameter=\"2:height\"]').value"),'1216');
    await set('[data-size-preset]','');await set('[data-parameter="2:width"]','960');await set('[data-parameter="2:height"]','1536');
    assert.equal(await js("document.querySelector('[data-size-preset]').value"),'','自定义尺寸可编辑且保留');
    await click('[data-extra-lora-name]');await wait("document.querySelector('[data-search-select-input]')");
    await set('[data-search-select-input]','柔光');await click('[data-search-select-option]');
    await set('[data-extra-lora-model]','0.735');await set('[data-extra-lora-clip]','0.4');
    await set('[data-parameter="2:width"]','768');await set('[data-parameter="1:text"]','保留我的提示词');
    await upload('[data-extra-reference-upload]');await wait("document.querySelector('[data-extra-reference]')");
    assert.equal(await js("document.querySelector('[data-reference-size]')?.value"),'reference');
    assert.equal(await js("document.querySelector('[data-parameter=\"2:width\"]').matches(':disabled')"),true,'跟随参考图时不提供无效宽高');
    assert.equal(await js("document.querySelector('[data-size-preset]').matches(':disabled')"),true,'跟随主图时预设同样禁用');
    await set('[data-reference-size]','workflow');assert.equal(await js("document.querySelector('[data-parameter=\"2:width\"]').matches(':disabled')"),false);
    await set('#drawing-workflow','other');await wait("document.querySelector('[data-parameter=\"1:text\"]').value==='其他提示词'");
    await set('#drawing-workflow','portrait');await wait("document.querySelector('[data-extra-lora-name]')?.value==='风格/柔光.safetensors'");
    assert.equal(await js("document.querySelector('[data-extra-lora-model]').value"),'0.735');assert.equal(await js("document.querySelector('[data-parameter=\"2:width\"]').value"),'768');
    assert.equal(await js("document.querySelector('[data-extra-reference]').textContent.includes('参考图.png')"),true);
    assert.equal(await js("document.querySelector('[data-reference-size]').value"),'workflow');
    await js('qaRejectJob=true;void 0');await click('#generate-image');await wait("document.querySelector('#drawing-feedback').textContent.includes('模拟提交响应中断')");
    const snapshot=await js("qaCalls.filter(call=>call.path.endsWith('/jobs')).at(-1).body");
    assert.deepEqual(snapshot.adjustments,{loras:[{name:'风格/柔光.safetensors',modelWeight:0.735,clipWeight:0.4}],images:['uploaded/参考图.png'],referenceSize:'workflow'});assert.equal(snapshot.values['2:width'],768);
    await set('[data-extra-lora-model]','0.2');await set('[data-parameter="2:width"]','1');await js('qaRejectJob=false;void 0');await click('#generate-image');
    await wait("document.querySelector('#drawing-pending-notice').hidden");
    assert.deepEqual(await js("qaCalls.filter(call=>call.path.endsWith('/jobs')).at(-1).body"),snapshot,'重试使用原始的完整参数快照');
    await set('[data-parameter="2:width"]','1024');
    await click('#drawing-add-lora');await set('[data-extra-lora]:last-child [data-extra-lora-model]','');
    assert.equal(await js("document.querySelector('#drawing-generate-form').checkValidity()"),true,'没有选文件的空行不影响生成');
    await click('[data-extra-lora]:last-child [data-remove-lora]');
    await js('qaDelayUpload=true;void 0');await upload('[data-extra-reference-upload]');await wait('window.qaFinishUpload');
    assert.equal(await js("document.querySelector('#generate-image').disabled"),true,'上传期间禁止生成');
    await set('#drawing-workflow','other');await wait("document.querySelector('[data-parameter=\"1:text\"]').value==='其他提示词'");
    await js('qaFinishUpload();qaDelayUpload=false;void 0');await pause(100);
    assert.equal(await js("document.querySelector('[data-extra-reference]')"),null,'旧工作流上传完成不能改写当前页');
    assert.equal(await js("document.querySelector('#generate-image').disabled"),false);
    await set('#drawing-workflow','portrait');await wait("document.querySelector('[data-extra-lora-name]')");
    await js('qaDelayUpload=true;qaFinishUpload=null;void 0');await upload('[data-extra-reference-upload]');await wait('window.qaFinishUpload');
    await js('qaRejectWorkflow=true;void 0');await set('#drawing-workflow','other');await wait("document.querySelector('#drawing-feedback').textContent.includes('模拟工作流加载失败')");
    await js('qaFinishUpload();qaDelayUpload=false;qaRejectWorkflow=false;void 0');await pause(80);
    assert.equal(await js("document.querySelector('[data-extra-lora-name]').matches(':disabled')"),false,'切换失败后恢复原工作流，废弃上传不得锁住控件');
    await js("qaWorkflows.other.controls={lora:{available:true,supportsClip:false,choices:['仅模型.safetensors']}};void 0");await set('#drawing-workflow','other');await wait("document.querySelector('[data-extra-lora-name]')?.options[1]?.value==='仅模型.safetensors'");
    assert.equal(await js("document.querySelector('[data-extra-lora-clip]')"),null,'仅模型加载器不显示无效的文本权重');
    await set('#drawing-workflow','portrait');await wait("document.querySelector('[data-parameter=\"2:width\"]')");
    await set('#drawing-workflow','other');await wait("document.querySelector('[data-extra-lora-name]')?.options[1]?.value==='仅模型.safetensors'");
    await js("qaState.connection.connected=false;qaWorkflows.portrait.fields=[];qaWorkflows.portrait.controls={lora:{available:false,choices:[]},reference:{available:false,maxImages:0}};void 0");
    await set('#drawing-workflow','portrait');await wait("document.querySelector('#drawing-unavailable-adjustments')");
    assert.equal(await js("document.querySelector('#generate-image').disabled"),true,'不可用的已保存附加参数不能被静默丢弃后生成');
    await click('#open-comfy');await wait("document.querySelector('[data-extra-lora-name]')?.value==='风格/柔光.safetensors'");
    assert.equal(await js("document.querySelector('[data-extra-lora-model]').value"),'0.2');assert.equal(await js("document.querySelector('[data-parameter=\"1:text\"]').value"),'保留我的提示词');
    assert.equal(await js("document.querySelector('[data-extra-reference]').textContent.includes('参考图.png')"),true,'断开后重连保留附加图片');
    await click('#manage-workflows');await wait("document.querySelector('#workflow-file')");
    assert.equal(await js("document.querySelector('#assistant-base-workflow').value"),'','不自动使用当前绘图工作流作为基础');
    await set('#assistant-base-model','qwen.safetensors');await set('#assistant-loras','anime.safetensors:0.8');await set('#workflow-instruction','多图参考二次元改图');await click('#write-workflow');
    await wait("qaCalls.some(call=>call.path.endsWith('/assistant'))");
    const assistant=await js("qaCalls.find(call=>call.path.endsWith('/assistant')).body");
    assert.equal(assistant.workflowId,null);assert.equal(assistant.baseModel,'qwen.safetensors');assert.equal(assistant.loras,'anime.safetensors:0.8');
    await click('#scan-workflows');await wait("document.querySelectorAll('[data-import-local]').length===3");
    await js('window.qaDelayScan=true;window.qaNewExport=true;void 0');await click('#scan-workflows');await wait('window.qaFinishScan');
    assert.equal(await js("document.querySelector('#scan-workflows').textContent"),'正在扫描…');
    assert.equal(await js("document.querySelector('#scan-workflows').disabled"),true);
    await js('qaFinishScan();qaDelayScan=false;void 0');await wait("document.querySelectorAll('[data-import-local]').length===4");
    assert.equal(await js("qaCalls.filter(call=>call.path.endsWith('/workflows/scan')).length"),2,'每次扫描都请求服务');
    assert.match(await js("document.querySelector('#drawing-feedback').textContent"),/扫描完成，找到 4 个/);
    assert.equal(await js("document.querySelector('#scan-workflows').textContent"),'扫描本地');
    assert.match(await js("document.querySelector('#scan-workflows').title"),/Downloads/);
    await set('#workflow-keyword','QWEN 二次元');assert.equal(await js("document.querySelectorAll('[data-import-local]').length"),1);
    assert.equal(await js("document.querySelector('[data-import-local]').dataset.importLocal"),'qwen');
    await set('#workflow-keyword','不存在');assert.equal(await js("document.querySelectorAll('[data-import-local]').length"),0);assert.match(await js("document.querySelector('[data-local-workflow-results]').textContent"),/没有匹配/);
    await set('#workflow-keyword','');assert.equal(await js("document.querySelectorAll('[data-import-local]').length"),4);
    await set('#workflow-keyword','qwen');await click('[data-import-local]');await wait("document.querySelector('#drawing-workflow')?.value==='portrait'");
    assert.equal(await js("qaCalls.find(call=>call.path.endsWith('/workflows/open')).body.key"),'qwen','过滤后导入仍使用原文件标识');
    await click('#manage-workflows');await wait("document.querySelector('#workflow-file')");
    assert.equal(await js("document.querySelector('#workflow-keyword').value"),'qwen');assert.equal(await js("document.querySelector('#assistant-base-model').value"),'qwen.safetensors');assert.equal(await js("document.querySelector('#assistant-base-workflow').value"),'');
    if(process.env.DRAWING_CONTROLS_UI_OUTPUT){mkdirSync(process.env.DRAWING_CONTROLS_UI_OUTPUT,{recursive:true});await js('window.scrollTo(0,0);void 0');await pause(100);writeFileSync(join(process.env.DRAWING_CONTROLS_UI_OUTPUT,'workflow-search-assistant.png'),(await window.webContents.capturePage()).toPNG());}
    await js(`{const files=new DataTransfer();files.items.add(new File(['{}'],'新工作流.json',{type:'application/json'}));document.querySelector('#workflow-file').files=files.files;document.querySelector('#workflow-file').dispatchEvent(new Event('change',{bubbles:true}));}void 0`);
    await wait("document.querySelector('#drawing-workflow')?.value==='portrait'");
    assert.equal(await js("document.querySelector('[data-tab=overview]').getAttribute('aria-selected')"),'true','导入完成后直接进入绘图');
    assert.equal(await js("qaCalls.filter(call=>call.path.endsWith('/jobs')).length"),3,'导入不自动生成图片');
    await js(`qaState.jobs=['completed','failed','cancelled','queued','running','unknown'].map((status,index)=>({id:'history-'+index,workflowName:'作品 '+status,status,createdAt:'2026-11-11T04:00:00.000Z',images:[],results:[]}));void 0`);
    await click('#refresh-drawing');await wait("document.querySelectorAll('[data-job-remove]').length===3");
    assert.equal(await js("document.querySelector('[data-job-remove=\"history-3\"]')"),null,'活动任务不提供移除入口');
    await js('window.qaRejectRemoval=true;void 0');await click('[data-job-remove="history-0"]');await wait("document.querySelector('#drawing-feedback').textContent==='模拟移除失败'");
    assert.equal(await js("document.querySelectorAll('.drawing-job').length"),6,'移除失败时保留作品');
    await js('qaRejectRemoval=false;void 0');await click('[data-job-remove="history-0"]');await wait("document.querySelectorAll('.drawing-job').length===5&&!document.querySelector('#drawing-history-feedback').hidden");
    assert.match(await js("document.querySelector('#drawing-history-feedback').textContent"),/作品文件保留/);
    await click('[data-job-remove="history-1"]');await wait("document.querySelectorAll('.drawing-job').length===4");
    await click('#tab-records');await click('#tab-overview');await wait("document.querySelector('#drawing-undo-remove')&&!document.querySelector('#drawing-history-feedback').hidden");
    await click('#drawing-undo-remove');await wait("document.querySelector('[data-job-remove=\"history-1\"]')");
    assert.equal(await js("document.querySelector('[data-job-remove=\"history-0\"]')"),null,'逐条撤销，不恢复其他已移除作品');
    await click('#drawing-undo-remove');await wait("document.querySelector('[data-job-remove=\"history-0\"]')&&document.querySelector('#drawing-history-feedback').hidden");
    assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);
    const output=process.env.DRAWING_CONTROLS_UI_OUTPUT;
    if(output){
      mkdirSync(output,{recursive:true});
      const capture=async name=>{await js('window.scrollTo(0,0);new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await pause(150);window.webContents.debugger.attach('1.3');try{const {cssContentSize}=await window.webContents.debugger.sendCommand('Page.getLayoutMetrics');const image=await window.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:cssContentSize.width,height:cssContentSize.height,scale:1}});writeFileSync(join(output,name),Buffer.from(image.data,'base64'));}finally{window.webContents.debugger.detach();}};
      await capture('drawing-controls-light.png');await js("document.documentElement.dataset.theme='dark';void 0");await capture('drawing-controls-dark.png');
      window.setContentSize(1200,1000);await pause(120);assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'),true);await capture('drawing-controls-dark-1200.png');
    }
    await js('qaController.abort();void 0');assert.deepEqual(errors,[]);console.log('DRAWING_CONTROLS_UI_PASS isolated fixture UI; no GPU generation');
  }finally{window.destroy();server.closeAllConnections();await new Promise(done=>server.close(done));app.quit();}
}
if(process.env.DRAWING_CONTROLS_UI_CHILD==='1')run().catch(error=>{console.error(error);process.exit(1);});
else test('绘图常用控件、搜索、草稿、重试快照、上传切换与导入直达',{skip:!existsSync(electron),timeout:60000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'drawing-controls-ui-'));t.after(async()=>{assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  await new Promise((done,reject)=>{const env={...process.env,DRAWING_CONTROLS_UI_CHILD:'1',DRAWING_CONTROLS_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,[fileURLToPath(import.meta.url)],{env,windowsHide:true});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const timer=setTimeout(()=>{child.kill();reject(new Error(output));},50000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);code===0&&output.includes('DRAWING_CONTROLS_UI_PASS')?done():reject(new Error(output));});});
});
