import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createWorkbench} from '../framework/server.mjs';
import {installCharacterPackages} from './helpers/character-packages.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const electron=[process.env.AI_FUTURE_ELECTRON,join(root,'node_modules/electron/dist/electron.exe'),'F:\\小汐的研究日志\\node_modules\\electron\\dist\\electron.exe'].filter(Boolean).find(existsSync);

async function run(){
  const {app,BrowserWindow}=createRequire(import.meta.url)('electron');
  app.disableHardwareAcceleration();app.setPath('userData',join(process.env.AI_FUTURE_VISION_UI_DIR,'profile'));
  app.on('window-all-closed',()=>{});await app.whenReady();
  let state={package:{name:'千问视觉扩展包',model:'Qwen3.5 4B',quantization:'Q4_K_M',downloadBytes:3451022650,installedBytes:3519316093,peakDiskBytes:3556977239,requirements:['Windows x64','建议 16 GB 内存；显存占用随上下文变化。'],links:[{label:'Qwen 原模型',url:'https://huggingface.co/Qwen/Qwen3.5-4B'}]},supported:true,installed:false,directory:'E:\\工作台资料\\resources\\vision',canChooseDirectory:true,task:null,runtime:{status:'stopped'},autoStart:false};
  const calls=[];
  const controller={ready:Promise.resolve(),state:()=>structuredClone(state),
    install:()=>{calls.push('install');state.task={id:'test-install',status:'running',stage:'下载模型',completedBytes:1,totalBytes:100};return structuredClone(state);},
    start:input=>{calls.push('start:'+input.device);state.runtime={status:'starting'};return structuredClone(state);},
    cancel:()=>{calls.push('cancel');state.task={...state.task,status:'cancelled'};return structuredClone(state);},
    stop:()=>{calls.push('stop');state.runtime={status:'stopped'};return structuredClone(state);},
    chooseDirectory:()=>{state.directory='E:\\新的视觉目录';return structuredClone(state);},
    connection:()=>({media:{localVisionEnabled:true,localVisionBaseUrl:'http://127.0.0.1:54321/v1',localVisionModel:'workbench-qwen-vision',localVisionKey:'fixture-managed-key',clearLocalVisionKey:false}}),close:async()=>{}};
  const backend=await createWorkbench({dataDir:join(process.env.AI_FUTURE_VISION_UI_DIR,'data'),visionOptions:{controller}});
  const api=async(path,body)=>{const response=await fetch(backend.url+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});assert.ok(response.ok,await response.clone().text());return response.json();};
  await installCharacterPackages(backend.url);
  const character=(await api('/api/characters',{name:'视觉扩展测试角色'})).character;
  const window=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true}});
  const errors=[];window.webContents.on('console-message',event=>{if(/Uncaught|TypeError|ReferenceError|SyntaxError/.test(event.message))errors.push(event.message);});
  const js=source=>window.webContents.executeJavaScript(source),pause=ms=>new Promise(done=>setTimeout(done,ms));
  const wait=async(label,source)=>{const end=Date.now()+9000;while(Date.now()<end){if(await js(source))return;await pause(35);}throw new Error('等待超时：'+label);};
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const input=(name,value)=>js(`(()=>{const n=document.querySelector('[name='+CSS.escape(${JSON.stringify(name)})+']');if(n.type==='checkbox')n.checked=${JSON.stringify(value)};else n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const field=name=>js(`document.querySelector('[name='+CSS.escape(${JSON.stringify(name)})+']').value`);
  const shot=async name=>{const output=join(root,'artifacts','vision-extension');await mkdir(output,{recursive:true});await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');await pause(100);await writeFile(join(output,name+'.png'),(await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG());};
  const visible=selector=>`(()=>{const n=document.querySelector(${JSON.stringify(selector)});return !!n&&!n.hidden&&n.getClientRects().length>0})()`;
  try{
    await window.loadURL(backend.url+'#/characters');
    await wait('角色列表加载',`!!document.querySelector('[data-character-life-id]')`);
    await js(`(async()=>{const {openCharacterLife}=await import('/character-life.js');const {Drafts}=await import('/drafts.js');window.visionUI={openCharacterLife,drafts:new Drafts(),calls:[],delayConnection:false};const f=window.visionUI;f.controller=new AbortController();f.ctx={signal:f.controller.signal,state:{selectedCharacterId:${JSON.stringify(character.id)},characters:[${JSON.stringify(character)}],modules:[]},drafts:f.drafts,refresh:async()=>{},fetch:async(url,options={})=>{f.calls.push(url);const response=await fetch(url,options);if(url.endsWith('/vision-extension/connection')&&f.delayConnection){f.delayConnection=false;await new Promise(done=>f.releaseConnection=done);}return response;}};f.open=()=>openCharacterLife(f.ctx,{moduleId:'qq'});f.open();})()`);
    await wait('人设面板',`!!document.querySelector('[data-life-panel="profile"]')`);
    await click('[data-life-tab="media"]');
    await wait('可选安装入口',visible('[data-vision-action="install"]'));
    assert.match(await js(`document.querySelector('[data-life-local-vision]').textContent`),/视觉语言模型/);
    assert.match(await js(`document.querySelector('[data-life-vision-extension]').textContent`),/Qwen3.5 4B/);
    assert.equal(await js(`document.querySelectorAll('[data-life-tab]:not([hidden])').length`),3);
    assert.equal(await js(`(()=>{const action=document.querySelector('[data-vision-action="install"]').getBoundingClientRect(),view=document.querySelector('.life-main').getBoundingClientRect();return action.top>=view.top&&action.bottom<=view.bottom})()`),true,'主操作无需滚动即可看到');
    await shot('ui-lite-1440');
    await click('[data-vision-action="choose-directory"]');await wait('选择目录',`document.querySelector('[data-vision-directory]').textContent.includes('新的视觉目录')`);
    await click('[data-vision-action="install"]');await wait('安装进度',visible('[data-vision-action="cancel"]'));
    assert.ok(calls.includes('install'));
    await input('media.localVisionEnabled',true);await input('media.localVisionBaseUrl','http://127.0.0.1:9999/v1');await input('media.localVisionModel','my-new-draft');
    state.installed=true;state.task.status='completed';state.runtime={status:'running'};
    await wait('安装就绪',visible('[data-vision-action="connection"]'));
    assert.equal(await field('media.localVisionModel'),'my-new-draft','安装完成不能覆盖更新后的输入');
    await click('[data-vision-action="connection"]');await wait('明确填入',`document.querySelector('[name="media.localVisionModel"]').value==='workbench-qwen-vision'`);
    assert.equal(await field('media.localVisionKey'),'fixture-managed-key');
    assert.equal((await api('/api/characters/'+character.id+'/life')).settings.media.localVisionEnabled,false,'填入不能自动保存');
    await click('[data-life-save]');await wait('媒体保存',`document.querySelector('[data-life-feedback]').textContent.startsWith('已保存')&&!document.querySelector('[data-life-save]').disabled`);
    assert.equal((await api('/api/characters/'+character.id+'/life')).settings.media.localVisionModel,'workbench-qwen-vision');
    await wait('重新读取扩展状态',visible('[data-vision-action="stop"]'));await click('[data-vision-action="stop"]');await wait('停止',visible('[data-vision-action="start"]'));
    await click('[data-vision-action="start"]');await wait('启动中',`document.querySelector('[data-vision-status]').textContent.includes('启动')`);
    state.runtime={status:'running'};
    await wait('启动后填入',`document.querySelector('[data-vision-feedback]').textContent.includes('已填入')`);
    await js('visionUI.delayConnection=true;void 0');await click('[data-vision-action="connection"]');await wait('延迟连接',`!!visionUI.releaseConnection`);
    await input('media.localVisionModel','typed-during-connection');await js('visionUI.releaseConnection();void 0');
    await wait('旧连接忽略',`document.querySelector('[data-vision-feedback]').textContent.includes('未覆盖')`);
    assert.equal(await field('media.localVisionModel'),'typed-during-connection');
    await click('[data-life-mode="full"]');await wait('完整版',`document.querySelector('[data-life-mode="full"]').getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-life-save]').disabled`);
    await wait('完整版扩展包',visible('[data-vision-action="connection"]'));
    assert.equal(await field('media.localVisionModel'),'typed-during-connection');
    window.setSize(1100,900);await js(`document.documentElement.dataset.theme='dark';void 0`);await shot('ui-full-dark-1100');
    assert.equal(await js(`(()=>{const n=document.querySelector('[data-life-panel="media"]');return n.scrollWidth<=n.clientWidth+1})()`),true);
    await click('[data-vision-action="stop"]');await wait('再次停止',visible('[data-vision-action="start"]'));
    state.runtime={status:'failed',error:'显存不足，请关闭其他占用或使用 CPU。'};
    state.task={id:'failed-start',status:'failed',stage:'starting',error:'上次安装启动失败：显存不足。'};
    await wait('失败恢复入口',visible('[data-vision-action="cpu"]'));
    assert.equal(await js(visible('[data-vision-action="stop"]')),true,'启动失败后仍可重试停止残留进程');
    await click('[data-vision-action="cpu"]');await wait('CPU启动请求',`document.querySelector('[data-vision-status]').textContent==='正在启动'`);assert.ok(calls.includes('start:cpu'));
    state.runtime={status:'running'};await wait('CPU恢复成功',visible('[data-vision-action="connection"]'));
    assert.equal(await js(`document.querySelector('[data-vision-error]').hidden`),true,'CPU恢复成功后不能继续展示历史安装失败');
    state.runtime={status:'stopped'};state.installed=false;state.task=null;
    await wait('重装入口',visible('[data-vision-action="install"]'));await click('[data-vision-action="install"]');await wait('可取消',visible('[data-vision-action="cancel"]'));await click('[data-vision-action="cancel"]');await wait('取消',visible('[data-vision-action="install"]'));assert.ok(calls.includes('cancel'));
    await click('[data-vision-action="install"]');await wait('重试安装',visible('[data-vision-action="cancel"]'));
    state.installed=true;state.task.status='completed';state.runtime={status:'stopped'};
    await wait('下载后单独启动入口',visible('[data-vision-action="start"]'));
    await click('[data-vision-action="start"]');await wait('显式启动已提交',`document.querySelector('[data-vision-status]').textContent==='正在启动'`);state.runtime={status:'running'};
    await wait('显式启动后填入',`document.querySelector('[data-vision-feedback]').textContent.includes('已填入')`);
    assert.equal(await field('media.localVisionModel'),'workbench-qwen-vision');
    await input('media.localVisionModel','typed-during-connection');
    await js('visionUI.delayConnection=true;visionUI.releaseConnection=null;void 0');state.installed=true;state.runtime={status:'running'};
    await wait('连接入口恢复',visible('[data-vision-action="connection"]'));await click('[data-vision-action="connection"]');await wait('关闭前延迟',`!!visionUI.releaseConnection`);
    await click('[data-life-tab="profile"]');await js('visionUI.releaseConnection();void 0');await pause(100);
    await click('[data-life-tab="media"]');await wait('返回媒体',visible('[data-vision-action="connection"]'));assert.equal(await field('media.localVisionModel'),'typed-during-connection');
    await click('[data-life-close]');const count=await js('visionUI.calls.length');await pause(2200);assert.equal(await js('visionUI.calls.length'),count,'关闭后不继续轮询');
    assert.deepEqual(errors,[]);console.log('VISION_EXTENSION_UI_RESULT '+JSON.stringify({ok:true,calls}));
  }finally{window.destroy();await backend.close();}
}

if(process.argv.includes('--vision-extension-ui-electron'))run().then(()=>createRequire(import.meta.url)('electron').app.exit(0),error=>{console.error(error.stack);createRequire(import.meta.url)('electron').app.exit(1);});
else test('千问扩展包界面：安装、启动、填入、保存、恢复、草稿竞态及桌面布局',{skip:!electron,timeout:90000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vision-extension-ui-'));const env={...process.env,AI_FUTURE_VISION_UI_DIR:directory};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url),'--vision-extension-ui-electron'],{cwd:root,env,windowsHide:true});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(done=>child.once('exit',done));}assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});assert.equal(code,0,output);assert.match(output,/VISION_EXTENSION_UI_RESULT/);
});
