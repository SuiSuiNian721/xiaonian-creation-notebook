import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname,extname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function runBrowser(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.setPath('userData',process.env.AI_FUTURE_COMPANION_RESOURCE_TEST_PROFILE);
  app.on('window-all-closed',()=>{});await app.whenReady();
  const staticRoot=join(root,'public-workbench');
  const server=createServer(async(req,res)=>{
    if(req.url==='/test'){
      res.setHeader('content-type','text/html;charset=utf-8');
      res.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/companion.css"><style>body{padding:28px}#root{max-width:1100px;margin:auto}</style><div id="root"></div><script type="module">import {mount} from '/modules/companion.js';import {Drafts} from '/drafts.js';window.mountCompanion=mount;window.Drafts=Drafts;window.ready=true;</script>`);return;
    }
    try{
      const path=resolve(staticRoot,'.'+decodeURIComponent(req.url.split('?')[0]));assert.ok(path.startsWith(staticRoot+sep));
      res.setHeader('content-type',extname(path)==='.css'?'text/css':'text/javascript');res.end(await readFile(path));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const window=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async source=>{const end=Date.now()+5000;while(Date.now()<end){if(await js(source))return;await pause(20);}throw new Error('等待超时：'+source);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  try{
    await window.loadURL(`http://127.0.0.1:${server.address().port}/test`);await wait('window.ready');
    await js(`window.fixture={calls:[],ui:{},drafts:new Drafts(),saved:'',deferSave:false};fixture.runtime=()=>({status:fixture.started?'running':'idle',source:{available:!!fixture.saved,installPath:fixture.saved},runtime:{model:{available:false}}});fixture.api=async(path,options={})=>{fixture.calls.push({path,body:options.body});if(path.endsWith('/resources'))return {prerequisitesReady:true};if(path.endsWith('/state'))return fixture.runtime();if(path==='/api/environment/scan')return {candidates:[{id:'runtime-a',label:'陪伴运行组件',path:'E:\\\\AIRI-A',selectable:true,values:{airiPath:'E:\\\\AIRI-A'}}]};if(path.endsWith('/config')){const submitted=options.body.values.airiPath;if(fixture.deferSave)await new Promise(done=>fixture.releaseSave=done);fixture.saved=submitted;return {config:{airiPath:submitted}};}if(path.endsWith('/start')){fixture.started=true;return fixture.runtime();}return {};};fixture.remount=async()=>{fixture.controller?.abort();fixture.controller=new AbortController();fixture.ctx={signal:fixture.controller.signal,ui:fixture.ui,drafts:fixture.drafts,state:{preferences:{theme:'light'},modules:[{id:'companion',name:'虚拟陪伴',enabled:true,discovery:{name:'陪伴运行组件'}}],events:[]},characters:{getSelected:()=>null},api:fixture.api,refresh:async()=>{},action:async(_button,job)=>job()};await mountCompanion(document.querySelector('#root'),fixture.ctx);};fixture.remount()`);
    assert.equal(await js("!!document.querySelector('#companion-install')"),true,'打开前就能配置运行组件');
    assert.equal(await js("document.querySelector('[data-companion-preparation] details').open"),true,'没有配置运行端时直接展开官方准备渠道');
    assert.equal(await js("document.querySelector('[data-companion-preparation] a').href"),'https://github.com/moeru-ai/airi/releases/tag/v0.12.0-beta.5');
    await wait("!!document.querySelector('[data-environment-select]')");
    if(process.env.AI_FUTURE_COMPANION_RESOURCE_UI_OUTPUT){const output=resolve(process.env.AI_FUTURE_COMPANION_RESOURCE_UI_OUTPUT);await mkdir(output,{recursive:true});for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);await pause(60);await writeFile(join(output,'companion-first-setup-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());}await js("document.documentElement.dataset.theme='light';void 0");}
    await js("fixture.ui.environmentDiscovery.companion.result.candidates[0].label='AIRI · Legacy';fixture.remount()");
    assert.doesNotMatch(await js("document.querySelector('[data-environment-results]').querySelector('strong').textContent"),/AIRI/i,'旧检索记录也用功能名称展示');
    assert.equal(await js("document.querySelector('[data-environment-results] .environment-path').textContent"),'E:\\AIRI-A','真实目录保持原样');
    assert.equal(await js("fixture.calls.filter(call=>call.path.endsWith('/start')).length"),0);
    await click('[data-environment-select]');
    assert.equal(await js("document.querySelector('#companion-install').value"),'E:\\AIRI-A');
    assert.equal(await js('fixture.saved'),'');
    await js('fixture.remount()');await wait("!!document.querySelector('[data-environment-select]')");
    assert.equal(await js("fixture.calls.filter(call=>call.path==='/api/environment/scan').length"),1,'切回模块复用本次扫描');
    assert.equal(await js("document.querySelector('#companion-install').value"),'E:\\AIRI-A','未保存的手工草稿跨切换保留');
    assert.equal(await js("document.querySelector('[data-companion-preparation] details').open"),false,'已有路径草稿时不重复展开准备指引');
    await js("fixture.originalApi=fixture.api;fixture.api=async(path,options)=>{const result=await fixture.originalApi(path,options);if(path==='/api/environment/scan')result.candidates=Array.from({length:6},(_,index)=>({...result.candidates[0],id:'runtime-'+index}));return result;};fixture.remount()");
    await click('[data-environment-rescan]');await wait("document.querySelectorAll('[data-environment-select]').length===6");
    assert.equal(await js("(()=>{const viewport=document.querySelector('#companion-viewport').getBoundingClientRect(),heading=document.querySelector('.companion-start h2').getBoundingClientRect(),save=document.querySelector('#companion-install-form button[type=submit]').getBoundingClientRect();return heading.top>=viewport.top&&save.bottom<=viewport.bottom;})()"),true,'多候选和保存位置都不被固定舞台裁切');
    if(process.env.AI_FUTURE_COMPANION_RESOURCE_UI_OUTPUT){
      const output=resolve(process.env.AI_FUTURE_COMPANION_RESOURCE_UI_OUTPUT);await mkdir(output,{recursive:true});
      window.setSize(1280,1500);await pause(50);
      for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await pause(50);await writeFile(join(output,'companion-resources-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());}
      window.setSize(1280,900);
    }
    await js("fixture.deferSave=true;document.querySelector('#companion-install-form').requestSubmit();void 0");await wait('!!fixture.releaseSave');
    await js("document.querySelector('#companion-install').value='E:\\\\手工组件';document.querySelector('#companion-install').dispatchEvent(new Event('input',{bubbles:true}));fixture.releaseSave();void 0");
    await wait("fixture.saved!==''");
    assert.equal(await js("document.querySelector('#companion-install').value"),'E:\\手工组件','迟到保存不覆盖新编辑');
    await js('fixture.remount()');await wait("!!document.querySelector('#companion-install')");
    assert.equal(await js("document.querySelector('#companion-install').value"),'E:\\手工组件');
    await js("fixture.deferSave=false;document.querySelector('#companion-install-form').requestSubmit();void 0");await wait("fixture.saved==='E:\\\\手工组件'");
    await click('[data-companion-start]');await wait("!!document.querySelector('#companion-stage-empty')");
    assert.equal(await js("fixture.calls.filter(call=>call.path.endsWith('/start')).length"),1);
    await js('fixture.controller.abort();void 0');
    console.log('COMPANION_RESOURCE_UI_RESULT '+JSON.stringify({checks:14,scope:'真实 Electron DOM；运行端与配置接口为隔离 fixture，不启动陪伴'}));
  }finally{window.destroy();server.close();}
}

if(process.argv.includes('--companion-resource-ui'))runBrowser().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('陪伴运行组件候选可见、显式保存并保留后续手工修改',{skip:!electron,timeout:20000},async t=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const profile=await mkdtemp(join(tmpdir(),'companion-resource-ui-'));env.AI_FUTURE_COMPANION_RESOURCE_TEST_PROFILE=profile;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--companion-resource-ui'],{cwd:root,env,windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill();});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
  assert.ok(resolve(profile).startsWith(resolve(tmpdir())+sep));await rm(profile,{recursive:true,force:true});
  assert.equal(code,0,output);assert.match(output,/COMPANION_RESOURCE_UI_RESULT/);
});
