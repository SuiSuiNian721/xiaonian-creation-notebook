import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

function setup(){
  const fixture=window.captionTest={draft:{purpose:'character',trigger:'my_character',modelTrainType:'moss-image-lora',effectiveCaptionFormat:'tags',captionerPreparation:{id:'florence2',status:'missing'}},changes:[],prepares:[],cancels:[],controller:new AbortController()};
  fixture.mount=()=>fixture.component=window.mountTrainingCaptionSettings(document.querySelector('#root'),{signal:fixture.controller.signal},{getValue:()=>fixture.draft,onChange:patch=>{fixture.changes.push(structuredClone(patch));Object.assign(fixture.draft,patch);},onPrepareCaptioner:async({captioner})=>{fixture.prepares.push(captioner);if(fixture.prepareError)throw new Error(fixture.prepareError);fixture.draft.captionerPreparation={id:captioner,status:'preparing',progress:12};},onCancelCaptioner:async({captioner})=>{fixture.cancels.push(captioner);fixture.draft.captionerPreparation={id:captioner,status:'missing'};}});
  fixture.mount();window.mounted=true;
}

async function runBrowser(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.setPath('userData',process.env.AI_FUTURE_CAPTION_UI_TEST_PROFILE);app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench'),server=createServer(async(req,res)=>{
    if(req.url==='/test'){res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/training.css"><style>body{padding:32px}main{max-width:760px;margin:auto}.panel-heading{margin-bottom:8px}</style><main class="panel glass training-pipeline-form"><div class="panel-heading"><h2>训练图集打标</h2></div><form id="fixture-form"><div id="root"></div></form></main><script type="module">import {mountTrainingCaptionSettings} from '/training-caption-settings.js';window.mountTrainingCaptionSettings=mountTrainingCaptionSettings;(${setup.toString()})();</script></html>`);return;}
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1120,height:1050,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}}),errors=[];
  window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(source)=>{const end=Date.now()+7000;while(Date.now()<end){if(await js(source))return;await pause(40);}throw new Error('等待超时：'+source+'\n'+errors.join('\n'));};
  const change=(selector,value,event='change')=>js(`{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));}void 0`);
  const capture=async(name)=>{const output=process.env.AI_FUTURE_CAPTION_UI_OUTPUT;if(!output)return;mkdirSync(output,{recursive:true});for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme='${theme}';new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);await pause(100);writeFileSync(join(output,`${name}-${theme}.png`),(await window.webContents.capturePage()).toPNG());}};
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.mounted');
    assert.equal(await js("document.querySelector('[data-caption-source]').value"),'local');
    assert.equal(await js("document.querySelector('[data-captioner]').options.length"),12);
    assert.equal(await js("document.querySelector('[data-captioner]').value"),'auto');
    assert.match(await js("document.querySelector('[data-captioner] option[value=auto]').textContent"),/自动匹配.*Florence-2/);
    assert.equal(await js("document.querySelector('[data-captioner]').checkVisibility()"),true,'自然语言底模也能查看和更换打标器');
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),true);
    assert.equal(await js("document.querySelectorAll('[data-caption-option]').length"),10);
    assert.equal(await js("document.querySelector('[data-caption-native-options]').open"),false);
    assert.deepEqual(await js('captionTest.changes'),[],'渲染默认参数不能擅自写回草稿');
    assert.deepEqual(await js('captionTest.prepares'),[],'读取推荐与状态不会自动下载');
    assert.equal(await js("document.querySelector('[data-caption-option=threshold]').value"),'0.35');
    await capture('caption-auto-florence');
    await js("document.querySelector('[data-caption-prepare]').click();void 0");
    await wait("document.querySelector('[data-caption-download-status]').textContent.includes('12%')");
    assert.deepEqual(await js('captionTest.prepares'),['florence2']);
    assert.equal(await js("document.querySelector('[data-caption-prepare]').disabled"),true);
    assert.equal(await js("document.querySelector('[data-caption-cancel]').hidden"),false);
    await capture('caption-download-progress');
    await js("document.querySelector('[data-caption-cancel]').click();void 0");
    await wait("document.querySelector('[data-caption-prepare]').disabled===false");
    assert.deepEqual(await js('captionTest.cancels'),['florence2']);
    await js("captionTest.prepareError='测试下载失败，可重试';document.querySelector('[data-caption-prepare]').click();void 0");
    await wait("document.querySelector('[data-caption-download-status]').textContent.includes('测试下载失败')");
    assert.equal(await js("document.querySelector('[data-caption-prepare]').textContent"),'重试下载');
    await js("captionTest.prepareError='';captionTest.draft.captionerPreparation={id:'florence2',status:'ready'};captionTest.component.refresh();void 0");
    assert.equal(await js("document.querySelector('[data-caption-prepare]').disabled"),true);
    assert.equal(await js("document.querySelector('[data-caption-download-status]').classList.contains('error')"),false,'后续检查确认就绪后清除旧下载错误');
    await change('[data-captioner]','cl_tagger_1_01');
    assert.equal(await js('captionTest.draft.captioner'),'cl_tagger_1_01');
    assert.equal(await js('captionTest.draft.taggerModel'),'cl_tagger_1_01','手动标签模型同时兼容旧taggerModel字段');
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),false);
    assert.equal(await js("document.querySelector('[data-caption-prepare]').disabled"),false,'Florence已就绪状态不能借给新选中的标签模型');
    assert.equal(await js("document.querySelector('[data-caption-download-status]').textContent"),'');
    await js("captionTest.draft.captionerPreparation={id:'florence2',status:'preparing',progress:60};captionTest.component.refresh();void 0");
    assert.equal(await js("document.querySelector('[data-caption-download-status]').textContent"),'','其他模型的进度不覆盖当前模型');
    assert.equal(await js("document.querySelector('[data-caption-cancel]').hidden"),true);
    await js("captionTest.draft.modelTrainType='flux-lora';captionTest.component.refresh();void 0");
    assert.equal(await js("document.querySelector('[data-captioner]').value"),'cl_tagger_1_01','切换底模保留手动选择');
    await change('[data-caption-option=threshold]','0.42','input');
    await change('[data-caption-option=download_endpoint]','https://hf-mirror.com');
    await change('[data-caption-option=batch_output_action_on_conflict]','append');
    await js("document.querySelector('[data-caption-option=add_rating_tag]').click();document.querySelector('[data-caption-native-options]').open=true;void 0");
    assert.equal(await js('captionTest.draft.taggerOptions.threshold'),0.42);
    assert.equal(await js('captionTest.draft.taggerOptions.add_rating_tag'),true);
    assert.equal(await js('captionTest.draft.taggerOptions.batch_output_action_on_conflict'),'append');
    assert.equal(await js('captionTest.draft.taggerOptions.download_endpoint'),'https://hf-mirror.com');
    await change('[data-caption-option=threshold]','','input');
    assert.equal(await js("document.querySelector('#fixture-form').checkValidity()"),false,'空阈值应阻止提交');
    await change('[data-caption-source]','connected');
    assert.equal(await js("document.querySelector('#fixture-form').checkValidity()"),true,'隐藏本地参数不应阻止 AI 打标');
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),true);
    assert.equal(await js("document.querySelector('[data-caption-ai]').hidden"),false);
    assert.match(await js("document.querySelector('[data-caption-preset]').textContent"),/角色身份/);
    await change('[data-caption-ai-supplement]','保留头部配饰与双手接触关系','input');
    await js("captionTest.draft.purpose='pose';captionTest.component.refresh();void 0");
    assert.match(await js("document.querySelector('[data-caption-preset]').textContent"),/姿势与动作/);
    assert.match(await js("document.querySelector('[data-caption-prompt-preview]').textContent"),/保留头部配饰与双手接触关系/);
    assert.match(await js("document.querySelector('[data-caption-prompt-preview]').textContent"),/逗号分隔标签/);
    await capture('caption-connected');
    await change('[data-caption-source]','local');
    assert.equal(await js("document.querySelector('[data-captioner]').value"),'cl_tagger_1_01');
    assert.equal(await js("document.querySelector('[data-caption-native-options]').open"),true);
    await change('[data-caption-option=threshold]','0.42','input');
    await capture('caption-local-tags');
    await change('[data-captioner]','auto');
    await js("captionTest.draft.effectiveCaptionFormat='natural';captionTest.component.refresh();void 0");
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),true);
    assert.equal(await js("document.querySelector('[data-captioner]').checkVisibility()"),true);
    assert.match(await js("document.querySelector('[data-captioner] option[value=auto]').textContent"),/Florence-2/);
    await js("captionTest.draft.modelTrainType='sdxl-lora';captionTest.component.refresh();void 0");
    assert.equal(await js("document.querySelector('[data-captioner]').value"),'auto');
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),false,'自动选择随底模切换到标签模型');
    await change('[data-captioner]','florence2');
    assert.equal(await js("document.querySelector('[data-caption-local-tags]').hidden"),true,'标签底模也允许手动改成Florence-2');
    assert.equal(await js("document.querySelector('[data-captioner]').value"),'florence2');
    await change('[data-caption-source]','connected');
    assert.match(await js("document.querySelector('[data-caption-prompt-preview]').textContent"),/英文自然语言/);
    assert.equal(await js("document.querySelector('[data-caption-ai-supplement]').value"),'保留头部配饰与双手接触关系');
    await js('captionTest.component.setDisabled(true);void 0');
    assert.equal(await js("[...document.querySelectorAll('#root input,#root select,#root textarea')].every(node=>node.disabled)"),true);
    const disabledCount=await js('captionTest.changes.length');
    await change('[data-caption-source]','local');
    assert.equal(await js('captionTest.changes.length'),disabledCount,'禁用状态忽略程序触发的编辑事件');
    await js('captionTest.component.setDisabled(false);captionTest.component.refresh();void 0');
    assert.equal(await js("document.querySelector('[data-caption-source]').value"),'connected');
    assert.equal(await js("document.querySelector('[data-caption-ai-supplement]').disabled"),false);
    assert.equal(await js("document.querySelector('[data-caption-option=threshold]').disabled"),true);
    await js('captionTest.component.dispose();captionTest.mount();void 0');
    assert.equal(await js("document.querySelector('[data-caption-ai-supplement]').value"),'保留头部配饰与双手接触关系','重新挂载后继续展示保存的补充');
    assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth'),true);
    assert.equal(await js("[...document.querySelectorAll('#root input,#root select,#root textarea')].every(node=>node.labels.length>0)"),true,'输入控件都有显式标签');
    const before=await js('captionTest.changes.length');await js('captionTest.controller.abort();void 0');
    await change('[data-caption-source]','local');assert.equal(await js('captionTest.changes.length'),before,'离开页面后清除事件监听');
    assert.deepEqual(errors,[]);console.log('TRAINING_CAPTION_UI_RESULT '+JSON.stringify({scope:'真实 Electron DOM；自动推荐、手动覆盖、下载状态与取消为模拟接口；无模型调用或下载'}));
  }finally{window.destroy();server.close();}
}

if(process.argv.includes('--caption-ui-electron'))runBrowser().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('打标设置：来源、原生参数、用途提示词、草稿、隐藏校验与生命周期',{skip:!electron,timeout:30000},async t=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const profile=await mkdtemp(join(tmpdir(),'caption-ui-'));env.AI_FUTURE_CAPTION_UI_TEST_PROFILE=profile;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--caption-ui-electron'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null)child.kill();assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/TRAINING_CAPTION_UI_RESULT/);
});
