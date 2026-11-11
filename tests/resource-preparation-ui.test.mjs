import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {moduleDefinition} from '../framework/registry.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);
async function runBrowser(){
  const {app,BrowserWindow,session}=createRequire(import.meta.url)('electron');app.setPath('userData',process.env.AI_FUTURE_PREPARATION_UI_TEST_PROFILE);app.on('window-all-closed',()=>{});await app.whenReady();
  session.defaultSession.setSpellCheckerEnabled(false);session.defaultSession.setSpellCheckerLanguages([]);
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){res.setHeader('content-type','text/html;charset=utf-8');res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/companion.css"><style>body{padding:28px}#root{max-width:1100px;margin:auto}</style><div id="root"></div><script type="module">let module={};try{module=await import('/resource-preparation.js');}catch{}window.preparationModule=module;window.mountCompanion=(await import('/modules/companion.js')).mount;window.mountSkin=(await import('/skin-studio.js')).mount;window.Drafts=(await import('/drafts.js')).Drafts;window.skinDefinition=${JSON.stringify(moduleDefinition('mc-skin'))};window.ready=true;</script></html>`);return;}
    try{const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));}catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  // 本测试不涉及拼写检查，避免后台词典下载在退出时仍占用临时资料目录。
  const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,spellcheck:false}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError/.test(event.message))errors.push(event.message);});
  const js=async source=>{try{return await window.webContents.executeJavaScript(source);}catch(error){throw new Error(error.message+'\n'+source+'\n'+errors.join('\n'));}},pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async source=>{const end=Date.now()+5000;while(Date.now()<end){if(await js(source))return;await pause(20);}throw new Error('等待超时：'+source);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.ready');
    assert.equal(await js("typeof preparationModule.mountResourcePreparation"),'function');
    await js(`window.fixture={copies:[],targets:[],controller:new AbortController(),python:'E:\\\\工具\\\\python.exe'};fixture.view=preparationModule.mountResourcePreparation(document.querySelector('#root'),{signal:fixture.controller.signal},{...preparationModule.preparationFor('mc-skin'),onTarget:async target=>{fixture.targets.push(target);return false;},commandFor:()=>preparationModule.pythonInstallCommand(fixture.python,['Pillow']),copy:async text=>{fixture.copies.push(text);}});void 0`);
    assert.equal(await js('fixture.copies.length'),0);
    assert.equal(await js("document.querySelector('details').open"),false);
    await click('summary');await click('[data-preparation-target]');
    assert.deepEqual(await js('fixture.targets'),['pythonPath']);
    assert.equal(await js('fixture.copies.length'),0);
    await click('[data-preparation-command]');await wait('fixture.copies.length===1');
    assert.ok((await js('fixture.copies[0]')).startsWith("& 'E:"));
    await js("fixture.python='';void 0");await click('[data-preparation-command]');await wait("document.querySelector('[data-preparation-feedback]').classList.contains('error')");
    assert.equal(await js('fixture.copies.length'),1);
    await click('summary');assert.equal(await js("document.querySelector('details').open"),false);
    await js('fixture.view.expand();void 0');assert.equal(await js("document.querySelector('details').open"),true);
    await js("fixture.controller.abort();fixture.python='E:\\\\Python\\\\python.exe';void 0");await click('[data-preparation-command]');await pause(20);assert.equal(await js('fixture.copies.length'),1);
    await js(`fixture.controller=new AbortController();preparationModule.mountResourcePreparation(document.querySelector('#root'),{signal:fixture.controller.signal},preparationModule.preparationFor('training-models'));void 0`);
    assert.equal(await js("document.querySelector('[data-preparation-source-link]').hasAttribute('href')"),false);
    await js("document.querySelector('[data-preparation-source]').value='0';document.querySelector('[data-preparation-source]').dispatchEvent(new Event('change'));void 0");
    assert.equal(await js("document.querySelector('[data-preparation-source-link]').href"),'https://github.com/OpenMOSS/MOSS-Image');
    await js(`fixture.controller.abort();fixture.controller=new AbortController();fixture.calls=[];fixture.skin={runtime:{available:false,error:'尚未准备 Python 与 Pillow',missingComponents:[{name:'Python'},{name:'Pillow'}]},jobs:[],templates:[]};fixture.skinCtx={signal:fixture.controller.signal,ui:{},drafts:new Drafts(),state:{modules:[{...skinDefinition,enabled:true,config:{pythonPath:'',workspacePath:'',skinPath:''}}],events:[]},notify:()=>{},refresh:async()=>{},action:async(_button,job)=>job(),api:async(path,options={})=>{fixture.calls.push({path,...options});if(path.endsWith('/state'))return structuredClone(fixture.skin);if(path.startsWith('/api/environment/state?'))return {attempted:true,result:{candidates:[],issues:[],warnings:[]}};return {};}};mountSkin(document.querySelector('#root'),fixture.skinCtx);void 0`);
    await wait("document.querySelector('#skin-runtime-status')?.textContent.includes('缺少')");
    assert.equal(await js("!!document.querySelector('#skin-prepare-runtime')?.checkVisibility()"),true,'缺少 Python/Pillow 时有可操作的准备入口');
    if(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT){await mkdir(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT,{recursive:true});await js("document.querySelector('#skin-prepare-runtime').scrollIntoView({block:'center'});void 0");for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await writeFile(join(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT,'skin-missing-environment-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());}await js("document.documentElement.dataset.theme='light';scrollTo(0,0);void 0");}
    await js("document.querySelector('#skin-instruction').value='保留我的皮肤草稿';document.querySelector('#skin-instruction').dispatchEvent(new Event('input',{bubbles:true}));void 0");
    await click('#skin-prepare-runtime');
    assert.equal(await js("document.querySelector('#tab-config').getAttribute('aria-selected')"),'true');
    assert.equal(await js("document.querySelector('#skin-config-panel .resource-preparation').open"),true);
    assert.equal(await js("document.querySelector('#skin-config-panel .resource-preparation a').checkVisibility()"),true);
    assert.equal(await js("fixture.calls.some(call=>/\\/(config|start|install|jobs|download|downloads)$/.test(call.path))"),false,'打开指引不保存配置或执行外部任务');
    if(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT){await mkdir(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT,{recursive:true});for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);await writeFile(join(process.env.MODEL_DOWNLOAD_ENTRIES_UI_OUTPUT,'skin-prepare-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());}await js("document.documentElement.dataset.theme='light';void 0");}
    await click('#tab-overview');
    assert.equal(await js("document.querySelector('#skin-instruction').value"),'保留我的皮肤草稿');
    await js("fixture.skin.runtime={available:true,missingComponents:[]};void 0");await click('#skin-refresh');await wait("document.querySelector('#skin-runtime-status')?.textContent==='MC 皮肤工具已就绪'");
    assert.equal(await js("document.querySelector('#skin-prepare-runtime').hidden"),true,'环境就绪后收起补全入口');
    await js(`fixture.controller.abort();fixture.controller=new AbortController();fixture.calls=[];fixture.cancelPath=true;fixture.saved='';fixture.runtime={status:'stopped',source:{installPath:'',available:false},runtime:{restartRequired:true}};fixture.ctx={signal:fixture.controller.signal,state:{preferences:{theme:'light'},modules:[],events:[]},ui:{},characters:{getSelected:()=>null},refresh:async()=>{},action:async(_button,job)=>job(),api:async(path,{body}={})=>{fixture.calls.push({path,body});if(path.endsWith('/resources'))return {prerequisitesReady:true};if(path.endsWith('/state'))return structuredClone(fixture.runtime);if(path.endsWith('/start')){if(!fixture.saved)throw new Error('未找到兼容运行组件');fixture.runtime={status:'running',source:{installPath:fixture.saved},runtime:{model:{available:false}}};return structuredClone(fixture.runtime);}if(path.endsWith('/config')){fixture.saved=body.values.airiPath;return {};}if(path==='/api/paths/choose')return fixture.cancelPath?{cancelled:true,path:null}:{cancelled:false,path:'E:\\\\AIRI-0.12.0-beta.5'};return {};}};mountCompanion(document.querySelector('#root'),fixture.ctx)`);
    await wait("!!document.querySelector('#companion-install')");
    await pause(1200);assert.equal(await js("!!document.querySelector('#companion-install')"),true,'失败恢复表单不能被停止状态轮询清空');
    await click('[data-path-field="airiPath"]');await pause(20);assert.equal(await js("document.querySelector('#companion-install').value"),'');assert.equal(await js('fixture.saved'),'');
    await js('fixture.cancelPath=false;fixture.runtime.runtime.restartRequired=false;void 0');
    await click('[data-path-field="airiPath"]');await wait("document.querySelector('#companion-install').value!==''");
    assert.equal(await js('fixture.saved'),'');
    await click('#companion-install-form button[type="submit"]');await wait("fixture.saved!==''");
    await js("fixture.controller.abort();fixture.controller=new AbortController();fixture.ctx.signal=fixture.controller.signal;fixture.saved='';fixture.runtime={status:'idle',source:{installPath:'',available:false},runtime:{restartRequired:false}};mountCompanion(document.querySelector('#root'),fixture.ctx)");
    await click('[data-companion-start]');await wait("!!document.querySelector('#companion-retry')");
    await click('[data-path-field="airiPath"]');await wait("document.querySelector('#companion-install').value!==''");
    await click('#companion-install-form button[type="submit"]');await wait("fixture.saved!==''");
    const screenshots=join(root,'artifacts','qa-resource-preparation');await mkdir(screenshots,{recursive:true});await pause(50);
    await writeFile(join(screenshots,'companion-recovery-light.png'),(await window.webContents.capturePage()).toPNG());
    await js("document.documentElement.dataset.theme='dark';void 0");await pause(40);
    await writeFile(join(screenshots,'companion-recovery-dark.png'),(await window.webContents.capturePage()).toPNG());
    assert.equal(await js('document.documentElement.scrollWidth>innerWidth'),false);
    await click('#companion-retry');await wait("document.querySelector('#companion-stage-empty')!==null");
    assert.equal(await js('fixture.runtime.status'),'running');
    await js('fixture.controller.abort();void 0');
    console.log('RESOURCE_PREPARATION_UI_RESULT '+JSON.stringify({checks:17,scope:'真实 Electron DOM；不安装依赖、不打开真实陪伴运行端'}));
  }finally{window.destroy();await session.defaultSession.closeAllConnections();server.closeAllConnections();await new Promise(done=>server.close(done));}
}
if(process.argv.includes('--resource-preparation-ui'))runBrowser().then(()=>createRequire(import.meta.url)('electron').app.quit(),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('依赖准备按用户点击复制，取消选择无副作用，卸载后不再操作',{skip:!electron,timeout:20000},async t=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const profile=await mkdtemp(join(tmpdir(),'resource-preparation-ui-'));env.AI_FUTURE_PREPARATION_UI_TEST_PROFILE=profile;const child=spawn(electron,[fileURLToPath(import.meta.url),'--resource-preparation-ui'],{cwd:root,env,windowsHide:true});
  let closed=false;const closure=new Promise(done=>child.once('close',code=>{closed=true;done(code);}));
  t.after(async()=>{if(!closed)child.kill();await closure;assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);const code=await new Promise((done,reject)=>{child.once('error',reject);closure.then(done);});assert.equal(code,0,output);assert.match(output,/RESOURCE_PREPARATION_UI_RESULT/);
});
